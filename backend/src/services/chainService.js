const fs = require('fs');
const path = require('path');
const { ethers } = require('ethers');
const pool = require('../db/pool');
const env = require('../config/env');
const hashService = require('./hashService');

/**
 * Bridge between the evidence pipeline and EvidenceRegistry.sol.
 *
 * Anchoring is deliberately ASYNCHRONOUS. A testnet transaction takes ~15s to
 * confirm; blocking an upload on that would make the demo feel broken. The DB
 * row is the source of truth for the UI and carries PENDING -> ANCHORED/FAILED.
 *
 * The whole module is optional at runtime: if no deployment exists, or the RPC
 * is unreachable, uploads still work and rows stay PENDING. The chain being
 * down must never take the platform down (docs/PROJECT.md §F rule 4).
 */

const DEPLOY_DIR = path.resolve(__dirname, '..', '..', '..', 'blockchain', 'deployments');

let state = {
  ready: false,
  reason: 'not initialised',
  network: null,
  chainId: null,
  address: null,
  signerAddress: null,
  contract: null,
  provider: null,
};

function loadDeployment(network) {
  const file = path.join(DEPLOY_DIR, `${network}.json`);
  if (!fs.existsSync(file)) return null;
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function loadAbi() {
  const file = path.join(DEPLOY_DIR, 'EvidenceRegistry.abi.json');
  if (!fs.existsSync(file)) return null;
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

/** Idempotent. Safe to call repeatedly; never throws. */
async function init() {
  const network = env.chainNetwork;
  try {
    const deployment = loadDeployment(network);
    const abi = loadAbi();

    if (!deployment || !abi) {
      state = { ...state, ready: false, network,
        reason: `no deployment for "${network}" — run npm --prefix blockchain run deploy:local` };
      return state;
    }

    // The unlocked-account fallback below only makes sense against a local
    // Hardhat node, which exposes signer 0 with no key needed. Against any
    // other network (amoy, mainnet, ...) there is no unlocked account to get —
    // attempting it would either throw an opaque RPC error or, worse on some
    // providers, silently resolve to an address the caller does not control.
    // Refuse explicitly instead of letting that ambiguity reach demo day.
    const isLocalNetwork = network === 'localhost' || network === 'hardhat';
    if (!env.chainPrivateKey && !isLocalNetwork) {
      state = { ...state, ready: false, network,
        reason: `CHAIN_PRIVATE_KEY is required for network "${network}" — refusing the unlocked local-signer fallback against a remote RPC` };
      return state;
    }

    const provider = new ethers.JsonRpcProvider(env.chainRpcUrl);
    // Fail fast rather than hanging the first upload on a dead RPC.
    const net = await Promise.race([
      provider.getNetwork(),
      new Promise((_, rej) => setTimeout(() => rej(new Error('RPC timeout')), 4000)),
    ]);

    let signer;
    if (env.chainPrivateKey) {
      signer = new ethers.Wallet(env.chainPrivateKey, provider);
    } else {
      // Local Hardhat exposes unlocked accounts; account 0 is the deployer,
      // which already holds REGISTRAR_ROLE. isLocalNetwork guarantees this
      // branch is only reached for localhost/hardhat.
      signer = await provider.getSigner(0);
    }

    state = {
      ready: true,
      reason: 'ok',
      network,
      chainId: Number(net.chainId),
      address: deployment.address,
      signerAddress: await signer.getAddress(),
      contract: new ethers.Contract(deployment.address, abi, signer),
      provider,
    };
  } catch (err) {
    state = { ...state, ready: false, reason: err.message, network };
  }
  return state;
}

function status() {
  const { ready, reason, network, chainId, address, signerAddress } = state;
  return { ready, reason, network, chainId, contractAddress: address, relayer: signerAddress };
}

function explorerUrl(txHash) {
  if (!txHash) return null;
  if (state.network === 'amoy') return `https://amoy.polygonscan.com/tx/${txHash}`;
  return null;
}

async function markFailed(evidenceId, reason) {
  await pool.query(
    `UPDATE evidence_anchors SET status='FAILED', last_attempt_at=now() WHERE evidence_id=$1`,
    [evidenceId]
  ).catch(() => {});
  console.error(`anchor failed for evidence ${evidenceId}: ${reason}`);
}

/**
 * Anchor one exhibit. Updates evidence_anchors in place.
 * Returns { status, txHash?, blockNumber?, error? } and never throws.
 */
async function anchorEvidence(evidenceId) {
  if (!state.ready) {
    await init();
    if (!state.ready) {
      await markFailed(evidenceId, `chain unavailable: ${state.reason}`);
      return { status: 'FAILED', error: state.reason };
    }
  }

  const { rows } = await pool.query(
    `SELECT ev.id, ev.sha256_hash, ev.evidence_type, ev.complaint_id, u.code AS unit_code
       FROM evidence ev
       LEFT JOIN users usr ON usr.id = ev.uploaded_by
       LEFT JOIN units u ON u.id = usr.unit_id
      WHERE ev.id = $1`,
    [evidenceId]
  );
  const ev = rows[0];
  if (!ev) return { status: 'FAILED', error: 'evidence not found' };

  try {
    const digest = hashService.toBytes32(ev.sha256_hash);

    // Registering the same digest twice reverts on-chain. If it is already
    // there, adopt the existing record rather than treating it as an error —
    // two investigators uploading the same exhibit is normal, not a fault.
    const [exists] = await state.contract.verifyEvidence(digest);
    if (exists) {
      await pool.query(
        `UPDATE evidence_anchors
            SET status='ANCHORED', contract_address=$2, network=$3,
                on_chain_hash=$4, anchored_at=COALESCE(anchored_at, now())
          WHERE evidence_id=$1`,
        [evidenceId, state.address, state.network, ev.sha256_hash]
      );
      return { status: 'ANCHORED', alreadyOnChain: true };
    }

    const tx = await state.contract.registerEvidence(
      digest,
      ev.complaint_id || 0,
      ev.evidence_type || 'DOCUMENT',
      ev.unit_code || 'UNASSIGNED'
    );
    const receipt = await tx.wait();

    await pool.query(
      `UPDATE evidence_anchors
          SET status='ANCHORED', tx_hash=$2, block_number=$3, contract_address=$4,
              network=$5, on_chain_hash=$6, anchored_at=now()
        WHERE evidence_id=$1`,
      [evidenceId, receipt.hash, receipt.blockNumber, state.address, state.network, ev.sha256_hash]
    );

    return { status: 'ANCHORED', txHash: receipt.hash, blockNumber: receipt.blockNumber };
  } catch (err) {
    await markFailed(evidenceId, err.shortMessage || err.message);
    return { status: 'FAILED', error: err.shortMessage || err.message };
  }
}

/** Fire-and-forget. Called from the upload path so the response is not blocked. */
function queueAnchor(evidenceId) {
  setImmediate(() => {
    anchorEvidence(evidenceId).catch((err) =>
      console.error(`queued anchor threw for ${evidenceId}:`, err.message)
    );
  });
}

/** Read the on-chain record for a digest. Used by the verify flow. */
async function verifyOnChain(sha256Hex) {
  if (!state.ready) {
    await init();
    if (!state.ready) return { available: false, reason: state.reason };
  }
  try {
    const [exists, record] = await state.contract.verifyEvidence(hashService.toBytes32(sha256Hex));
    return {
      available: true,
      exists,
      sealed: exists ? record.sealed_ : null,
      caseId: exists ? Number(record.caseId) : null,
      evidenceType: exists ? record.evidenceType : null,
      unitCode: exists ? record.unitCode : null,
      registeredAt: exists ? Number(record.registeredAt) : null,
      registrar: exists ? record.registrar : null,
    };
  } catch (err) {
    return { available: false, reason: err.shortMessage || err.message };
  }
}

/**
 * Append one custody entry. Recorded for FAILED checks too — an exhibit that
 * stopped matching is exactly the fact that must not be quietly droppable.
 */
async function logVerification(sha256Hex, matched, note) {
  if (!state.ready) {
    await init();
    if (!state.ready) return { ok: false, reason: state.reason };
  }
  try {
    const tx = await state.contract.logVerification(
      hashService.toBytes32(sha256Hex), Boolean(matched), String(note || '').slice(0, 200)
    );
    const receipt = await tx.wait();
    return { ok: true, txHash: receipt.hash, blockNumber: receipt.blockNumber };
  } catch (err) {
    return { ok: false, reason: err.shortMessage || err.message };
  }
}

/** The full chain of custody for one exhibit, oldest first. */
async function getHistory(sha256Hex) {
  if (!state.ready) {
    await init();
    if (!state.ready) return { available: false, reason: state.reason, history: [] };
  }
  try {
    const raw = await state.contract.getEvidenceHistory(hashService.toBytes32(sha256Hex));
    return {
      available: true,
      history: raw.map((v) => ({
        verifier: v.verifier,
        checked_at: new Date(Number(v.checkedAt) * 1000).toISOString(),
        matched: v.matched,
        note: v.note,
      })),
    };
  } catch (err) {
    return { available: false, reason: err.shortMessage || err.message, history: [] };
  }
}

async function totalRegistered() {
  if (!state.ready) return null;
  try { return Number(await state.contract.totalRegistered()); } catch { return null; }
}

const MAX_ANCHOR_RETRIES = 5;
const RETRY_COOLDOWN = '2 minutes';

/**
 * Requeue anchors that never made it to ANCHORED. Previously this only
 * happened if a human noticed a FAILED row and re-triggered it by hand — a
 * dead RPC during one upload meant that exhibit stayed unanchored forever.
 * Capped by retry_count and cooled down by last_attempt_at so a genuinely
 * broken chain does not turn into a tight retry loop.
 */
async function retryFailedAnchors() {
  const { rows } = await pool.query(
    `SELECT evidence_id FROM evidence_anchors
      WHERE status IN ('FAILED', 'PENDING') AND retry_count < $1
        AND (last_attempt_at IS NULL OR last_attempt_at < now() - interval '${RETRY_COOLDOWN}')`,
    [MAX_ANCHOR_RETRIES]
  );
  for (const row of rows) {
    await pool.query(
      `UPDATE evidence_anchors SET retry_count = retry_count + 1, last_attempt_at = now() WHERE evidence_id=$1`,
      [row.evidence_id]
    );
    await anchorEvidence(row.evidence_id);
  }
  return { attempted: rows.length };
}

/** Call once at startup. Returns the interval handle (already unref'd). */
function startAnchorRetrySweep(intervalMs = 5 * 60 * 1000) {
  return setInterval(() => {
    retryFailedAnchors().catch((err) => console.error('anchor retry sweep failed:', err.message));
  }, intervalMs).unref();
}

module.exports = {
  init, status, anchorEvidence, queueAnchor, verifyOnChain,
  logVerification, getHistory, totalRegistered, explorerUrl,
  retryFailedAnchors, startAnchorRetrySweep,
};

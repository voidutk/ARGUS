const pool = require('../db/pool');
const crypto = require('../services/cryptoService');
const storage = require('../services/storageService');
const hashService = require('../services/hashService');
const chain = require('../services/chainService');
const audit = require('../services/auditService');

const EVIDENCE_TYPES = ['SCREENSHOT', 'BANK_STATEMENT', 'CHAT_LOG', 'CALL_RECORD', 'DOCUMENT', 'OTHER'];

// Binds ciphertext to the specific evidence row via AES-GCM's AAD (see
// cryptoService.encrypt). Using the row's own primary key means an attacker
// with DB + disk write access cannot copy another exhibit's entire crypto
// envelope (ciphertext + iv + auth_tag + sha256_hash) onto this row's identity
// and have it decrypt and hash-match cleanly — the AAD used at encryption time
// would not match this row's id.
const aadFor = (evidenceId) => `evidence:${evidenceId}`;

const anchorView = (r) => ({
  status: r.anchor_status || 'PENDING',
  tx_hash: r.tx_hash || null,
  block_number: r.block_number ? Number(r.block_number) : null,
  network: r.network || null,
  contract_address: r.contract_address || null,
  anchored_at: r.anchored_at || null,
  explorer_url: chain.explorerUrl(r.tx_hash),
});

async function list(req, res, next) {
  try {
    const params = [];
    let where = '';
    if (req.query.complaint_id) {
      params.push(Number(req.query.complaint_id));
      where = `WHERE ev.complaint_id = $${params.length}`;
    }
    const { rows } = await pool.query(
      `SELECT ev.id, ev.title, ev.filename, ev.mime_type, ev.size_bytes, ev.evidence_type,
              ev.sha256_hash, ev.created_at, ev.complaint_id,
              c.complaint_ref, u.full_name AS uploaded_by_name,
              a.status AS anchor_status, a.tx_hash, a.block_number, a.network,
              a.contract_address, a.anchored_at,
              (SELECT count(*)::int FROM verifications v WHERE v.evidence_id = ev.id) AS verification_count
         FROM evidence ev
         LEFT JOIN evidence_anchors a ON a.evidence_id = ev.id
         LEFT JOIN complaints c ON c.id = ev.complaint_id
         LEFT JOIN users u ON u.id = ev.uploaded_by
         ${where}
        ORDER BY ev.created_at DESC LIMIT 100`,
      params
    );
    res.json({
      evidence: rows.map((r) => ({
        id: r.id, title: r.title, filename: r.filename, mime_type: r.mime_type,
        size_bytes: r.size_bytes ? Number(r.size_bytes) : null,
        evidence_type: r.evidence_type, sha256_hash: r.sha256_hash,
        complaint_id: r.complaint_id, complaint_ref: r.complaint_ref,
        uploaded_by_name: r.uploaded_by_name, created_at: r.created_at,
        verification_count: r.verification_count,
        anchor: anchorView(r),
      })),
    });
  } catch (err) { next(err); }
}

/**
 * POST /api/evidence/upload
 *
 * Returns as soon as the exhibit is hashed and stored. Anchoring is queued, so
 * a slow or dead RPC cannot stall an investigator mid-upload — the row simply
 * stays PENDING and the UI polls.
 *
 * The SHA-256 is taken over the PLAINTEXT, before encryption. Ciphertext gets a
 * fresh IV every time it is written, so a ciphertext digest would never match
 * across re-encryption and would prove nothing about the exhibit.
 *
 * The row is inserted in two steps: reserve the id first with placeholder
 * crypto columns, then encrypt bound to that id (aadFor) and fill them in.
 * The alternative — encrypting before insert — would leave the AAD with
 * nothing stable to bind to, since the id does not exist yet.
 */
async function upload(req, res, next) {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
    const { title, evidence_type = 'DOCUMENT', complaint_id } = req.body;

    if (!EVIDENCE_TYPES.includes(evidence_type)) {
      return res.status(400).json({ error: `evidence_type must be one of: ${EVIDENCE_TYPES.join(', ')}` });
    }
    if (complaint_id !== undefined && complaint_id !== '' && !Number.isFinite(Number(complaint_id))) {
      return res.status(400).json({ error: 'complaint_id must be a number' });
    }

    const plaintext = req.file.buffer;
    const sha256 = hashService.sha256(plaintext);

    const { rows: reserved } = await pool.query(
      `INSERT INTO evidence (complaint_id, title, filename, mime_type, size_bytes, evidence_type,
                             sha256_hash, encrypted_path, iv, auth_tag, uploaded_by)
       VALUES ($1,$2,$3,$4,$5,$6,'', '', '', '', $7) RETURNING id`,
      [complaint_id ? Number(complaint_id) : null, title || req.file.originalname,
       req.file.originalname, req.file.mimetype, plaintext.length, evidence_type, req.user.id]
    );
    const id = reserved[0].id;

    const { ciphertext, iv, authTag, keyVersion } = crypto.encrypt(plaintext, aadFor(id));
    const storedName = await storage.write(ciphertext);

    const { rows } = await pool.query(
      `UPDATE evidence SET sha256_hash=$2, encrypted_path=$3, iv=$4, auth_tag=$5, key_version=$6
        WHERE id=$1 RETURNING *`,
      [id, sha256, storedName, iv, authTag, keyVersion]
    );
    const ev = rows[0];

    await pool.query(
      `INSERT INTO evidence_anchors (evidence_id, network, status) VALUES ($1,$2,'PENDING')`,
      [ev.id, chain.status().network || 'localhost']
    );

    await audit.log({
      actorId: req.user.id, action: 'EVIDENCE_UPLOADED', entityType: 'evidence', entityId: ev.id,
      metadata: { title: ev.title, sha256, size: plaintext.length },
      ipAddress: audit.clientIp(req),
    });

    chain.queueAnchor(ev.id);

    res.status(201).json({
      evidence: {
        id: ev.id, title: ev.title, filename: ev.filename, mime_type: ev.mime_type,
        size_bytes: Number(ev.size_bytes), evidence_type: ev.evidence_type,
        sha256_hash: ev.sha256_hash, complaint_id: ev.complaint_id, created_at: ev.created_at,
        anchor: { status: 'PENDING', tx_hash: null, network: chain.status().network },
      },
    });
  } catch (err) { next(err); }
}

/**
 * POST /api/evidence/:id/verify
 *
 * Recomputes the digest from the stored bytes and compares it with what the
 * chain holds. The result is written to the custody trail either way — a
 * mismatch is the single most important thing this system can record, so it is
 * never silently discarded.
 */
async function verify(req, res, next) {
  try {
    const id = Number(req.params.id);
    const { rows } = await pool.query(`SELECT * FROM evidence WHERE id = $1`, [id]);
    const ev = rows[0];
    if (!ev) return res.status(404).json({ error: 'Evidence not found' });

    let computedHash = null;
    let readError = null;
    try {
      const ciphertext = await storage.read(ev.encrypted_path);
      const plaintext = crypto.decrypt(ciphertext, ev.iv, ev.auth_tag, aadFor(ev.id), ev.key_version);
      computedHash = hashService.sha256(plaintext);
    } catch (e) {
      // AES-GCM refusing to decrypt IS a tamper signal, not an incidental error
      // — including a wrong-AAD failure, which now also means "this row's
      // crypto envelope did not originate from this row".
      readError = e.message;
    }

    const onChain = await chain.verifyOnChain(ev.sha256_hash);
    const isValid = Boolean(computedHash && computedHash === ev.sha256_hash && onChain.exists);

    const note = !computedHash ? `stored bytes unreadable: ${readError}`
      : computedHash !== ev.sha256_hash ? 'digest mismatch — exhibit altered at rest'
      : !onChain.available ? 'digest matches; chain unavailable'
      : !onChain.exists ? 'digest matches but is not registered on-chain'
      : 'integrity confirmed';

    // The relayer wallet submits every anchoring/logging transaction, so
    // on-chain msg.sender is always the same address regardless of which
    // investigator actually ran the check — the chain alone cannot tell them
    // apart. Folding the investigator's identity into the note is what keeps
    // per-officer accountability inside the immutable custody trail itself.
    const custodyNote = `${note} — verified by ${req.user.email || `user#${req.user.id}`}`;
    const logged = onChain.available && onChain.exists
      ? await chain.logVerification(ev.sha256_hash, isValid, custodyNote)
      : { ok: false, reason: onChain.reason || 'not registered on-chain' };

    await pool.query(
      `INSERT INTO verifications (evidence_id, verified_by, computed_hash, chain_hash, is_valid, tx_hash)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [id, req.user.id, computedHash, onChain.exists ? ev.sha256_hash : null, isValid, logged.txHash || null]
    );

    await audit.log({
      actorId: req.user.id, action: isValid ? 'EVIDENCE_VERIFIED' : 'EVIDENCE_VERIFY_FAILED',
      entityType: 'evidence', entityId: id, metadata: { note, computedHash },
      ipAddress: audit.clientIp(req),
    });

    const history = await chain.getHistory(ev.sha256_hash);

    res.json({
      is_valid: isValid,
      note,
      computed_hash: computedHash,
      stored_hash: ev.sha256_hash,
      chain: onChain,
      custody_tx: logged.ok ? { tx_hash: logged.txHash, explorer_url: chain.explorerUrl(logged.txHash) } : null,
      custody_write_failed: logged.ok ? null : logged.reason,
      history: history.history,
    });
  } catch (err) { next(err); }
}

async function history(req, res, next) {
  try {
    const id = Number(req.params.id);
    const { rows } = await pool.query(`SELECT sha256_hash FROM evidence WHERE id = $1`, [id]);
    if (!rows[0]) return res.status(404).json({ error: 'Evidence not found' });

    const [onChain, local] = await Promise.all([
      chain.getHistory(rows[0].sha256_hash),
      pool.query(
        `SELECT v.id, v.computed_hash, v.chain_hash, v.is_valid, v.tx_hash, v.verified_at,
                u.full_name AS verified_by_name
           FROM verifications v LEFT JOIN users u ON u.id = v.verified_by
          WHERE v.evidence_id = $1 ORDER BY v.verified_at ASC`,
        [id]
      ),
    ]);

    res.json({
      on_chain: onChain.history,
      on_chain_available: onChain.available,
      on_chain_reason: onChain.reason || null,
      local: local.rows,
    });
  } catch (err) { next(err); }
}

async function download(req, res, next) {
  try {
    const id = Number(req.params.id);
    const { rows } = await pool.query(`SELECT * FROM evidence WHERE id = $1`, [id]);
    const ev = rows[0];
    if (!ev) return res.status(404).json({ error: 'Evidence not found' });

    const ciphertext = await storage.read(ev.encrypted_path);
    const plaintext = crypto.decrypt(ciphertext, ev.iv, ev.auth_tag, aadFor(ev.id), ev.key_version);

    await audit.log({
      actorId: req.user.id, action: 'EVIDENCE_DOWNLOADED', entityType: 'evidence', entityId: id,
      metadata: { title: ev.title }, ipAddress: audit.clientIp(req),
    });

    res.setHeader('Content-Type', ev.mime_type || 'application/octet-stream');
    res.setHeader('Content-Disposition', `attachment; filename="${ev.filename}"`);
    res.send(plaintext);
  } catch (err) { next(err); }
}

async function chainStatus(req, res, next) {
  try {
    const s = chain.status();
    res.json({ ...s, total_anchored: await chain.totalRegistered() });
  } catch (err) { next(err); }
}

async function chainTransactions(req, res, next) {
  try {
    const { rows } = await pool.query(
      `SELECT a.tx_hash, a.block_number, a.network, a.status, a.anchored_at,
              a.contract_address, ev.id AS evidence_id, ev.title, ev.sha256_hash
         FROM evidence_anchors a JOIN evidence ev ON ev.id = a.evidence_id
        WHERE a.tx_hash IS NOT NULL
        ORDER BY a.anchored_at DESC NULLS LAST LIMIT 60`
    );
    res.json({
      transactions: rows.map((r) => ({
        ...r,
        block_number: r.block_number ? Number(r.block_number) : null,
        explorer_url: chain.explorerUrl(r.tx_hash),
      })),
    });
  } catch (err) { next(err); }
}

/**
 * POST /api/evidence/integrity-sweep (ADMIN)
 *
 * Reactive verification only runs when someone asks about one exhibit.
 * Disk-level tampering on an exhibit nobody happens to be re-checking would
 * otherwise sit undetected indefinitely. This walks every exhibit, attempts
 * decrypt + digest recompute, and reports anomalies — without writing to the
 * chain, since a sweep is a detection pass, not a formal custody check
 * (that stays investigator-initiated via /verify).
 */
async function integritySweep(req, res, next) {
  try {
    const { rows } = await pool.query(
      `SELECT id, title, sha256_hash, encrypted_path, iv, auth_tag, key_version FROM evidence`
    );
    const results = [];
    for (const ev of rows) {
      try {
        const ciphertext = await storage.read(ev.encrypted_path);
        const plaintext = crypto.decrypt(ciphertext, ev.iv, ev.auth_tag, aadFor(ev.id), ev.key_version);
        const computed = hashService.sha256(plaintext);
        if (computed !== ev.sha256_hash) {
          results.push({ id: ev.id, title: ev.title, ok: false, reason: 'digest mismatch — exhibit altered at rest' });
        }
      } catch (e) {
        results.push({ id: ev.id, title: ev.title, ok: false, reason: e.message });
      }
    }

    await audit.log({
      actorId: req.user.id, action: 'EVIDENCE_INTEGRITY_SWEEP', entityType: 'evidence',
      metadata: { scanned: rows.length, anomalies: results.length },
      ipAddress: audit.clientIp(req),
    });

    res.json({ scanned: rows.length, anomalies: results });
  } catch (err) { next(err); }
}

/** POST /api/chain/retry-failed (ADMIN) — manual trigger alongside the automatic sweep. */
async function retryFailedAnchors(req, res, next) {
  try {
    const result = await chain.retryFailedAnchors();
    await audit.log({
      actorId: req.user.id, action: 'CHAIN_RETRY_TRIGGERED', entityType: 'evidence_anchors',
      metadata: result, ipAddress: audit.clientIp(req),
    });
    res.json(result);
  } catch (err) { next(err); }
}

module.exports = {
  list, upload, verify, history, download, chainStatus, chainTransactions,
  integritySweep, retryFailedAnchors,
};

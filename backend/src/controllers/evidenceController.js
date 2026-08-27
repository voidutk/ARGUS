const pool = require('../db/pool');
const cryptoService = require('../services/cryptoService');
const storage = require('../services/storageService');
const hashService = require('../services/hashService');
const chain = require('../services/chainService');
const audit = require('../services/auditService');
const logger = require('../lib/logger');
const { asyncHandler, notFound, badRequest } = require('../lib/errors');

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

const list = asyncHandler(async (req, res) => {
  const { complaint_id, limit, offset } = req.valid.query;

  const params = [];
  let where = '';
  if (complaint_id) {
    params.push(complaint_id);
    where = `WHERE ev.complaint_id = $${params.length}`;
  }

  params.push(limit, offset);
  const { rows } = await pool.query(
    `SELECT ev.id, ev.title, ev.filename, ev.mime_type, ev.size_bytes, ev.evidence_type,
            ev.sha256_hash, ev.created_at, ev.complaint_id,
            c.complaint_ref, u.full_name AS uploaded_by_name,
            a.status AS anchor_status, a.tx_hash, a.block_number, a.network,
            a.contract_address, a.anchored_at,
            (SELECT count(*)::int FROM verifications v WHERE v.evidence_id = ev.id) AS verification_count,
            count(*) OVER ()::int AS total_count
       FROM evidence ev
       LEFT JOIN evidence_anchors a ON a.evidence_id = ev.id
       LEFT JOIN complaints c ON c.id = ev.complaint_id
       LEFT JOIN users u ON u.id = ev.uploaded_by
       ${where}
      ORDER BY ev.created_at DESC, ev.id DESC
      LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params
  );

  const total = rows[0]?.total_count ?? 0;
  res.json({
    evidence: rows.map((r) => ({
      id: r.id,
      title: r.title,
      filename: r.filename,
      mime_type: r.mime_type,
      size_bytes: r.size_bytes ? Number(r.size_bytes) : null,
      evidence_type: r.evidence_type,
      sha256_hash: r.sha256_hash,
      complaint_id: r.complaint_id,
      complaint_ref: r.complaint_ref,
      uploaded_by_name: r.uploaded_by_name,
      created_at: r.created_at,
      verification_count: r.verification_count,
      anchor: anchorView(r),
    })),
    total,
    limit,
    offset,
    has_more: offset + rows.length < total,
  });
});

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
 * The row is reserved (a placeholder INSERT) before encrypting, so the AAD can
 * bind ciphertext to the row's own immutable id — encrypting first would leave
 * nothing stable to bind to, since the id does not exist yet. If anything
 * fails after the reservation, the row is deleted rather than left dangling:
 * a reserved row with blank crypto fields is exactly the "row pointing at
 * nothing" case that must never survive a failed upload.
 */
const upload = asyncHandler(async (req, res) => {
  if (!req.file) throw badRequest('No file uploaded — send it as multipart field "file"');
  if (!req.file.size) throw badRequest('The uploaded file is empty');

  const { title, evidence_type, complaint_id } = req.valid.body;

  const plaintext = req.file.buffer;
  const sha256 = hashService.sha256(plaintext);

  const { rows: reserved } = await pool.query(
    `INSERT INTO evidence (complaint_id, title, filename, mime_type, size_bytes, evidence_type,
                           sha256_hash, encrypted_path, iv, auth_tag, uploaded_by)
     VALUES ($1,$2,$3,$4,$5,$6,'', '', '', '', $7) RETURNING id`,
    [complaint_id, title || req.file.originalname, req.file.originalname, req.file.mimetype,
      plaintext.length, evidence_type, req.user.id]
  );
  const id = reserved[0].id;

  let ev;
  try {
    const { ciphertext, iv, authTag, keyVersion } = cryptoService.encrypt(plaintext, aadFor(id));

    // Written to disk before the row is finalised, so the only possible
    // inconsistency if the next step fails is an orphaned ciphertext with no
    // completed row — recoverable, and cleaned up below. The reverse (a
    // completed row pointing at a file that was never written) would be an
    // exhibit that cannot be produced, which is not recoverable.
    const storedName = await storage.write(ciphertext);

    try {
      const { rows } = await pool.query(
        `UPDATE evidence SET sha256_hash=$2, encrypted_path=$3, iv=$4, auth_tag=$5, key_version=$6
          WHERE id=$1 RETURNING *`,
        [id, sha256, storedName, iv, authTag, keyVersion]
      );
      ev = rows[0];
    } catch (err) {
      await storage.remove(storedName).catch((rmErr) =>
        logger.error({ err: rmErr.message, file: storedName }, 'orphaned ciphertext could not be removed'));
      throw err;
    }
  } catch (err) {
    await pool.query('DELETE FROM evidence WHERE id=$1', [id]).catch((delErr) =>
      logger.error({ err: delErr.message, id }, 'failed to clean up a reserved evidence row'));
    throw err;
  }

  await pool.query(
    `INSERT INTO evidence_anchors (evidence_id, network, status) VALUES ($1,$2,'PENDING')`,
    [ev.id, chain.status().network || 'localhost']
  );

  await audit.log({
    actorId: req.user.id,
    action: 'EVIDENCE_UPLOADED',
    entityType: 'evidence',
    entityId: ev.id,
    metadata: { title: ev.title, sha256, size: plaintext.length },
    ipAddress: audit.clientIp(req),
  });

  chain.queueAnchor(ev.id);

  res.status(201).json({
    evidence: {
      id: ev.id,
      title: ev.title,
      filename: ev.filename,
      mime_type: ev.mime_type,
      size_bytes: Number(ev.size_bytes),
      evidence_type: ev.evidence_type,
      sha256_hash: ev.sha256_hash,
      complaint_id: ev.complaint_id,
      created_at: ev.created_at,
      anchor: { status: 'PENDING', tx_hash: null, network: chain.status().network },
    },
  });
});

/**
 * POST /api/evidence/:id/verify
 *
 * Recomputes the digest from the stored bytes and compares it with what the
 * chain holds. The result is written to the custody trail either way — a
 * mismatch is the single most important thing this system can record, so it is
 * never silently discarded.
 */
const verify = asyncHandler(async (req, res) => {
  const { id } = req.valid.params;

  const { rows } = await pool.query(`SELECT * FROM evidence WHERE id = $1`, [id]);
  const ev = rows[0];
  if (!ev) throw notFound('Evidence');

  let computedHash = null;
  let readError = null;
  try {
    const ciphertext = await storage.read(ev.encrypted_path);
    const plaintext = cryptoService.decrypt(ciphertext, ev.iv, ev.auth_tag, aadFor(ev.id), ev.key_version);
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
    actorId: req.user.id,
    action: isValid ? 'EVIDENCE_VERIFIED' : 'EVIDENCE_VERIFY_FAILED',
    entityType: 'evidence',
    entityId: id,
    metadata: { note, computedHash },
    ipAddress: audit.clientIp(req),
  });

  const history = await chain.getHistory(ev.sha256_hash);

  res.json({
    is_valid: isValid,
    note,
    computed_hash: computedHash,
    stored_hash: ev.sha256_hash,
    chain: onChain,
    custody_tx: logged.ok
      ? { tx_hash: logged.txHash, explorer_url: chain.explorerUrl(logged.txHash) }
      : null,
    custody_write_failed: logged.ok ? null : logged.reason,
    history: history.history,
  });
});

const history = asyncHandler(async (req, res) => {
  const { id } = req.valid.params;

  const { rows } = await pool.query(`SELECT sha256_hash FROM evidence WHERE id = $1`, [id]);
  if (!rows[0]) throw notFound('Evidence');

  const [onChain, local] = await Promise.all([
    chain.getHistory(rows[0].sha256_hash),
    pool.query(
      `SELECT v.id, v.computed_hash, v.chain_hash, v.is_valid, v.tx_hash, v.verified_at,
              u.full_name AS verified_by_name
         FROM verifications v LEFT JOIN users u ON u.id = v.verified_by
        WHERE v.evidence_id = $1 ORDER BY v.verified_at ASC, v.id ASC`,
      [id]
    ),
  ]);

  res.json({
    on_chain: onChain.history,
    on_chain_available: onChain.available,
    on_chain_reason: onChain.reason || null,
    local: local.rows,
  });
});

/**
 * Quotes a filename for Content-Disposition.
 *
 * The filename is attacker-controlled — it is whatever the uploader named the
 * file — and it was previously interpolated into the header raw. A name
 * containing a double quote or a CR/LF would break out of the header value and
 * inject a header of the uploader's choosing. RFC 6266 is followed: ASCII in a
 * quoted string with quotes and backslashes escaped, plus a `filename*` in
 * UTF-8 so a Devanagari filename survives the round trip.
 */
function contentDisposition(filename) {
  const safe = String(filename || 'evidence').replace(/[\r\n]/g, '');
  const ascii = safe.replace(/[^\x20-\x7E]/g, '_').replace(/(["\\])/g, '\\$1');
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(safe)}`;
}

const download = asyncHandler(async (req, res) => {
  const { id } = req.valid.params;

  const { rows } = await pool.query(`SELECT * FROM evidence WHERE id = $1`, [id]);
  const ev = rows[0];
  if (!ev) throw notFound('Evidence');

  const ciphertext = await storage.read(ev.encrypted_path);
  const plaintext = cryptoService.decrypt(ciphertext, ev.iv, ev.auth_tag, aadFor(ev.id), ev.key_version);

  await audit.log({
    actorId: req.user.id,
    action: 'EVIDENCE_DOWNLOADED',
    entityType: 'evidence',
    entityId: id,
    metadata: { title: ev.title },
    ipAddress: audit.clientIp(req),
  });

  // Always octet-stream, never the uploader's declared type. Echoing a stored
  // MIME type back means an uploaded .html or .svg exhibit would RENDER in the
  // investigator's browser, on the API's origin, with their session — stored
  // XSS delivered through the evidence locker. Exhibits are downloaded and
  // examined, never previewed inline, so nothing is lost by refusing to guess.
  res.setHeader('Content-Type', 'application/octet-stream');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Disposition', contentDisposition(ev.filename));
  res.setHeader('Content-Length', plaintext.length);
  // The digest travels with the file so a recipient can verify it independently.
  res.setHeader('X-Evidence-SHA256', ev.sha256_hash);
  res.send(plaintext);
});

const chainStatus = asyncHandler(async (req, res) => {
  const s = chain.status();
  res.json({ ...s, total_anchored: await chain.totalRegistered() });
});

const chainTransactions = asyncHandler(async (req, res) => {
  const { rows } = await pool.query(
    `SELECT a.tx_hash, a.block_number, a.network, a.status, a.anchored_at,
            a.contract_address, ev.id AS evidence_id, ev.title, ev.sha256_hash
       FROM evidence_anchors a JOIN evidence ev ON ev.id = a.evidence_id
      WHERE a.tx_hash IS NOT NULL
      ORDER BY a.anchored_at DESC NULLS LAST, a.id DESC LIMIT 60`
  );
  res.json({
    transactions: rows.map((r) => ({
      ...r,
      block_number: r.block_number ? Number(r.block_number) : null,
      explorer_url: chain.explorerUrl(r.tx_hash),
    })),
  });
});

/**
 * POST /api/evidence/:id/anchor — ADMIN/SUPERVISOR.
 *
 * Retries an anchor that failed or is stuck PENDING because the chain was down
 * when it was uploaded. Without this, an exhibit uploaded during an RPC outage
 * stays unanchored forever and the custody claim quietly does not apply to it.
 * Complements the automatic bulk sweep (chain.startAnchorRetrySweep) with an
 * on-demand retry for one exhibit an investigator is looking at right now.
 */
const reanchor = asyncHandler(async (req, res) => {
  const { id } = req.valid.params;

  const { rows } = await pool.query(
    `SELECT ev.id, a.status FROM evidence ev
       LEFT JOIN evidence_anchors a ON a.evidence_id = ev.id
      WHERE ev.id = $1`,
    [id]
  );
  if (!rows[0]) throw notFound('Evidence');
  if (rows[0].status === 'ANCHORED') {
    return res.status(200).json({ status: 'ANCHORED', note: 'Already anchored; nothing to do.' });
  }

  const result = await chain.anchorEvidence(id);

  await audit.log({
    actorId: req.user.id,
    action: 'EVIDENCE_REANCHORED',
    entityType: 'evidence',
    entityId: id,
    metadata: result,
    ipAddress: audit.clientIp(req),
  });

  res.status(result.status === 'ANCHORED' ? 200 : 202).json(result);
});

/**
 * POST /api/evidence/integrity-sweep — ADMIN.
 *
 * Reactive verification (verify(), above) only runs when someone asks about
 * one exhibit. Disk-level tampering on an exhibit nobody happens to be
 * re-checking would otherwise sit undetected indefinitely. This walks every
 * exhibit, attempts decrypt + digest recompute, and reports anomalies —
 * without writing to the chain, since a sweep is a detection pass, not a
 * formal custody check (that stays investigator-initiated via /verify).
 */
const integritySweep = asyncHandler(async (req, res) => {
  const { rows } = await pool.query(
    `SELECT id, title, sha256_hash, encrypted_path, iv, auth_tag, key_version FROM evidence`
  );
  const results = [];
  for (const ev of rows) {
    try {
      const ciphertext = await storage.read(ev.encrypted_path);
      const plaintext = cryptoService.decrypt(ciphertext, ev.iv, ev.auth_tag, aadFor(ev.id), ev.key_version);
      const computed = hashService.sha256(plaintext);
      if (computed !== ev.sha256_hash) {
        results.push({ id: ev.id, title: ev.title, ok: false, reason: 'digest mismatch — exhibit altered at rest' });
      }
    } catch (e) {
      results.push({ id: ev.id, title: ev.title, ok: false, reason: e.message });
    }
  }

  await audit.log({
    actorId: req.user.id,
    action: 'EVIDENCE_INTEGRITY_SWEEP',
    entityType: 'evidence',
    metadata: { scanned: rows.length, anomalies: results.length },
    ipAddress: audit.clientIp(req),
  });

  res.json({ scanned: rows.length, anomalies: results });
});

/** POST /api/chain/retry-failed — ADMIN. Manual trigger alongside the automatic sweep. */
const retryFailedAnchors = asyncHandler(async (req, res) => {
  const result = await chain.retryFailedAnchors();
  await audit.log({
    actorId: req.user.id,
    action: 'CHAIN_RETRY_TRIGGERED',
    entityType: 'evidence_anchors',
    metadata: result,
    ipAddress: audit.clientIp(req),
  });
  res.json(result);
});

module.exports = {
  list, upload, verify, history, download, chainStatus, chainTransactions, reanchor,
  integritySweep, retryFailedAnchors,
  contentDisposition,
};

const pool = require('../db/pool');
const logger = require('../lib/logger');
const env = require('../config/env');

/**
 * Append-only system record. Every meaningful action lands here — and this
 * table IS the Investigation Timeline page, so an action that is not logged is
 * an action that never happened as far as the chain of custody is concerned.
 *
 * Logging must never break the request it is recording, so a failure here is
 * reported and swallowed rather than thrown. That is a deliberate trade with
 * one exception noted below.
 */

/** Actions whose absence from the trail would be a defect worth failing over. */
const CRITICAL_ACTIONS = new Set([
  'EVIDENCE_UPLOADED', 'EVIDENCE_VERIFIED', 'EVIDENCE_VERIFY_FAILED', 'EVIDENCE_DOWNLOADED',
]);

async function log({ actorId, action, entityType, entityId, metadata, ipAddress }) {
  try {
    await pool.query(
      `INSERT INTO audit_logs (actor_id, action, entity_type, entity_id, metadata, ip_address)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [actorId || null, action, entityType || null, entityId || null,
       metadata ? JSON.stringify(metadata) : null, ipAddress || null]
    );
    return { ok: true };
  } catch (err) {
    // Loud, structured, and carrying the record that failed to write — so the
    // event survives in the log even when the table rejected it.
    logger.error(
      { err: err.message, action, entity_type: entityType, entity_id: entityId, actor_id: actorId },
      CRITICAL_ACTIONS.has(action)
        ? 'AUDIT WRITE FAILED for a chain-of-custody action'
        : 'audit write failed'
    );
    return { ok: false, error: err.message };
  }
}

/**
 * The client address, honouring X-Forwarded-For only as far as `trust proxy`
 * allows.
 *
 * Reading the raw header would be worse than useless in an audit trail: any
 * client can send `X-Forwarded-For: 10.0.0.1` and choose what the log records
 * about them. Express has already resolved this correctly against the configured
 * proxy count, so `req.ip` is the value with provenance and the header is only
 * a fallback for a request that somehow arrived without one.
 */
function clientIp(req) {
  if (req.ip) return req.ip;
  if (env.trustProxy) {
    const forwarded = req.headers?.['x-forwarded-for'];
    if (forwarded) return String(forwarded).split(',')[0].trim().slice(0, 45);
  }
  return req.socket?.remoteAddress || null;
}

module.exports = { log, clientIp, CRITICAL_ACTIONS };

const pool = require('../db/pool');

/**
 * Append-only system record. Every meaningful action lands here — and this
 * table IS the Investigation Timeline page, so an action that is not logged is
 * an action that never happened as far as the chain of custody is concerned.
 *
 * Logging must never break the request it is recording, so a failure here is
 * reported to the console and swallowed rather than thrown.
 */
async function log({ actorId, action, entityType, entityId, metadata, ipAddress }) {
  try {
    await pool.query(
      `INSERT INTO audit_logs (actor_id, action, entity_type, entity_id, metadata, ip_address)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [actorId || null, action, entityType || null, entityId || null,
       metadata ? JSON.stringify(metadata) : null, ipAddress || null]
    );
  } catch (err) {
    console.error('audit log write failed:', err.message);
  }
}

function clientIp(req) {
  const fwd = req.headers['x-forwarded-for'];
  if (fwd) return String(fwd).split(',')[0].trim();
  return req.ip || req.socket?.remoteAddress || null;
}

module.exports = { log, clientIp };

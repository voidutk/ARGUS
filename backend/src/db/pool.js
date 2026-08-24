/**
 * The Postgres connection pool.
 *
 * Three things here are not defaults and matter in production:
 *
 * 1. `pool.on('error')`. A `pg` Pool is an EventEmitter, and an idle client
 *    that loses its connection — Postgres restarting, a container being
 *    recycled, a network blip — emits 'error'. An EventEmitter with no 'error'
 *    listener THROWS, and an uncaught throw from an idle socket takes the whole
 *    API down for a fault that the next query would have recovered from
 *    transparently. This one listener is the difference between a blip and an
 *    outage.
 *
 * 2. `statement_timeout`. Without it a single pathological query holds a
 *    connection until the client gives up. With ten connections in the pool,
 *    ten of those is a dead API. Anything legitimately slower than this ceiling
 *    (bulk reference-data loads) opens its own client and raises it locally.
 *
 * 3. `withTransaction`. Hand-rolled BEGIN/COMMIT leaks a connection on any path
 *    that forgets to release, and a leaked connection is invisible until the
 *    pool is exhausted an hour later. Callers get a helper that cannot leak.
 */

const { Pool } = require('pg');
const env = require('../config/env');
const logger = require('../lib/logger');
const { describeError } = require('../lib/errors');

const pool = new Pool({
  connectionString: env.databaseUrl,
  max: env.dbPoolMax,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: env.dbConnectTimeoutMs,
  application_name: 'argus-core',
  statement_timeout: env.dbStatementTimeoutMs,
  query_timeout: env.dbStatementTimeoutMs + 1_000,
});

pool.on('error', (err) => {
  logger.error({ err: describeError(err) }, 'idle postgres client errored — the pool will replace it');
});

/**
 * Timed query wrapper. Slow statements are logged with their text so a
 * regression shows up in the terminal rather than as "the dashboard feels laggy".
 */
async function query(text, params) {
  const startedAt = process.hrtime.bigint();
  try {
    return await pool.query(text, params);
  } finally {
    const ms = Number(process.hrtime.bigint() - startedAt) / 1e6;
    if (ms > env.slowQueryMs) {
      logger.warn(
        { ms: Math.round(ms), sql: text.replace(/\s+/g, ' ').trim().slice(0, 200) },
        'slow query'
      );
    }
  }
}

/**
 * Runs `fn` inside a transaction with a guaranteed release.
 *
 * The client is passed in rather than made ambient so the compiler — and the
 * reader — can see which statements are inside the transaction. Returning a
 * value commits; throwing rolls back and rethrows.
 */
async function withTransaction(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch((rollbackErr) => {
      logger.error({ err: rollbackErr.message }, 'ROLLBACK failed — connection will be discarded');
    });
    throw err;
  } finally {
    client.release();
  }
}

/** Liveness probe used by /health/ready and the admin service board. */
async function ping() {
  const startedAt = Date.now();
  await pool.query('SELECT 1');
  return { ok: true, latency_ms: Date.now() - startedAt };
}

/**
 * The export is a facade, not the Pool itself.
 *
 * Every call site says `pool.query(...)`, and the timed wrapper above has to be
 * what they reach — assigning it onto the Pool object would make `query` call
 * itself forever. A facade keeps the familiar surface and routes it through the
 * instrumentation, while `connect()` still hands out a real client for the
 * cases that need one (transactions, cursors, per-session settings).
 */
module.exports = {
  query,
  connect: (...args) => pool.connect(...args),
  end: (...args) => pool.end(...args),
  on: (...args) => pool.on(...args),
  withTransaction,
  ping,
  get totalCount() { return pool.totalCount; },
  get idleCount() { return pool.idleCount; },
  get waitingCount() { return pool.waitingCount; },
};

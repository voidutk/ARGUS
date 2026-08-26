/**
 * Request identity and access logging.
 *
 * Every request gets an id, echoed in the `X-Request-Id` response header and
 * included in every log line and every error body. That id is the whole point:
 * when someone reports "it showed an error", the id on their screen finds the
 * stack trace in the log without guessing from timestamps.
 *
 * An inbound `X-Request-Id` is honoured so a trace survives a hop through a
 * proxy — but it is sanitised first. It reaches log files and response headers,
 * and unvalidated header values have no business in either.
 */

const crypto = require('crypto');
const logger = require('../lib/logger');

const SAFE_ID = /^[A-Za-z0-9_.:-]{8,64}$/;

function requestId(req, res, next) {
  const inbound = req.get('x-request-id');
  req.id = inbound && SAFE_ID.test(inbound) ? inbound : crypto.randomUUID();
  res.setHeader('X-Request-Id', req.id);
  req.log = logger.child({ req_id: req.id });
  next();
}

/**
 * One line per completed request, at a level chosen by the outcome: server
 * errors warn, client errors inform, successes are debug. In production that
 * means a quiet log that gets loud exactly when something is wrong.
 */
function accessLog(req, res, next) {
  const startedAt = process.hrtime.bigint();

  res.on('finish', () => {
    const ms = Number(process.hrtime.bigint() - startedAt) / 1e6;
    const fields = {
      method: req.method,
      path: req.route ? req.baseUrl + req.route.path : req.originalUrl.split('?')[0],
      status: res.statusCode,
      ms: Math.round(ms),
      user: req.user?.id,
      ip: req.ip,
    };

    const level = res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'debug';
    req.log[level](fields, 'request');

    if (logger.isDev) {
      const colour = res.statusCode >= 500 ? '\x1b[31m' : res.statusCode >= 400 ? '\x1b[33m' : '\x1b[32m';
      console.log(
        `  ${colour}${res.statusCode}\x1b[0m ${req.method.padEnd(6)} ${req.originalUrl}` +
        `  \x1b[90m${Math.round(ms)}ms\x1b[0m`
      );
    }
  });

  next();
}

module.exports = { requestId, accessLog };

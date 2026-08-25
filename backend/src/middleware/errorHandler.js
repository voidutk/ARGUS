/**
 * The single place a failure becomes a response.
 *
 * Its job is translation, and the direction matters: a client mistake must come
 * back as a 4xx that names the problem, and everything else must come back as a
 * 500 that names nothing. Postgres error messages quote column names, constraint
 * names and sometimes the offending value — useful in a log, an information leak
 * on the wire. So known conditions are mapped explicitly and the default is
 * deliberately uninformative.
 *
 * Every response carries the request id, which is how an operator ties the
 * generic message a user saw to the full stack trace in the log.
 */

const multer = require('multer');
const { ApiError, describeError } = require('../lib/errors');
const env = require('../config/env');
const logger = require('../lib/logger');

/**
 * Postgres SQLSTATEs worth translating. Anything not listed is a bug in our SQL
 * rather than a bad request, and correctly becomes a 500.
 */
function fromPostgres(err) {
  switch (err.code) {
    case '23505': // unique_violation
      return new ApiError(409, 'That record already exists', { code: 'DUPLICATE' });
    case '23503': // foreign_key_violation
      return new ApiError(400, 'Referenced record does not exist', { code: 'BAD_REFERENCE' });
    case '23514': // check_violation
      return new ApiError(400, 'A field holds a value this record type does not allow', { code: 'CHECK_FAILED' });
    case '23502': // not_null_violation
      return new ApiError(400, `Field "${err.column || 'unknown'}" is required`, { code: 'MISSING_FIELD' });
    case '22P02': // invalid_text_representation — e.g. NaN reaching an integer column
      return new ApiError(400, 'A parameter has the wrong type', { code: 'BAD_TYPE' });
    case '22001': // string_data_right_truncation
      return new ApiError(400, 'A field is longer than this record allows', { code: 'TOO_LONG' });
    case '57014': // query_canceled — our statement_timeout fired
      return new ApiError(503, 'That query took too long and was cancelled', { code: 'QUERY_TIMEOUT' });
    case '53300': // too_many_connections
    case '08006': // connection_failure
    case '08003':
    case 'ECONNREFUSED':
      return new ApiError(503, 'The database is unavailable', { code: 'DB_UNAVAILABLE' });
    default:
      return null;
  }
}

function fromMulter(err) {
  if (err.code === 'LIMIT_FILE_SIZE') {
    return new ApiError(413, `File exceeds the ${env.maxUploadMb} MB limit`, { code: 'FILE_TOO_LARGE' });
  }
  if (err.code === 'LIMIT_UNEXPECTED_FILE') {
    return new ApiError(400, `Unexpected file field "${err.field}" — the upload field is "file"`, { code: 'BAD_FIELD' });
  }
  return new ApiError(400, `Upload rejected: ${err.message}`, { code: 'UPLOAD_REJECTED' });
}

function translate(err) {
  if (err instanceof ApiError) return err;
  if (err instanceof multer.MulterError) return fromMulter(err);

  // express.json() on malformed input. Without this the client gets a 500 for
  // sending a trailing comma.
  if (err.type === 'entity.parse.failed') {
    return new ApiError(400, 'Request body is not valid JSON', { code: 'BAD_JSON' });
  }
  if (err.type === 'entity.too.large') {
    return new ApiError(413, 'Request body is too large', { code: 'BODY_TOO_LARGE' });
  }
  if (err.name === 'JsonWebTokenError' || err.name === 'TokenExpiredError') {
    return new ApiError(401, 'Invalid or expired token', { code: 'BAD_TOKEN' });
  }
  if (err.code) {
    const pg = fromPostgres(err);
    if (pg) { pg.cause = err; return pg; }
  }
  return null;
}

// eslint-disable-next-line no-unused-vars -- Express identifies error middleware by arity
function errorHandler(err, req, res, next) {
  const api = translate(err);
  const status = api?.status ?? 500;

  const log = req.log || logger;
  if (status >= 500) {
    log.error({ err: { message: describeError(err), stack: err.stack, code: err.code }, status }, 'request failed');
  } else {
    log.warn({ err: describeError(err), status, code: api?.code }, 'request rejected');
  }

  // Headers already sent means a response was streaming (an evidence download)
  // when it failed. There is no way to turn that into an error body; destroy the
  // socket so the client sees a truncated transfer rather than a corrupt file.
  if (res.headersSent) return req.socket?.destroy();

  const body = {
    // The contract in docs/API.md is `{ error: string }`. Everything else here
    // is additive, so existing clients keep working unchanged.
    error: api?.expose ? api.message : 'Internal server error',
    code: api?.code || 'INTERNAL_ERROR',
    request_id: req.id,
  };
  if (api?.details) body.details = api.details;

  // Stack traces go to developers only. In production the log has them.
  if (!env.isProduction && status >= 500) body.stack = err.stack;

  res.status(status).json(body);
}

module.exports = errorHandler;
module.exports.translate = translate;

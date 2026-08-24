/**
 * One error type for everything the API answers with deliberately.
 *
 * The rule: a handler either returns a response or throws an `ApiError`. It
 * never calls `res.status(...).json(...)` for a failure and it never lets a raw
 * driver error escape — `errorHandler` translates anything it does not
 * recognise into a 500 with no detail, which is the correct behaviour but a
 * terrible experience if it happens for a bad `?limit=` value.
 *
 * `expose` marks a message as safe to send to a client. Anything not marked is
 * logged in full and replaced with a generic string on the wire, so a Postgres
 * message naming a column can never leak through a validation slip.
 */
class ApiError extends Error {
  constructor(status, message, { code, details, cause } = {}) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    // 4xx messages describe the caller's mistake and are always safe to send.
    // 503 is the one 5xx that is too: it reports an operational state we chose
    // to report ("the database is unavailable"), not an internal detail that
    // leaked. Telling a client to retry beats telling them nothing.
    this.expose = status < 500 || status === 503;
    this.code = code || defaultCode(status);
    if (details) this.details = details;
    if (cause) this.cause = cause;
    Error.captureStackTrace?.(this, ApiError);
  }
}

function defaultCode(status) {
  return {
    400: 'BAD_REQUEST',
    401: 'UNAUTHENTICATED',
    403: 'FORBIDDEN',
    404: 'NOT_FOUND',
    409: 'CONFLICT',
    413: 'PAYLOAD_TOO_LARGE',
    415: 'UNSUPPORTED_MEDIA_TYPE',
    422: 'UNPROCESSABLE',
    429: 'RATE_LIMITED',
    503: 'SERVICE_UNAVAILABLE',
  }[status] || 'INTERNAL_ERROR';
}

const badRequest = (msg, details) => new ApiError(400, msg, { details });
const unauthorized = (msg = 'Not authenticated') => new ApiError(401, msg);
const forbidden = (msg = 'Insufficient role for this action') => new ApiError(403, msg);
const notFound = (what = 'Resource') => new ApiError(404, `${what} not found`);
const conflict = (msg, details) => new ApiError(409, msg, { details });
const unavailable = (msg) => new ApiError(503, msg);

/**
 * Wraps an async handler so a rejected promise reaches Express's error path.
 *
 * Express 4 does not await handlers: an async function that throws produces an
 * unhandled rejection and a request that hangs until the client gives up. Every
 * async route in this codebase goes through here — that is what lets the
 * handlers below drop their `try/catch(err){next(err)}` boilerplate entirely.
 */
const asyncHandler = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

module.exports = {
  ApiError, asyncHandler,
  badRequest, unauthorized, forbidden, notFound, conflict, unavailable,
};

/**
 * A usable message from any thrown value.
 *
 * `AggregateError` — what `pg` raises when every address for a host refuses the
 * connection — carries an EMPTY `.message` and puts the real cause in
 * `.errors[]`. Logging `err.message` for one of those records nothing at all,
 * which is exactly the case where an operator most needs the reason. This
 * unwraps it.
 */
function describeError(err) {
  if (!err) return 'unknown error';
  if (typeof err === 'string') return err;
  if (err.message) return err.message;
  if (Array.isArray(err.errors) && err.errors.length) {
    return err.errors.map((e) => e?.message || e?.code || String(e)).join('; ');
  }
  return err.code || err.name || String(err);
}

module.exports.describeError = describeError;

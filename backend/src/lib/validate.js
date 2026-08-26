/**
 * Request validation.
 *
 * Every parameter that reaches SQL is parsed and coerced here first. The reason
 * is narrower than "good practice": `Number(req.params.id)` on the string "abc"
 * is `NaN`, `NaN` reaches Postgres as an invalid integer literal, and the client
 * gets a 500 for what is plainly a client mistake. Worse, an out-of-range
 * `scam_category` trips a CHECK constraint and surfaces the constraint name to
 * whoever sent it. Validation at the edge turns both into a 400 that says which
 * field was wrong.
 *
 * Coercion is on for query and path params because HTTP has no types — `?limit=50`
 * is the string "50" and every handler downstream wants the number. Bodies are
 * NOT coerced loosely: `amount_inr: "5000"` is accepted (forms send strings) but
 * `amount_inr: "five thousand"` is rejected rather than silently becoming NaN.
 */

const { z } = require('zod');
const { badRequest } = require('./errors');

/** Flatten zod issues into one readable sentence plus a machine-readable list. */
function describe(error) {
  const issues = error.issues.map((i) => ({
    field: i.path.join('.') || '(root)',
    message: i.message,
  }));
  const summary = issues.map((i) => `${i.field}: ${i.message}`).join('; ');
  return { summary, issues };
}

/**
 * Drops query parameters that arrived empty.
 *
 * `?state=&category=UPI_FRAUD` is what a form serialises when one filter is
 * unset, and it is what every frontend sends. In HTTP that empty value means
 * "not provided" — but to a schema it is the string `''`, which coerces to 0 or
 * NaN and gets rejected. Without this, clearing a dropdown returns a 400 and the
 * page looks broken for doing the most ordinary thing a user can do.
 */
function dropEmpty(query) {
  const out = {};
  for (const [key, value] of Object.entries(query || {})) {
    if (value === '' || value === undefined) continue;
    if (Array.isArray(value) && value.length === 0) continue;
    out[key] = value;
  }
  return out;
}

/**
 * Builds middleware validating any of body / query / params.
 *
 * Validated output REPLACES the raw input, so a handler that reads
 * `req.query.limit` gets a number and cannot accidentally use an unvalidated
 * field: anything not in the schema is stripped. `req.query` is a getter in
 * Express 5 and read-only in some Express 4 patch versions, so results land on
 * `req.valid` as well and handlers prefer that.
 */
function validate(schemas) {
  return function validateMiddleware(req, res, next) {
    req.valid = req.valid || {};
    for (const source of ['params', 'query', 'body']) {
      const schema = schemas[source];
      if (!schema) continue;
      const input = source === 'query' ? dropEmpty(req.query) : (req[source] ?? {});
      const result = schema.safeParse(input);
      if (!result.success) {
        const { summary, issues } = describe(result.error);
        return next(badRequest(summary, issues));
      }
      req.valid[source] = result.data;
      try {
        req[source] = result.data;
      } catch {
        // Express 5 exposes req.query as a getter; req.valid.query is the
        // canonical read path and already holds the parsed value.
      }
    }
    next();
  };
}

// --- reusable primitives ---------------------------------------------------

/** A positive integer path id. Rejects "abc", "-1", "1.5" and "1e9". */
const idParam = z.coerce.number().int().positive().max(2_147_483_647);

/** `?limit=` with a per-endpoint ceiling, so one request cannot pull the table. */
const limit = (def, max) => z.coerce.number().int().min(1).max(max).default(def);
const offset = z.coerce.number().int().min(0).max(1_000_000).default(0);

/** Free-text search. Bounded because ILIKE '%<10kb>%' is a denial of service. */
const searchText = z.string().trim().min(1).max(120);

const SCAM_CATEGORIES = [
  'UPI_FRAUD', 'INVESTMENT_SCAM', 'DIGITAL_ARREST', 'JOB_FRAUD',
  'LOAN_APP', 'CRYPTO_FRAUD', 'SEXTORTION', 'PHISHING',
  'MATRIMONIAL', 'OTP_FRAUD', 'OTHER',
];
const COMPLAINT_STATUSES = ['NEW', 'TRIAGED', 'LINKED', 'UNDER_INVESTIGATION', 'CLOSED'];
const ENTITY_TYPES = [
  'PHONE', 'UPI', 'BANK_ACCOUNT', 'WALLET', 'EMAIL',
  'IP', 'DEVICE', 'LOCATION', 'PERSON', 'TELEGRAM',
];
const SEVERITIES = ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'];
const ALERT_STATUSES = ['OPEN', 'ACKNOWLEDGED', 'RESOLVED'];
const EVIDENCE_TYPES = ['SCREENSHOT', 'BANK_STATEMENT', 'CHAT_LOG', 'CALL_RECORD', 'DOCUMENT', 'OTHER'];

/**
 * Rupees. Accepts a number or a numeric string (HTML forms send strings), caps
 * at the NUMERIC(14,2) ceiling the column actually holds, and refuses negatives
 * — a complaint for minus four lakh is a bug upstream, not a data point.
 */
const rupees = z.coerce.number().finite().min(0).max(99_999_999_999.99);

module.exports = {
  z, validate, describe, dropEmpty,
  idParam, limit, offset, searchText, rupees,
  SCAM_CATEGORIES, COMPLAINT_STATUSES, ENTITY_TYPES, SEVERITIES, ALERT_STATUSES, EVIDENCE_TYPES,
};

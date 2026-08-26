/**
 * Rate limiting, in three tiers.
 *
 * The tiers exist because the endpoints differ in what abusing them costs:
 *
 *   login  — the only endpoint reachable without credentials, so it is the only
 *            one an attacker can use to guess. Tightest by an order of magnitude.
 *   write  — POST/PATCH paths do real work: extraction, encryption, chain calls.
 *   read   — cheap and cached; a generous ceiling that only stops runaway loops.
 *
 * Keying is by authenticated user where one exists and by client address
 * otherwise. IPv6 is truncated to a /64 before use: a single residential IPv6
 * allocation is a whole /64 or larger, so limiting on the full address means an
 * attacker rotates through addresses they already own and the limit does nothing.
 */

const { rateLimit } = require('express-rate-limit');
const env = require('../config/env');
const { ApiError } = require('../lib/errors');

/**
 * Collapse a client address to the unit worth limiting.
 *
 * IPv4 is used whole. IPv6 keeps the routing prefix (first four groups, a /64)
 * because everything below it belongs to one subscriber. `::ffff:` mapped
 * addresses are unwrapped first — they are IPv4 wearing an IPv6 costume, and
 * treating them as IPv6 would truncate a distinct address to nothing.
 */
function addressKey(ip) {
  if (!ip) return 'unknown';
  const plain = ip.startsWith('::ffff:') ? ip.slice(7) : ip;
  if (!plain.includes(':')) return plain;
  const groups = plain.split('%')[0].split(':');
  return groups.slice(0, 4).join(':') + '::/64';
}

const keyByUserOrAddress = (req) => (req.user ? `u:${req.user.id}` : `ip:${addressKey(req.ip)}`);

/**
 * Rate-limit rejections go through the normal error path rather than
 * express-rate-limit's own response, so a 429 has the same body shape, the same
 * request id and the same log line as every other failure.
 */
const handler = (message) => (req, res, next) =>
  next(new ApiError(429, message, { code: 'RATE_LIMITED' }));

const base = {
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  // The suites in scripts/ hammer the API on purpose; limiting them would make
  // a green run depend on how fast the machine is.
  skip: () => env.isTest,
};

const loginLimiter = rateLimit({
  ...base,
  windowMs: 15 * 60 * 1000,
  limit: env.loginRateLimit,
  keyGenerator: (req) => `login:${addressKey(req.ip)}`,
  // A correct password should not spend budget: this limits guessing, not use.
  skipSuccessfulRequests: true,
  handler: handler('Too many sign-in attempts. Try again in a few minutes.'),
});

const apiLimiter = rateLimit({
  ...base,
  windowMs: 60 * 1000,
  limit: env.apiRateLimit,
  keyGenerator: keyByUserOrAddress,
  handler: handler('Rate limit exceeded. Slow down and retry shortly.'),
});

const writeLimiter = rateLimit({
  ...base,
  windowMs: 60 * 1000,
  limit: env.writeRateLimit,
  keyGenerator: keyByUserOrAddress,
  handler: handler('Too many write requests. Slow down and retry shortly.'),
});

module.exports = { loginLimiter, apiLimiter, writeLimiter, addressKey };

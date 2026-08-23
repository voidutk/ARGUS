const rateLimit = require('express-rate-limit');
const env = require('../config/env');

/**
 * Login is the one endpoint an attacker can hammer without credentials, so it
 * gets the tight limit. Everything else is authenticated already and keyed by
 * user rather than IP.
 */
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: env.loginRateLimit,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: 'Too many sign-in attempts. Try again in a few minutes.' },
});

const apiLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 300,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  keyGenerator: (req) => (req.user ? `u:${req.user.id}` : req.ip),
  message: { error: 'Rate limit exceeded.' },
});

module.exports = { loginLimiter, apiLimiter };

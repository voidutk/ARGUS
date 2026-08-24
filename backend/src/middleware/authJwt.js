/**
 * Bearer token authentication.
 *
 * Tokens are checked for issuer and audience as well as signature. Signature
 * alone proves only that something holding this secret minted the token — if
 * the same secret is ever reused by another service, its tokens would be
 * accepted here. Pinning `iss`/`aud` makes a token minted for something else
 * useless against this API even under key reuse.
 */

const jwt = require('jsonwebtoken');
const env = require('../config/env');
const { unauthorized } = require('../lib/errors');

function authJwt(req, res, next) {
  const header = req.get('authorization') || '';
  const [scheme, token] = header.split(' ');

  if (!/^Bearer$/i.test(scheme || '') || !token) {
    return next(unauthorized('Missing or malformed Authorization header'));
  }

  try {
    req.user = jwt.verify(token, env.jwtSecret, {
      issuer: env.jwtIssuer,
      audience: env.jwtAudience,
      algorithms: ['HS256'], // never trust `alg` from the token itself
    });
    next();
  } catch (err) {
    next(unauthorized(
      err.name === 'TokenExpiredError' ? 'Session expired — sign in again' : 'Invalid or expired token'
    ));
  }
}

module.exports = authJwt;

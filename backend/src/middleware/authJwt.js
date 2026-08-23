const jwt = require('jsonwebtoken');
const env = require('../config/env');

function authJwt(req, res, next) {
  const header = req.headers.authorization || '';
  const [scheme, token] = header.split(' ');

  if (scheme !== 'Bearer' || !token) {
    return res.status(401).json({ error: 'Missing or malformed Authorization header' });
  }

  try {
    const payload = jwt.verify(token, env.jwtSecret);
    req.user = payload; // { id, email, role, unit_code }
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
}

module.exports = authJwt;

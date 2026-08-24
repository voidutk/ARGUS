const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const pool = require('../db/pool');
const env = require('../config/env');
const audit = require('../services/auditService');
const { asyncHandler, unauthorized, notFound } = require('../lib/errors');

const ROLES = ['ADMIN', 'SUPERVISOR', 'INVESTIGATOR', 'ANALYST'];

function signToken(user) {
  return jwt.sign(
    { id: user.id, email: user.email, role: user.role, unit_id: user.unit_id },
    env.jwtSecret,
    {
      expiresIn: env.jwtExpiresIn,
      issuer: env.jwtIssuer,
      audience: env.jwtAudience,
      algorithm: 'HS256',
      subject: String(user.id),
    }
  );
}

const publicUser = (u) => ({
  id: u.id,
  email: u.email,
  full_name: u.full_name,
  role: u.role,
  rank_title: u.rank_title,
  unit_id: u.unit_id,
  unit_code: u.unit_code || null,
  unit_name: u.unit_name || null,
  wallet_address: u.wallet_address || null,
});

const USER_SELECT = `
  SELECT u.id, u.email, u.password_hash, u.full_name, u.role, u.rank_title,
         u.wallet_address, u.unit_id, u.is_active,
         un.code AS unit_code, un.name AS unit_name
    FROM users u LEFT JOIN units un ON un.id = u.unit_id`;

/**
 * A bcrypt comparison against a hash that will never match.
 *
 * Without it, an unknown email returns in microseconds while a known one spends
 * ~80ms hashing — a difference an attacker can measure remotely to enumerate
 * valid accounts, which defeats the generic error message below. Burning the
 * same work on both paths removes the signal.
 */
const DUMMY_HASH = '$2b$10$N9qo8uLOickgx2ZMRZoMyeIjZAgcfl7p92ldGxad68LJZdL17lhWy';

const login = asyncHandler(async (req, res) => {
  const { email, password } = req.valid.body;

  const { rows } = await pool.query(`${USER_SELECT} WHERE u.email = $1`, [email]);
  const user = rows[0];

  const passwordOk = await bcrypt.compare(password, user?.password_hash || DUMMY_HASH);

  // Same generic error whether the email is unknown, the password is wrong, or
  // the account is disabled. Distinguishing them would let an attacker
  // enumerate valid accounts — and telling a suspended user *why* they are
  // locked out is a conversation for their supervisor, not a login form.
  if (!user || !user.is_active || !passwordOk) {
    await audit.log({
      actorId: user?.id,
      action: 'LOGIN_FAILED',
      entityType: 'user',
      metadata: { email, reason: !user ? 'unknown_email' : !user.is_active ? 'inactive' : 'bad_password' },
      ipAddress: audit.clientIp(req),
    });
    throw unauthorized('Invalid email or password');
  }

  await audit.log({
    actorId: user.id, action: 'LOGIN', entityType: 'user', entityId: user.id,
    ipAddress: audit.clientIp(req),
  });

  res.json({ token: signToken(user), user: publicUser(user) });
});

/**
 * Re-reads the user rather than echoing the token's claims.
 *
 * A token is valid for eight hours; a role change, a transfer or a suspension
 * inside that window must take effect on the next request, not on the next
 * sign-in. This is also where a deactivated account loses its session.
 */
const me = asyncHandler(async (req, res) => {
  const { rows } = await pool.query(`${USER_SELECT} WHERE u.id = $1`, [req.user.id]);
  const user = rows[0];
  if (!user) throw notFound('User');
  if (!user.is_active) throw unauthorized('This account has been deactivated');
  res.json({ user: publicUser(user) });
});

module.exports = { login, me, ROLES, signToken, publicUser };

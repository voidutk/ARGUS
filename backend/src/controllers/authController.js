const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const pool = require('../db/pool');
const env = require('../config/env');
const audit = require('../services/auditService');

const ROLES = ['ADMIN', 'SUPERVISOR', 'INVESTIGATOR', 'ANALYST'];

function signToken(user) {
  return jwt.sign(
    { id: user.id, email: user.email, role: user.role, unit_id: user.unit_id },
    env.jwtSecret,
    { expiresIn: env.jwtExpiresIn }
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

async function login(req, res, next) {
  try {
    const { email, password } = req.body;
    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password are required' });
    }
    const normalizedEmail = String(email).toLowerCase().trim();

    // Per-ACCOUNT lockout, independent of rateLimit.loginLimiter's per-IP
    // window. An attacker spreading guesses across many IPs (or behind a
    // rotating proxy) never trips the IP limiter but still hits this one,
    // because it counts failures against the target account regardless of
    // where they came from. Checked before bcrypt.compare so a locked-out
    // account also stops burning CPU on hash comparisons.
    const { rows: recentFailures } = await pool.query(
      `SELECT count(*)::int AS n FROM audit_logs
        WHERE action = 'LOGIN_FAILED' AND metadata->>'email' = $1
          AND created_at > now() - ($2 || ' minutes')::interval`,
      [normalizedEmail, String(env.loginLockoutWindowMin)]
    );
    if (recentFailures[0].n >= env.loginLockoutThreshold) {
      await audit.log({
        action: 'LOGIN_LOCKED', entityType: 'user',
        metadata: { email: normalizedEmail }, ipAddress: audit.clientIp(req),
      });
      return res.status(429).json({ error: 'Too many failed sign-in attempts for this account. Try again later.' });
    }

    const { rows } = await pool.query(
      `SELECT u.*, un.code AS unit_code, un.name AS unit_name
         FROM users u LEFT JOIN units un ON un.id = u.unit_id
        WHERE u.email = $1`,
      [normalizedEmail]
    );
    const user = rows[0];

    // Same generic error whether the email is unknown or the password is wrong.
    // Distinguishing them would let an attacker enumerate valid accounts.
    const ok = user && user.is_active && (await bcrypt.compare(password, user.password_hash));
    if (!ok) {
      await audit.log({
        actorId: user?.id, action: 'LOGIN_FAILED', entityType: 'user',
        metadata: { email: normalizedEmail }, ipAddress: audit.clientIp(req),
      });
      return res.status(401).json({ error: 'Invalid email or password' });
    }

    await audit.log({
      actorId: user.id, action: 'LOGIN', entityType: 'user', entityId: user.id,
      ipAddress: audit.clientIp(req),
    });

    res.json({ token: signToken(user), user: publicUser(user) });
  } catch (err) { next(err); }
}

async function me(req, res, next) {
  try {
    const { rows } = await pool.query(
      `SELECT u.*, un.code AS unit_code, un.name AS unit_name
         FROM users u LEFT JOIN units un ON un.id = u.unit_id
        WHERE u.id = $1`,
      [req.user.id]
    );
    if (!rows[0]) return res.status(404).json({ error: 'User not found' });
    res.json({ user: publicUser(rows[0]) });
  } catch (err) { next(err); }
}

module.exports = { login, me, ROLES };

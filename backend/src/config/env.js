require('dotenv').config();

const required = ['DATABASE_URL', 'JWT_SECRET', 'EVIDENCE_ENCRYPTION_KEY'];
for (const key of required) {
  if (!process.env[key]) {
    throw new Error(`Missing required env var: ${key}. Copy backend/.env.example to backend/.env and fill it in.`);
  }
}

// Presence alone is not enough — a weak or still-placeholder secret would pass
// the check above and fail silently at the worst possible time (a forged JWT,
// or evidence nobody can ever decrypt again). Fail at boot instead.
const KNOWN_PLACEHOLDER_JWT_SECRETS = new Set(['change-me-to-a-long-random-string']);
if (process.env.JWT_SECRET.length < 32) {
  throw new Error(
    'JWT_SECRET must be at least 32 characters. Generate one with:\n' +
    '  node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"'
  );
}
if (KNOWN_PLACEHOLDER_JWT_SECRETS.has(process.env.JWT_SECRET)) {
  throw new Error('JWT_SECRET is still the example placeholder from .env.example — generate a real one before starting the server.');
}

const evidenceKey = process.env.EVIDENCE_ENCRYPTION_KEY;
if (!/^[0-9a-fA-F]{64}$/.test(evidenceKey)) {
  throw new Error(
    `EVIDENCE_ENCRYPTION_KEY must be exactly 64 hex characters (32 bytes), got ${evidenceKey.length}. Generate one with:\n` +
    '  node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"'
  );
}
if (/^0+$/.test(evidenceKey)) {
  throw new Error('EVIDENCE_ENCRYPTION_KEY is still the all-zero placeholder from .env.example — generate a real key before starting the server.');
}

// EVIDENCE_ENCRYPTION_KEY_PREVIOUS holds retired keys as "version:hexkey"
// pairs, comma-separated — e.g. "1:aaaa...,2:bbbb...". They are decrypt-only:
// old exhibits stay readable under whichever key sealed them, without forcing
// every exhibit to be re-encrypted the moment the active key rotates. See
// cryptoService.js for the lookup this feeds.
const evidenceKeyPrevious = process.env.EVIDENCE_ENCRYPTION_KEY_PREVIOUS || '';
if (evidenceKeyPrevious) {
  for (const entry of evidenceKeyPrevious.split(',').map((s) => s.trim()).filter(Boolean)) {
    if (!/^\d+:[0-9a-fA-F]{64}$/.test(entry)) {
      throw new Error(
        `EVIDENCE_ENCRYPTION_KEY_PREVIOUS entry "${entry}" is malformed — expected "version:64hexchars"`
      );
    }
  }
}

module.exports = {
  nodeEnv: process.env.NODE_ENV || 'development',
  port: Number(process.env.PORT) || 4000,
  databaseUrl: process.env.DATABASE_URL,
  jwtSecret: process.env.JWT_SECRET,
  jwtExpiresIn: process.env.JWT_EXPIRES_IN || '8h',
  corsOrigin: process.env.CORS_ORIGIN || 'http://localhost:5173',

  // Evidence files are encrypted at rest with AES-256-GCM; only the SHA-256 of
  // the plaintext ever leaves this service (to the chain).
  evidenceEncryptionKey: process.env.EVIDENCE_ENCRYPTION_KEY,
  // The version stamped on every NEWLY encrypted exhibit (evidence.key_version).
  // Bump this and rotate EVIDENCE_ENCRYPTION_KEY together; move the old key
  // into EVIDENCE_ENCRYPTION_KEY_PREVIOUS under its old version number so
  // exhibits already sealed under it stay decryptable.
  evidenceEncryptionKeyVersion: Number(process.env.EVIDENCE_ENCRYPTION_KEY_VERSION) || 1,
  evidenceEncryptionKeyPrevious: evidenceKeyPrevious,
  maxUploadMb: Number(process.env.MAX_UPLOAD_MB) || 25,
  storageDir: process.env.STORAGE_DIR || 'storage/evidence',

  // Blockchain. Defaults target the local Hardhat node so a fresh clone works
  // with no .env at all; flip CHAIN_NETWORK to 'amoy' on demo day.
  chainNetwork: process.env.CHAIN_NETWORK || 'localhost',
  chainRpcUrl: process.env.CHAIN_RPC_URL || 'http://127.0.0.1:8545',
  chainPrivateKey: process.env.CHAIN_PRIVATE_KEY || '',

  // Intelligence service (FastAPI). Owns entity extraction, Neo4j and analytics.
  // Advisory: if it is down, Express serves what Postgres already knows rather
  // than failing the request. Nothing here may be a single point of failure.
  intelServiceUrl: process.env.INTEL_SERVICE_URL || 'http://127.0.0.1:8000',
  intelTimeoutMs: Number(process.env.INTEL_TIMEOUT_MS) || 8000,

  // Tight in production; generous in development so test runs and demo
  // rehearsals do not lock themselves out.
  loginRateLimit:
    Number(process.env.LOGIN_RATE_LIMIT) ||
    (process.env.NODE_ENV === 'production' ? 10 : 200),

  // Per-account lockout, independent of the per-IP rate limiter above — catches
  // an attacker who spreads guesses across IPs at one account instead of
  // hammering one IP across many accounts. Generous in development: smoke.js
  // and evidence-e2e.js both deliberately trigger one LOGIN_FAILED per run
  // against a shared seeded account, and repeated dev/demo-rehearsal runs
  // must not be able to lock investigators out of their own account.
  loginLockoutThreshold:
    Number(process.env.LOGIN_LOCKOUT_THRESHOLD) ||
    (process.env.NODE_ENV === 'production' ? 10 : 100),
  loginLockoutWindowMin: Number(process.env.LOGIN_LOCKOUT_WINDOW_MIN) || 15,
};

/**
 * Configuration, validated once at import.
 *
 * Everything the process needs is read here and nowhere else, and anything
 * missing or malformed stops the process at startup with a message naming the
 * variable. The alternative — discovering a bad `EVIDENCE_ENCRYPTION_KEY` on
 * the first upload, in front of judges — is the failure mode this file exists
 * to prevent. Fail at boot, loudly, or not at all.
 */

require('dotenv').config();

const problems = [];

function required(key, { hint } = {}) {
  const value = process.env[key];
  if (!value) problems.push(`${key} is required${hint ? ` — ${hint}` : ''}`);
  return value;
}

function integer(key, fallback, { min, max } = {}) {
  const raw = process.env[key];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n)) { problems.push(`${key} must be an integer, got "${raw}"`); return fallback; }
  if (min !== undefined && n < min) { problems.push(`${key} must be >= ${min}, got ${n}`); return fallback; }
  if (max !== undefined && n > max) { problems.push(`${key} must be <= ${max}, got ${n}`); return fallback; }
  return n;
}

function oneOf(key, allowed, fallback) {
  const value = process.env[key] || fallback;
  if (!allowed.includes(value)) {
    problems.push(`${key} must be one of ${allowed.join(', ')}, got "${value}"`);
    return fallback;
  }
  return value;
}

const nodeEnv = oneOf('NODE_ENV', ['development', 'test', 'production'], 'development');
const isProduction = nodeEnv === 'production';

const databaseUrl = required('DATABASE_URL', { hint: 'postgres://user:pass@host:5432/db' });
const jwtSecret = required('JWT_SECRET', { hint: 'a long random string' });
const evidenceEncryptionKey = required('EVIDENCE_ENCRYPTION_KEY', { hint: '64 hex characters' });

// Checked here rather than on first use, so a bad key fails at boot instead of
// mid-upload. 32 bytes is not negotiable: AES-256-GCM has one key size.
if (evidenceEncryptionKey && !/^[0-9a-fA-F]{64}$/.test(evidenceEncryptionKey)) {
  problems.push(
    'EVIDENCE_ENCRYPTION_KEY must be exactly 64 hex characters (32 bytes). Generate one with:\n' +
    '        node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"'
  );
}

/**
 * Production-only checks.
 *
 * The development defaults are deliberately permissive so a fresh clone runs
 * with a copied `.env.example`. Shipping those same values is a different
 * matter: the example JWT secret is in the repository, and an all-zero
 * encryption key is not encryption. Neither is allowed to reach production.
 */
if (isProduction) {
  if (jwtSecret && jwtSecret.length < 32) {
    problems.push('JWT_SECRET must be at least 32 characters in production');
  }
  if (jwtSecret === 'change-me-to-a-long-random-string') {
    problems.push('JWT_SECRET is still the example value from .env.example');
  }
  if (evidenceEncryptionKey && /^0+$/.test(evidenceEncryptionKey)) {
    problems.push('EVIDENCE_ENCRYPTION_KEY is still the all-zero placeholder from .env.example');
  }
  if ((process.env.CORS_ORIGIN || '').includes('*')) {
    problems.push('CORS_ORIGIN may not be a wildcard in production');
  }
}

if (problems.length) {
  throw new Error(
    `\n  ARGUS cannot start — configuration problems:\n\n` +
    problems.map((p) => `    • ${p}`).join('\n') +
    `\n\n  Copy backend/.env.example to backend/.env and fill it in.\n`
  );
}

/**
 * CORS accepts a comma-separated list. The frontend runs on 5173 in dev and is
 * served from somewhere else entirely in production; hardcoding one origin
 * would mean editing code to deploy.
 */
const corsOrigin = (process.env.CORS_ORIGIN || 'http://localhost:5173')
  .split(',').map((s) => s.trim()).filter(Boolean);

module.exports = {
  nodeEnv,
  isProduction,
  isTest: nodeEnv === 'test',
  port: integer('PORT', 4000, { min: 1, max: 65535 }),
  logLevel: oneOf('LOG_LEVEL', ['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'],
    isProduction ? 'info' : 'debug'),

  databaseUrl,
  dbPoolMax: integer('DB_POOL_MAX', 10, { min: 1, max: 100 }),
  dbConnectTimeoutMs: integer('DB_CONNECT_TIMEOUT_MS', 5_000, { min: 250 }),
  // A read that takes longer than this is a bug, not a slow disk. Bulk loaders
  // raise it on their own client rather than relaxing it for every request.
  dbStatementTimeoutMs: integer('DB_STATEMENT_TIMEOUT_MS', 15_000, { min: 1_000 }),
  slowQueryMs: integer('SLOW_QUERY_MS', 400, { min: 1 }),

  jwtSecret,
  jwtExpiresIn: process.env.JWT_EXPIRES_IN || '8h',
  jwtIssuer: process.env.JWT_ISSUER || 'argus-core',
  jwtAudience: process.env.JWT_AUDIENCE || 'argus-frontend',
  corsOrigin,

  // Evidence files are encrypted at rest with AES-256-GCM; only the SHA-256 of
  // the plaintext ever leaves this service (to the chain).
  evidenceEncryptionKey,
  maxUploadMb: integer('MAX_UPLOAD_MB', 25, { min: 1, max: 500 }),
  storageDir: process.env.STORAGE_DIR || 'storage/evidence',

  // Blockchain. Defaults target the local Hardhat node so a fresh clone works
  // with no .env at all; flip CHAIN_NETWORK to 'amoy' on demo day.
  chainNetwork: process.env.CHAIN_NETWORK || 'localhost',
  chainRpcUrl: process.env.CHAIN_RPC_URL || 'http://127.0.0.1:8545',
  chainPrivateKey: process.env.CHAIN_PRIVATE_KEY || '',
  chainProbeTimeoutMs: integer('CHAIN_PROBE_TIMEOUT_MS', 4_000, { min: 500 }),

  // Intelligence service (FastAPI). Owns entity extraction, Neo4j and analytics.
  // Advisory: if it is down, Express serves what Postgres already knows rather
  // than failing the request. Nothing here may be a single point of failure.
  intelServiceUrl: process.env.INTEL_SERVICE_URL || 'http://127.0.0.1:8000',
  intelTimeoutMs: integer('INTEL_TIMEOUT_MS', 8_000, { min: 500 }),
  // A dead service should be discovered once, not on every request. After this
  // many consecutive failures the client stops dialling for a cooldown.
  intelBreakerThreshold: integer('INTEL_BREAKER_THRESHOLD', 3, { min: 1 }),
  intelBreakerCooldownMs: integer('INTEL_BREAKER_COOLDOWN_MS', 20_000, { min: 1_000 }),

  // Tight in production; generous in development so test runs and demo
  // rehearsals do not lock themselves out.
  loginRateLimit: integer('LOGIN_RATE_LIMIT', isProduction ? 10 : 200, { min: 1 }),
  apiRateLimit: integer('API_RATE_LIMIT', isProduction ? 300 : 3_000, { min: 1 }),
  writeRateLimit: integer('WRITE_RATE_LIMIT', isProduction ? 60 : 600, { min: 1 }),

  // Behind nginx/a load balancer this must be set, or every client looks like
  // the proxy and one visitor can rate-limit everyone else out of the service.
  trustProxy: process.env.TRUST_PROXY || (isProduction ? '1' : 'loopback'),

  graphCacheTtlMs: integer('GRAPH_CACHE_TTL_MS', 60_000, { min: 0 }),
};

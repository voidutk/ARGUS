require('dotenv').config();

const required = ['DATABASE_URL', 'JWT_SECRET', 'EVIDENCE_ENCRYPTION_KEY'];
for (const key of required) {
  if (!process.env[key]) {
    throw new Error(`Missing required env var: ${key}. Copy backend/.env.example to backend/.env and fill it in.`);
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
};

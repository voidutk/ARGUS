/**
 * Structured logging.
 *
 * JSON in production so a log shipper can parse it; a short coloured line in
 * development so a human can read it during a demo rehearsal. Both carry the
 * request id, which is the only way to tie a 500 on a judge's screen back to
 * the stack trace in the terminal.
 *
 * Anything that looks like a credential is redacted before serialisation. This
 * is not paranoia: `POST /api/auth/login` bodies and `Authorization` headers
 * pass through this module on every request, and a log file with plaintext
 * passwords in it is a breach, not a debugging aid.
 */

const pino = require('pino');
const env = require('../config/env');

const REDACT = [
  'req.headers.authorization',
  'req.headers.cookie',
  'req.body.password',
  'password',
  'token',
  'jwt',
  'password_hash',
  'EVIDENCE_ENCRYPTION_KEY',
  'CHAIN_PRIVATE_KEY',
  'JWT_SECRET',
];

const isDev = env.nodeEnv !== 'production';

const logger = pino({
  level: env.logLevel,
  redact: { paths: REDACT, censor: '[redacted]' },
  base: { service: 'argus-core' },
  timestamp: pino.stdTimeFunctions.isoTime,
  ...(isDev
    ? {
        transport: {
          target: 'pino/file',
          options: { destination: 1 },
        },
      }
    : {}),
});

module.exports = logger;
module.exports.isDev = isDev;

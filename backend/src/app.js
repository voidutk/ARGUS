/**
 * Express application assembly.
 *
 * Middleware order is load-bearing and is the reason this file is worth reading
 * top to bottom:
 *
 *   trust proxy    before anything reads req.ip, or every client looks like the
 *                  load balancer and one visitor rate-limits everyone out.
 *   requestId      before the logger, so the very first line carries the id.
 *   helmet         before routes, so the headers are on error responses too.
 *   authJwt        before apiLimiter would be wrong for /auth/login, which has
 *                  no user yet — so the limiter keys on user OR address and the
 *                  order stays: limit first, authenticate inside the router.
 *   errorHandler   last, and it is the only thing that writes a failure body.
 */

const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const compression = require('compression');

const env = require('./config/env');
const routes = require('./routes');
const health = require('./routes/health');
const { requestId, accessLog } = require('./middleware/requestContext');
const { apiLimiter } = require('./middleware/rateLimit');
const errorHandler = require('./middleware/errorHandler');
const { notFound } = require('./lib/errors');

const app = express();

// Behind nginx or a container ingress, the client address arrives in
// X-Forwarded-For. Without this, req.ip is the proxy and rate limiting becomes
// collective punishment. The value is configured rather than `true`: trusting
// every hop lets a client forge its own address by sending the header itself.
app.set('trust proxy', env.trustProxy === 'true' ? true : env.trustProxy);
app.disable('x-powered-by');
app.set('etag', 'strong');

app.use(requestId);

/**
 * Security headers.
 *
 * CSP is off: this process serves JSON and one downloadable file stream, never
 * HTML, so there is no document for a policy to constrain — and the frontend is
 * a separate origin with its own. What does matter is `nosniff`, which stops a
 * browser from second-guessing the Content-Type on an evidence download, and
 * `no-referrer`, so an evidence URL with an id in it never leaves in a header.
 */
app.use(helmet({
  contentSecurityPolicy: false,
  crossOriginResourcePolicy: { policy: 'same-site' },
  referrerPolicy: { policy: 'no-referrer' },
  hsts: env.isProduction ? { maxAge: 15_552_000, includeSubDomains: true } : false,
}));

app.use(cors({
  origin: env.corsOrigin,
  credentials: true,
  // The frontend reads these to correlate a failure and to show rate-limit state.
  exposedHeaders: ['X-Request-Id', 'RateLimit', 'RateLimit-Policy', 'Content-Disposition'],
}));

// Graph payloads are the largest thing this API returns — a 600-node overview
// is a few hundred KB of highly repetitive JSON that gzips to a fraction.
app.use(compression());

app.use(express.json({ limit: '1mb' }));
app.use(accessLog);

// Probes live outside /api and outside the rate limiter: an orchestrator polling
// readiness every second must never be throttled, and a broken route table or a
// dead dependency must still answer.
app.use('/health', health);

app.use('/api', apiLimiter, routes);

app.use((req, res, next) => next(notFound(`Route ${req.method} ${req.path}`)));
app.use(errorHandler);

module.exports = app;

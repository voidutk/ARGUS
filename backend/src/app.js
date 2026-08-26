const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const env = require('./config/env');
const routes = require('./routes');
const { apiLimiter } = require('./middleware/rateLimit');
const errorHandler = require('./middleware/errorHandler');

const app = express();

// A pure JSON API never serves HTML, so helmet's defaults (HSTS, no-sniff,
// frame-deny, etc.) apply cleanly with no CSP tuning needed for this app.
app.use(helmet());
app.use(cors({ origin: env.corsOrigin, credentials: true }));
app.use(express.json({ limit: '2mb' }));

// Unauthenticated liveness probe — deliberately outside /api so a broken
// route table or a dead dependency still answers it.
app.get('/health', (req, res) =>
  res.json({ status: 'ok', service: 'argus-core', env: env.nodeEnv })
);

app.use('/api', apiLimiter, routes);

app.use((req, res) => res.status(404).json({ error: 'Not found' }));
app.use(errorHandler);

module.exports = app;

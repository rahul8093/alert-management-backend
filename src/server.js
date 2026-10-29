const express = require('express');
const cors = require('cors');
const config = require('./config');
const { pool, srcQuery, appQuery, S, A } = require('./db');
const { requireAuth } = require('./middleware/auth');
const { asyncH } = require('./lib/http');

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1);
app.use(cors({ origin: config.corsOrigin === '*' ? true : config.corsOrigin.split(',') }));
app.use(express.json({ limit: '100kb' }));

// One log line per request: time, method, path, status, duration
app.use((req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    console.log(`${new Date().toLocaleTimeString()}  ${req.method} ${req.originalUrl.split('?')[0]} -> ${res.statusCode} (${Date.now() - start} ms)`);
  });
  next();
});

// GET /api/health  - no login needed. Shows DB + worker status.
app.get('/api/health', asyncH(async (req, res) => {
  const [src] = await srcQuery(`SELECT MAX(log_date) AS lastReading FROM ${S('tt_raw_device')}`);
  let worker = null;
  try {
    const rows = await appQuery(`SELECT v FROM ${A('am_worker_state')} WHERE k='last_run'`);
    worker = rows[0] ? JSON.parse(rows[0].v) : null;
  } catch { worker = 'app database not migrated - run npm run migrate'; }
  res.json({ ok: true, lastReading: src.lastReading, worker });
}));

// API used by the mobile app
app.use('/api/v1', require('./v1'));

app.use('/api/auth', require('./routes/auth'));
// Everything below needs "Authorization: Bearer <accessToken>"
const secured = express.Router();
secured.use(requireAuth);
secured.use('/alerts', require('./routes/alerts'));
secured.use('/notifications', require('./routes/notifications'));
secured.use('/dashboard', require('./routes/dashboard'));
secured.use('/', require('./routes/plants'));
app.use('/api', secured);

app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  const status = err.status || (err.type === 'entity.parse.failed' ? 400 : 500);
  if (status >= 500) console.error(`[api] ${req.method} ${req.originalUrl}:`, err);
  res.status(status).json({ error: status >= 500 ? 'Server error' : err.message });
});

if (require.main === module) {
  const server = app.listen(config.port, () => {
    console.log(`API on http://localhost:${config.port}  (source DB: ${config.srcDb} read-only, app DB: ${config.appDb})`);
  });
  const shutdown = () => server.close(() => pool.end().finally(() => process.exit(0)));
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

module.exports = app;

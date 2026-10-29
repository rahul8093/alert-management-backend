// /api/v1 - the API the React Native app (alert-manager-react-native) talks to.
const express = require('express');
const config = require('../config');
const { appQuery, A } = require('../db');
const { asyncH, HttpError, intParam } = require('../lib/http');
const auth = require('../services/auth');
const catalog = require('../services/catalog');
const { requireAuth } = require('../middleware/auth');
const { userShape, alertShape } = require('./shape');

const router = express.Router();

async function authResponse(r) {
  const cat = await catalog.getCatalog();
  const plantIds = await catalog.allowedPlantIds(r.user);
  return {
    accessToken: r.accessToken,
    refreshToken: r.refreshToken,
    refreshExpiresAt: new Date(Date.now() + config.refreshTokenDays * 86400000).toISOString(),
    user: userShape(r.user, cat, plantIds),
  };
}

// ---------- public ----------

// POST /api/v1/auth/login  { email | username, password }   (email field may hold the user id)
router.post('/auth/login', asyncH(async (req, res) => {
  const username = req.body?.username ?? req.body?.email;
  res.json(await authResponse(await auth.login(username, req.body?.password)));
}));

router.post('/auth/refresh', asyncH(async (req, res) => {
  res.json(await authResponse(await auth.refresh(req.body?.refreshToken)));
}));

router.post('/auth/logout', asyncH(async (req, res) => {
  await auth.logout(req.body?.refreshToken);
  res.status(204).end();
}));

router.get('/public/contact', (req, res) => res.json(config.contact));

// ---------- signed in ----------
router.use(requireAuth);

router.get('/auth/me', asyncH(async (req, res) => {
  res.json(userShape(req.user, await catalog.getCatalog(), req.plantIds));
}));

// GET /api/v1/alerts?type=all|critical|warning|offline|sensor|resolved&q=&siteId=&limit=&offset=
router.get('/alerts', asyncH(async (req, res) => {
  const limit = intParam(req.query.limit, 30, 1, 100);
  const offset = intParam(req.query.offset, 0, 0, 10000000);
  const siteIds = req.query.siteId ? req.plantIds.filter((id) => id === Number(req.query.siteId)) : req.plantIds;
  const type = String(req.query.type || 'all');
  if (!siteIds.length || type === 'sensor') return res.json({ items: [], total: 0, limit, offset });

  const where = ['plant_id IN (?)'];
  const args = [siteIds];
  if (type === 'resolved') where.push(`status = 'closed'`);
  else if (['critical', 'warning', 'offline'].includes(type)) { where.push(`alert_type = ? AND status <> 'closed'`); args.push(type); }
  else if (type !== 'all') throw new HttpError(400, 'Unknown alert type');
  const q = String(req.query.q || '').trim();
  if (q) {
    const like = `%${q.replace(/[\\%_]/g, (m) => `\\${m}`)}%`;
    where.push('(message LIKE ? OR param_id LIKE ? OR device_id LIKE ?)');
    args.push(like, like, like);
  }
  const w = where.join(' AND ');
  const [{ total }] = await appQuery(`SELECT COUNT(*) AS total FROM ${A('am_alert')} WHERE ${w}`, args);
  const rows = await appQuery(
    `SELECT * FROM ${A('am_alert')} WHERE ${w} ORDER BY (status = 'closed'), started_at DESC, id DESC LIMIT ? OFFSET ?`,
    [...args, limit, offset]);
  const cat = await catalog.getCatalog();
  res.json({ items: rows.map((a) => alertShape(a, cat)), total, limit, offset });
}));

// GET /api/v1/alerts/summary?siteId=
router.get('/alerts/summary', asyncH(async (req, res) => {
  const out = { open: 0, critical: 0, warning: 0, offline: 0, sensor: 0 };
  const siteIds = req.query.siteId ? req.plantIds.filter((id) => id === Number(req.query.siteId)) : req.plantIds;
  if (!siteIds.length) return res.json(out);
  const rows = await appQuery(
    `SELECT alert_type, COUNT(*) AS n FROM ${A('am_alert')}
      WHERE status IN ('open','acknowledged') AND plant_id IN (?) GROUP BY alert_type`, [siteIds]);
  for (const r of rows) { out[r.alert_type] += r.n; out.open += r.n; }
  res.json(out);
}));

router.get('/alerts/:id', asyncH(async (req, res) => {
  const rows = await appQuery(`SELECT * FROM ${A('am_alert')} WHERE id = ?`, [Number(req.params.id)]);
  if (!rows[0] || !req.plantIds.includes(Number(rows[0].plant_id))) throw new HttpError(404, 'Alert not found');
  res.json(alertShape(rows[0], await catalog.getCatalog()));
}));

// POST /api/v1/devices { token, platform }  - register phone for push
router.post('/devices', asyncH(async (req, res) => {
  const token = req.body?.token ? String(req.body.token) : '';
  if (token.length < 10 || token.length > 512) throw new HttpError(400, 'token is required');
  const platform = req.body?.platform ? String(req.body.platform).slice(0, 20) : null;
  await appQuery(
    `INSERT INTO ${A('am_device_token')} (user_id, token, platform) VALUES (?, ?, ?)
     ON DUPLICATE KEY UPDATE user_id = VALUES(user_id), platform = VALUES(platform), last_seen_at = NOW()`,
    [req.user.userId, token, platform]);
  res.status(204).end();
}));

router.delete('/devices', asyncH(async (req, res) => {
  const token = req.body?.token ? String(req.body.token) : '';
  await appQuery(`DELETE FROM ${A('am_device_token')} WHERE token = ? AND user_id = ?`, [token, req.user.userId]);
  res.status(204).end();
}));

router.use(require('./data'));

module.exports = router;

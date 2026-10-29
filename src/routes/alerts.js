const router = require('express').Router();
const { appQuery, A } = require('../db');
const { asyncH, HttpError, intParam } = require('../lib/http');
const { parseLocalParam, nowLocal } = require('../lib/time');
const { requireAdmin } = require('../middleware/auth');

const TYPES = ['critical', 'warning', 'offline'];
const STATUSES = ['open', 'acknowledged', 'closed', 'active']; // active = open + acknowledged

function shape(a) {
  return {
    id: Number(a.id),
    plantId: a.plant_id,
    deviceId: a.device_id,
    paramId: a.param_id,
    type: a.alert_type,
    status: a.status,
    message: a.message,
    firstValue: a.first_value,
    lastValue: a.last_value,
    peakValue: a.peak_value,
    minLimit: a.min_limit,
    maxLimit: a.max_limit,
    startedAt: a.started_at,
    lastReadingAt: a.last_reading_at,
    endedAt: a.ended_at,
    acknowledgedBy: a.ack_by,
    acknowledgedAt: a.ack_at,
    ackNote: a.ack_note,
    closedBy: a.closed_by,
  };
}

async function getAllowed(req) {
  const rows = await appQuery(`SELECT * FROM ${A('am_alert')} WHERE id = ?`, [Number(req.params.id)]);
  const a = rows[0];
  if (!a || !req.plantIds.includes(Number(a.plant_id))) throw new HttpError(404, 'Alert not found');
  return a;
}

// GET /api/alerts?status=active&type=critical&plantId=1&deviceId=ETP_1&from=&to=&page=1&pageSize=50
router.get('/', asyncH(async (req, res) => {
  if (!req.plantIds.length) return res.json({ items: [], total: 0, page: 1, pageSize: 0 });
  const where = ['plant_id IN (?)'];
  const args = [req.plantIds];
  const { status, type, plantId, deviceId, paramId } = req.query;
  if (status) {
    if (!STATUSES.includes(status)) throw new HttpError(400, `status must be one of ${STATUSES.join(', ')}`);
    if (status === 'active') where.push(`status IN ('open','acknowledged')`);
    else { where.push('status = ?'); args.push(status); }
  }
  if (type) {
    if (!TYPES.includes(type)) throw new HttpError(400, `type must be one of ${TYPES.join(', ')}`);
    where.push('alert_type = ?'); args.push(type);
  }
  if (plantId) { where.push('plant_id = ?'); args.push(Number(plantId)); }
  if (deviceId) { where.push('device_id = ?'); args.push(String(deviceId)); }
  if (paramId) { where.push('param_id = ?'); args.push(String(paramId)); }
  const from = parseLocalParam(req.query.from);
  const to = parseLocalParam(req.query.to);
  if (from) { where.push('started_at >= ?'); args.push(from); }
  if (to) { where.push('started_at <= ?'); args.push(to); }

  const page = intParam(req.query.page, 1, 1, 100000);
  const pageSize = intParam(req.query.pageSize, 50, 1, 200);
  const w = where.join(' AND ');
  const [{ total }] = await appQuery(`SELECT COUNT(*) AS total FROM ${A('am_alert')} WHERE ${w}`, args);
  const rows = await appQuery(
    `SELECT * FROM ${A('am_alert')} WHERE ${w}
      ORDER BY (status = 'closed'), FIELD(alert_type,'critical','offline','warning'), started_at DESC
      LIMIT ? OFFSET ?`,
    [...args, pageSize, (page - 1) * pageSize]);
  res.json({ items: rows.map(shape), total, page, pageSize });
}));

// GET /api/alerts/summary -> counts of active alerts by type
router.get('/summary', asyncH(async (req, res) => {
  const out = { critical: 0, warning: 0, offline: 0, total: 0, unacknowledged: 0 };
  if (!req.plantIds.length) return res.json(out);
  const rows = await appQuery(
    `SELECT alert_type, status, COUNT(*) AS n FROM ${A('am_alert')}
      WHERE status IN ('open','acknowledged') AND plant_id IN (?) GROUP BY alert_type, status`, [req.plantIds]);
  for (const r of rows) {
    out[r.alert_type] += r.n; out.total += r.n;
    if (r.status === 'open') out.unacknowledged += r.n;
  }
  res.json(out);
}));

// GET /api/alerts/:id
router.get('/:id', asyncH(async (req, res) => {
  res.json(shape(await getAllowed(req)));
}));

// POST /api/alerts/:id/acknowledge  { note? }  - "I have seen it". Alert stays active until fixed.
router.post('/:id/acknowledge', asyncH(async (req, res) => {
  const a = await getAllowed(req);
  if (a.status !== 'open') throw new HttpError(409, `Alert is already ${a.status}`);
  const note = req.body?.note ? String(req.body.note).slice(0, 500) : null;
  await appQuery(
    `UPDATE ${A('am_alert')} SET status='acknowledged', ack_by=?, ack_at=?, ack_note=? WHERE id=? AND status='open'`,
    [req.user.userId, nowLocal(), note, a.id]);
  res.json(shape((await appQuery(`SELECT * FROM ${A('am_alert')} WHERE id=?`, [a.id]))[0]));
}));

// POST /api/alerts/:id/close  (admin) - close manually. If the problem continues the worker opens a new one.
router.post('/:id/close', requireAdmin, asyncH(async (req, res) => {
  const a = await getAllowed(req);
  if (a.status === 'closed') throw new HttpError(409, 'Alert is already closed');
  await appQuery(
    `UPDATE ${A('am_alert')} SET status='closed', ended_at=?, closed_by=?, open_key=NULL WHERE id=?`,
    [nowLocal(), req.user.userId, a.id]);
  res.json(shape((await appQuery(`SELECT * FROM ${A('am_alert')} WHERE id=?`, [a.id]))[0]));
}));

module.exports = router;

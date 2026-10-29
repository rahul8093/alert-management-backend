const router = require('express').Router();
const catalog = require('../services/catalog');
const readings = require('../services/readings');
const { appQuery, A } = require('../db');
const { asyncH, HttpError, intParam } = require('../lib/http');
const { parseLocalParam } = require('../lib/time');

async function openAlertCounts(plantIds) {
  if (!plantIds.length) return new Map();
  const rows = await appQuery(
    `SELECT plant_id, alert_type, COUNT(*) AS n FROM ${A('am_alert')}
      WHERE status <> 'closed' AND plant_id IN (?) GROUP BY plant_id, alert_type`, [plantIds]);
  const m = new Map();
  for (const r of rows) {
    const c = m.get(r.plant_id) || { critical: 0, warning: 0, offline: 0, total: 0 };
    c[r.alert_type] = r.n; c.total += r.n;
    m.set(r.plant_id, c);
  }
  return m;
}

function getDeviceOr404(cat, req) {
  const d = cat.deviceById.get(req.params.deviceId);
  if (!d || !req.plantIds.includes(d.plantId)) throw new HttpError(404, 'Device not found');
  return d;
}

// GET /api/plants  -> plants the user can see, with device count + open alert counts
router.get('/plants', asyncH(async (req, res) => {
  const cat = await catalog.getCatalog();
  const plants = cat.plants.filter((p) => req.plantIds.includes(p.plantId));
  const counts = await openAlertCounts(plants.map((p) => p.plantId));
  res.json(plants.map((p) => ({
    ...p,
    deviceCount: cat.devices.filter((d) => d.plantId === p.plantId && d.active).length,
    openAlerts: counts.get(p.plantId) || { critical: 0, warning: 0, offline: 0, total: 0 },
  })));
}));

// GET /api/plants/:plantId  -> plant + devices with live values and status
router.get('/plants/:plantId', asyncH(async (req, res) => {
  const plantId = Number(req.params.plantId);
  if (!req.plantIds.includes(plantId)) throw new HttpError(404, 'Plant not found');
  const cat = await catalog.getCatalog();
  const plant = cat.plants.find((p) => p.plantId === plantId);
  const devices = cat.devices.filter((d) => d.plantId === plantId && d.active);
  const live = await Promise.all(devices.map((d) => readings.liveStatus(d)));
  const counts = await openAlertCounts([plantId]);
  res.json({
    ...plant,
    openAlerts: counts.get(plantId) || { critical: 0, warning: 0, offline: 0, total: 0 },
    devices: devices.map((d, i) => ({ ...d, ...live[i] })),
  });
}));

// GET /api/devices?plantId=  -> device list with parameters and limits
router.get('/devices', asyncH(async (req, res) => {
  const cat = await catalog.getCatalog();
  const plantId = req.query.plantId ? Number(req.query.plantId) : null;
  res.json(cat.devices.filter((d) => req.plantIds.includes(d.plantId) && (!plantId || d.plantId === plantId)));
}));

// GET /api/devices/:deviceId  -> device + latest value/status per parameter
router.get('/devices/:deviceId', asyncH(async (req, res) => {
  const cat = await catalog.getCatalog();
  const d = getDeviceOr404(cat, req);
  res.json({ ...d, ...(await readings.liveStatus(d)) });
}));

// GET /api/devices/:deviceId/readings?param=BOD&from=2026-10-27 00:00:00&to=...&limit=500
router.get('/devices/:deviceId/readings', asyncH(async (req, res) => {
  const cat = await catalog.getCatalog();
  const d = getDeviceOr404(cat, req);
  const param = req.query.param ? String(req.query.param) : null;
  if (param && !d.params.some((p) => p.paramId === param)) throw new HttpError(400, `Unknown param ${param}`);
  res.json(await readings.history(d.deviceId, {
    param,
    from: parseLocalParam(req.query.from),
    to: parseLocalParam(req.query.to),
    limit: intParam(req.query.limit, 500, 1, 5000),
  }));
}));

// GET /api/devices/:deviceId/hourly?param=BOD&from=2026-10-20&to=2026-10-27  (min/max/avg per hour)
router.get('/devices/:deviceId/hourly', asyncH(async (req, res) => {
  const cat = await catalog.getCatalog();
  const d = getDeviceOr404(cat, req);
  res.json(await readings.hourly(d.deviceId, {
    param: req.query.param ? String(req.query.param) : null,
    from: parseLocalParam(req.query.from),
    to: parseLocalParam(req.query.to),
  }));
}));

module.exports = router;

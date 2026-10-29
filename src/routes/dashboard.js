const router = require('express').Router();
const catalog = require('../services/catalog');
const readings = require('../services/readings');
const { appQuery, A } = require('../db');
const { asyncH } = require('../lib/http');

// GET /api/dashboard  -> one call for the app home screen:
// active alert counts + every plant with each device's live status
router.get('/', asyncH(async (req, res) => {
  const cat = await catalog.getCatalog();
  const plants = cat.plants.filter((p) => req.plantIds.includes(p.plantId));
  const devices = cat.devices.filter((d) => d.active && req.plantIds.includes(d.plantId));
  const live = await Promise.all(devices.map((d) => readings.liveStatus(d)));

  const alerts = { critical: 0, warning: 0, offline: 0, total: 0, unacknowledged: 0 };
  if (req.plantIds.length) {
    const rows = await appQuery(
      `SELECT alert_type, status, COUNT(*) AS n FROM ${A('am_alert')}
        WHERE status IN ('open','acknowledged') AND plant_id IN (?) GROUP BY alert_type, status`, [req.plantIds]);
    for (const r of rows) {
      alerts[r.alert_type] += r.n; alerts.total += r.n;
      if (r.status === 'open') alerts.unacknowledged += r.n;
    }
  }

  const deviceStatus = { normal: 0, warning: 0, critical: 0, offline: 0 };
  live.forEach((l) => { deviceStatus[l.status] = (deviceStatus[l.status] || 0) + 1; });

  res.json({
    alerts,
    deviceStatus,
    plants: plants.map((p) => ({
      plantId: p.plantId,
      name: p.name,
      code: p.code,
      city: p.city,
      devices: devices
        .map((d, i) => ({ d, l: live[i] }))
        .filter(({ d }) => d.plantId === p.plantId)
        .map(({ d, l }) => ({
          deviceId: d.deviceId,
          name: d.name,
          status: l.status,
          lastReadingAt: l.lastReadingAt,
          params: l.params.map((x) => ({
            paramId: x.paramId, name: x.name, unit: x.unit, value: x.value, at: x.at, status: x.status, min: x.min, max: x.max,
          })),
        })),
    })),
  });
}));

module.exports = router;

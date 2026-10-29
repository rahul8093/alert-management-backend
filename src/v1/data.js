// /api/v1 data endpoints used by the app: sites, dashboard, live parameters, reports.
const router = require('express').Router();
const { srcQuery, appQuery, S, A } = require('../db');
const { asyncH, HttpError, intParam } = require('../lib/http');
const { nowLocal, addMinutesLocal, minutesBetween, localToIso, parseLocalParam, fromLocal } = require('../lib/time');
const catalog = require('../services/catalog');
const readings = require('../services/readings');
const { readingStatus } = require('../worker/rules');
const { decimalsFor, fmt, limitText, status3, hasMin, hasMax, alertShape } = require('./shape');

const KINDS = ['effluent', 'emission'];

/** Sites (plants) and devices the user may see, optionally filtered */
async function scope(req, { siteId, companyId, kind } = {}) {
  const cat = await catalog.getCatalog();
  const plants = cat.plants.filter((p) => req.plantIds.includes(p.plantId)
    && (!siteId || p.plantId === Number(siteId))
    && (!companyId || p.clientId === Number(companyId)));
  const ids = new Set(plants.map((p) => p.plantId));
  const devices = cat.devices.filter((d) => d.active && ids.has(d.plantId) && (!kind || d.kind === kind));
  return { cat, plants, devices };
}

async function lastReadingByDevice(deviceIds) {
  if (!deviceIds.length) return new Map();
  const rows = await srcQuery(
    `SELECT device_id, MAX(log_date) AS last FROM ${S('tt_raw_device')} WHERE device_id IN (?) GROUP BY device_id`,
    [deviceIds]);
  return new Map(rows.map((r) => [r.device_id, r.last]));
}

// GET /api/v1/sites
router.get('/sites', asyncH(async (req, res) => {
  const { cat, plants, devices } = await scope(req);
  const last = await lastReadingByDevice(devices.map((d) => d.deviceId));
  const sites = plants.map((p) => {
    const l = devices.filter((d) => d.plantId === p.plantId).map((d) => last.get(d.deviceId)).filter(Boolean).sort().pop() || null;
    return { id: p.plantId, name: p.name, code: p.code, companyId: p.clientId, lastReadingAt: localToIso(l) };
  });
  const clientIds = new Set(plants.map((p) => p.clientId));
  res.json({ companies: cat.clients.filter((c) => clientIds.has(c.id)), sites });
}));

/** Live parameter cards: latest value, limit, status, 24 h trend and average. */
async function liveParameters(cat, devices, multiSite) {
  const now = nowLocal();
  const since = addMinutesLocal(now, -24 * 60);
  const out = [];
  for (const d of devices) {
    const plant = cat.plants.find((p) => p.plantId === d.plantId);
    const [live, rows] = await Promise.all([
      readings.liveStatus(d, now),
      srcQuery(
        `SELECT property_name, property_value FROM ${S('tt_raw_device')}
          WHERE device_id = ? AND log_date >= ? ORDER BY log_date`, [d.deviceId, since]),
    ]);
    for (const p of live.params) {
      const values = rows.filter((r) => r.property_name === p.paramId && r.property_value !== null).map((r) => Number(r.property_value));
      const avg = values.length ? values.reduce((a, b) => a + b, 0) / values.length : null;
      const dec = decimalsFor(p.paramId);
      out.push({
        key: `${d.deviceId}.${p.paramId}`,
        name: multiSite ? `${p.name} · ${plant?.name || d.plantId}` : p.name,
        category: d.category,
        value: fmt(p.value, dec),
        numericValue: p.value === null || p.value === undefined ? null : Number(p.value),
        unit: p.unit || '',
        limit: limitText(p.min, p.max),
        limitMin: hasMin(p.min) ? Number(p.min) : null,
        limitMax: hasMax(p.max) ? Number(p.max) : null,
        avg: fmt(avg, dec),
        received: localToIso(p.at),
        status: status3(p.status),
        stale: p.status === 'stale' || p.status === 'nodata',
        trend: values.slice(-96),
        decimals: dec,
        deviceId: d.deviceId,
        siteId: d.plantId,
      });
    }
  }
  return out;
}

// GET /api/v1/parameters/live?siteId=&companyId=&kind=effluent|emission
router.get('/parameters/live', asyncH(async (req, res) => {
  const kind = KINDS.includes(req.query.kind) ? req.query.kind : undefined;
  const { cat, plants, devices } = await scope(req, { siteId: req.query.siteId, companyId: req.query.companyId, kind });
  const items = await liveParameters(cat, devices, plants.length > 1);
  res.json({ scope: req.query.siteId ? 'site' : req.query.companyId ? 'company' : 'all', items });
}));

// GET /api/v1/dashboard?siteId=
router.get('/dashboard', asyncH(async (req, res) => {
  const { cat, plants, devices } = await scope(req, { siteId: req.query.siteId });
  const plantIds = plants.map((p) => p.plantId);
  const now = nowLocal();
  const monthStart = `${now.slice(0, 8)}01 00:00:00`;
  const multiSite = plants.length > 1;

  // ---- alerts ----
  const stats = { total: 0, critical: 0, warning: 0, offline: 0, sensor: 0, resolved: 0 };
  let criticalAlert = null;
  const failureByParam = new Map();
  if (plantIds.length) {
    const active = await appQuery(
      `SELECT alert_type, COUNT(*) AS n FROM ${A('am_alert')}
        WHERE status IN ('open','acknowledged') AND plant_id IN (?) GROUP BY alert_type`, [plantIds]);
    for (const r of active) { stats[r.alert_type] += r.n; stats.total += r.n; }
    const [resolved] = await appQuery(
      `SELECT COUNT(*) AS n FROM ${A('am_alert')} WHERE status = 'closed' AND plant_id IN (?) AND ended_at >= ?`,
      [plantIds, monthStart]);
    stats.resolved = resolved.n;
    const crit = await appQuery(
      `SELECT * FROM ${A('am_alert')} WHERE status IN ('open','acknowledged') AND alert_type = 'critical'
        AND plant_id IN (?) ORDER BY started_at DESC LIMIT 1`, [plantIds]);
    if (crit[0]) {
      const s = alertShape(crit[0], cat);
      criticalAlert = { id: Number(s.id), title: `${s.title} · ${s.site.name}`, message: crit[0].message, siteName: s.site.name, openedAt: s.openedAt };
    }
    const fails = await appQuery(
      `SELECT param_id, COUNT(*) AS n FROM ${A('am_alert')}
        WHERE plant_id IN (?) AND param_id IS NOT NULL AND alert_type = 'critical' AND started_at >= ?
        GROUP BY param_id`, [plantIds, monthStart]);
    for (const f of fails) failureByParam.set(f.param_id, f.n);
  }

  // ---- live values + month-to-date compliance ----
  const live = await Promise.all(devices.map((d) => readings.liveStatus(d, now)));
  const mtd = devices.length
    ? await srcQuery(
      `SELECT device_id, property_name, log_date, property_value FROM ${S('tt_raw_device')}
        WHERE device_id IN (?) AND log_date >= ? AND log_date <= ?`,
      [devices.map((d) => d.deviceId), monthStart, now])
    : [];
  const minutesSoFar = Math.max(15, minutesBetween(monthStart, now));
  const expectedSlots = Math.floor(minutesSoFar / 15);

  const block = (category) => {
    let total = 0; let ok = 0;
    const slotPct = [];
    const items = [];
    devices.forEach((d, i) => {
      if (d.category !== category) return;
      const plant = cat.plants.find((p) => p.plantId === d.plantId);
      for (const p of d.params) {
        const rows = mtd.filter((r) => r.device_id === d.deviceId && r.property_name === p.paramId);
        if (hasMax(p.max) || hasMin(p.min)) {
          for (const r of rows) {
            if (r.property_value === null) continue;
            total++;
            if (readingStatus(r.property_value, p.min, p.max, 1) !== 'critical') ok++;
          }
        }
        const slots = new Set(rows.map((r) => Math.floor(fromLocal(r.log_date).getTime() / 900000)));
        slotPct.push(Math.min(100, (slots.size / expectedSlots) * 100));
        const lp = live[i].params.find((x) => x.paramId === p.paramId);
        items.push({
          key: `${d.deviceId}.${p.paramId}`,
          name: multiSite ? `${p.name} (${plant?.plantNo || plant?.code || d.plantId})` : p.name,
          value: fmt(lp?.value, decimalsFor(p.paramId)),
          limit: limitText(p.min, p.max),
          status: status3(lp?.status),
        });
      }
    });
    return {
      parameterCompliance: total ? Math.round((ok / total) * 1000) / 10 : null,
      dataCompliance: slotPct.length ? Math.round((slotPct.reduce((a, b) => a + b, 0) / slotPct.length) * 10) / 10 : null,
      items,
    };
  };

  const paramNames = new Map();
  devices.forEach((d) => d.params.forEach((p) => paramNames.set(p.paramId, p.name)));

  const parameterBars = [];
  devices.forEach((d, i) => {
    for (const p of live[i].params) {
      if (!hasMax(p.max) || p.value === null || p.value === undefined) continue;
      parameterBars.push({
        key: `${d.deviceId}.${p.paramId}`,
        name: multiSite ? `${p.name} ${d.deviceId}` : p.name,
        percent: Math.max(0, Math.min(100, Math.round((Number(p.value) / Number(p.max)) * 100))),
        status: status3(p.status),
      });
    }
  });

  res.json({
    period: 'MTD',
    generatedAt: localToIso(now),
    criticalAlert,
    stats,
    environmentalStatus: { air: block('air'), water: block('water') },
    failureEvents: [...paramNames].map(([key, name]) => ({ key, name, events: failureByParam.get(key) || 0 })),
    parameterBars,
  });
}));

// ---------- reports ----------
async function buildReport(req, all) {
  const kind = req.params.kind;
  if (!KINDS.includes(kind)) throw new HttpError(404, 'Unknown report');
  const siteId = Number(req.query.siteId);
  if (!siteId) throw new HttpError(400, 'siteId is required');
  const { plants, devices } = await scope(req, { siteId, kind });
  if (!plants.length) throw new HttpError(404, 'Site not found');
  const from = parseLocalParam(req.query.from) || `${nowLocal().slice(0, 10)} 00:00:00`;
  const toDay = parseLocalParam(req.query.to) || from;
  const to = `${toDay.slice(0, 10)} 23:59:59`;

  const multi = devices.length > 1;
  const columns = [];
  const colOf = new Map();
  for (const d of devices) {
    for (const p of d.params) {
      const key = multi ? `${d.deviceId}.${p.paramId}` : p.paramId;
      colOf.set(`${d.deviceId}|${p.paramId}`, { key, p });
      columns.push({
        key,
        title: multi ? `${d.name} ${p.name}` : p.name,
        unit: p.unit || '',
        decimals: decimalsFor(p.paramId),
        limitMin: hasMin(p.min) ? Number(p.min) : null,
        limitMax: hasMax(p.max) ? Number(p.max) : null,
      });
    }
  }

  const raw = devices.length
    ? await srcQuery(
      `SELECT device_id, log_date, property_name, property_value FROM ${S('tt_raw_device')}
        WHERE device_id IN (?) AND log_date BETWEEN ? AND ? ORDER BY log_date`,
      [devices.map((d) => d.deviceId), from, to])
    : [];
  const byTime = new Map();
  for (const r of raw) {
    const c = colOf.get(`${r.device_id}|${r.property_name}`);
    if (!c) continue;
    if (!byTime.has(r.log_date)) byTime.set(r.log_date, { logDate: localToIso(r.log_date), values: Object.fromEntries(columns.map((x) => [x.key, null])), outOfRange: [] });
    const row = byTime.get(r.log_date);
    row.values[c.key] = r.property_value === null ? null : Number(r.property_value);
    if (readingStatus(r.property_value, c.p.min, c.p.max, 1) === 'critical') row.outOfRange.push(c.key);
  }
  const rowsAll = [...byTime.values()];
  const limit = all ? rowsAll.length : intParam(req.query.limit, 500, 1, 5000);
  const offset = all ? 0 : intParam(req.query.offset, 0, 0, 10000000);
  return {
    site: { id: plants[0].plantId, name: plants[0].name },
    kind,
    from: from.slice(0, 10),
    to: to.slice(0, 10),
    columns,
    rows: rowsAll.slice(offset, offset + limit),
    total: rowsAll.length,
    limit,
    offset,
  };
}

// GET /api/v1/reports/:kind?siteId=&from=YYYY-MM-DD&to=YYYY-MM-DD&limit=&offset=
router.get('/reports/:kind', asyncH(async (req, res) => {
  res.json(await buildReport(req, false));
}));

// GET /api/v1/reports/:kind/export.csv
router.get('/reports/:kind/export.csv', asyncH(async (req, res) => {
  const r = await buildReport(req, true);
  const esc = (v) => (/[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));
  const lines = [['Site', 'log_date', ...r.columns.map((c) => (c.unit ? `${c.title} (${c.unit})` : c.title))].map(esc).join(',')];
  for (const row of r.rows) {
    lines.push([r.site.name, row.logDate.slice(0, 19).replace('T', ' '),
      ...r.columns.map((c) => (row.values[c.key] === null ? '' : row.values[c.key].toFixed(c.decimals)))].map(esc).join(','));
  }
  res.type('text/csv').send(lines.join('\n'));
}));

module.exports = router;
module.exports.liveParameters = liveParameters;

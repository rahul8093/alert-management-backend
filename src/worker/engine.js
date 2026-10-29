// One alert check: read latest data for every active device, compare with limits,
// and open / update / close rows in am_alert (APP_DB). Source tables are only read.
const config = require('../config');
const { appQuery, A } = require('../db');
const { nowLocal } = require('../lib/time');
const catalog = require('../services/catalog');
const readings = require('../services/readings');
const notify = require('../services/notify');
const { evaluateDevice, limitText } = require('./rules');

const SEVERITY = { warning: 1, critical: 2 };

async function findOpen(key) {
  const rows = await appQuery(`SELECT * FROM ${A('am_alert')} WHERE open_key = ?`, [key]);
  return rows[0] || null;
}

async function openAlert(fields) {
  try {
    const r = await appQuery(
      `INSERT INTO ${A('am_alert')}
        (plant_id, device_id, param_id, alert_type, message, first_value, last_value, peak_value,
         min_limit, max_limit, started_at, last_reading_at, open_key)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [fields.plant_id, fields.device_id, fields.param_id, fields.alert_type, fields.message,
        fields.value, fields.value, fields.value, fields.min, fields.max,
        fields.started_at, fields.last_reading_at, fields.open_key]);
    return { id: r.insertId, ...fields };
  } catch (e) {
    if (e.code === 'ER_DUP_ENTRY') return null; // another worker opened it first
    throw e;
  }
}

async function closeByKey(key, endedAt) {
  const r = await appQuery(
    `UPDATE ${A('am_alert')} SET status='closed', ended_at=?, closed_by='system', open_key=NULL
      WHERE open_key = ?`, [endedAt, key]);
  return r.affectedRows;
}

async function checkDevice(device, plantName, now, stats) {
  const latest = await readings.latestByParam(device, now);
  const ev = evaluateDevice(device, latest, now, config.worker);
  const where = `${device.name} (${device.deviceId})${plantName ? ` at ${plantName}` : ''}`;

  // ---- offline ----
  const offKey = `off:${device.deviceId}`;
  if (ev.offline) {
    if (!(await findOpen(offKey))) {
      const since = ev.offline.lastReadingAt || 'never';
      const a = await openAlert({
        plant_id: device.plantId, device_id: device.deviceId, param_id: null, alert_type: 'offline',
        message: `No data from ${where} since ${since}`, value: null, min: null, max: null,
        started_at: ev.offline.lastReadingAt || now, last_reading_at: ev.offline.lastReadingAt, open_key: offKey,
      });
      if (a) {
        stats.opened++;
        await notify.queueForAlert(a, `Offline: ${device.name}`, a.message);
      }
    }
  } else if (await closeByKey(offKey, now)) {
    stats.closed++;
  }

  // ---- limits ----
  for (const p of ev.params) {
    const key = `lim:${device.deviceId}:${p.paramId}`;
    if (p.status === 'critical' || p.status === 'warning') {
      const open = await findOpen(key);
      const msg = `${limitText(p)} - ${where}`;
      if (!open) {
        const a = await openAlert({
          plant_id: device.plantId, device_id: device.deviceId, param_id: p.paramId, alert_type: p.status,
          message: msg, value: p.value, min: p.min, max: p.max,
          started_at: p.at, last_reading_at: p.at, open_key: key,
        });
        if (a) {
          stats.opened++;
          await notify.queueForAlert(a, `${p.status === 'critical' ? 'CRITICAL' : 'Warning'}: ${p.name} at ${plantName || device.name}`, msg);
        }
      } else if (open.last_reading_at !== p.at || open.alert_type !== p.status) {
        const escalated = SEVERITY[p.status] > SEVERITY[open.alert_type];
        await appQuery(
          `UPDATE ${A('am_alert')}
              SET last_value=?, last_reading_at=?, alert_type=?, message=?,
                  peak_value = CASE WHEN ? > COALESCE(peak_value, ?) THEN ? ELSE peak_value END
            WHERE id=?`,
          [p.value, p.at, p.status, msg, p.value, p.value, p.value, open.id]);
        stats.updated++;
        if (escalated) {
          await notify.queueForAlert({ ...open, alert_type: p.status }, `CRITICAL: ${p.name} at ${plantName || device.name}`, msg);
        }
      }
    } else if (p.status === 'normal') {
      // Back within limits on a fresh reading -> close
      if (await closeByKey(key, p.at)) stats.closed++;
    }
    // 'stale' / 'nodata': leave as is - we do not know the current value
  }
}

async function runOnce() {
  const started = Date.now();
  const now = nowLocal();
  const cat = await catalog.getCatalog(true);
  const plantName = new Map(cat.plants.map((p) => [p.plantId, p.name]));
  const activePlants = new Set(cat.plants.filter((p) => p.active).map((p) => p.plantId));
  const stats = { devices: 0, opened: 0, updated: 0, closed: 0, errors: 0 };

  for (const d of cat.devices) {
    if (!d.active || !d.params.length || !activePlants.has(d.plantId)) continue;
    try {
      stats.devices++;
      await checkDevice(d, plantName.get(d.plantId), now, stats);
    } catch (e) {
      stats.errors++;
      console.error(`[worker] ${d.deviceId}:`, e.message);
    }
  }

  await appQuery(
    `INSERT INTO ${A('am_worker_state')} (k, v) VALUES ('last_run', ?)
     ON DUPLICATE KEY UPDATE v = VALUES(v)`,
    [JSON.stringify({ at: now, ms: Date.now() - started, ...stats })]);
  return stats;
}

module.exports = { runOnce };

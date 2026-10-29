// Readings come from tt_raw_device (one row per device + time + parameter) and
// ta_device_hrs (hourly min/max/avg). Both read only.
const { srcQuery, S } = require('../db');
const config = require('../config');
const { nowLocal, addMinutesLocal } = require('../lib/time');
const { evaluateDevice } = require('../worker/rules');

/** Newest reading for each parameter of a device. Uses the primary key (device_id, log_date, ...). */
async function latestByParam(device, now = nowLocal()) {
  const latest = new Map();
  // Ignore rows dated more than 5 min in the future (wrong logger clock)
  const upTo = addMinutesLocal(now, 5);
  await Promise.all(device.params.map(async (p) => {
    const rows = await srcQuery(
      `SELECT log_date, property_value FROM ${S('tt_raw_device')}
        WHERE device_id = ? AND property_name = ? AND log_date <= ?
        ORDER BY log_date DESC LIMIT 1`,
      [device.deviceId, p.paramId, upTo],
    );
    if (rows[0]) latest.set(p.paramId, rows[0]);
  }));
  return latest;
}

/** Latest values + live status (normal / warning / critical / stale / nodata) for a device. */
async function liveStatus(device, now = nowLocal()) {
  const latest = await latestByParam(device, now);
  const ev = evaluateDevice(device, latest, now, config.worker);
  const worst = ev.offline ? 'offline'
    : ev.params.some((p) => p.status === 'critical') ? 'critical'
      : ev.params.some((p) => p.status === 'warning') ? 'warning' : 'normal';
  const lastReadingAt = ev.params.reduce((m, p) => (p.at && (!m || p.at > m) ? p.at : m), null);
  return { deviceId: device.deviceId, status: worst, lastReadingAt, offline: ev.offline, params: ev.params };
}

async function history(deviceId, { param, from, to, limit }) {
  const where = ['device_id = ?'];
  const args = [deviceId];
  if (param) { where.push('property_name = ?'); args.push(param); }
  if (from) { where.push('log_date >= ?'); args.push(from); }
  if (to) { where.push('log_date <= ?'); args.push(to); }
  args.push(limit);
  // GROUP BY not needed: (device_id, log_date, property_name) is the primary key, so no duplicates.
  return srcQuery(
    `SELECT log_date AS at, property_name AS paramId, property_value AS value
       FROM ${S('tt_raw_device')}
      WHERE ${where.join(' AND ')}
      ORDER BY log_date DESC
      LIMIT ?`,
    args,
  );
}

async function hourly(deviceId, { param, from, to }) {
  const where = ['device_id = ?'];
  const args = [deviceId];
  if (param) { where.push('property_name = ?'); args.push(param); }
  if (from) { where.push('log_date >= ?'); args.push(from.slice(0, 10)); }
  if (to) { where.push('log_date <= ?'); args.push(to.slice(0, 10)); }
  return srcQuery(
    `SELECT log_date AS date, log_hrs AS hour, property_name AS paramId,
            min_value AS min, max_value AS max, avg_value AS avg
       FROM ${S('ta_device_hrs')}
      WHERE ${where.join(' AND ')}
      ORDER BY log_date DESC, log_hrs DESC
      LIMIT 2000`,
    args,
  );
}

module.exports = { latestByParam, liveStatus, history, hourly };

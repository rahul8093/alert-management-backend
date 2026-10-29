// Pure alert rules - no database here, so they are easy to test (see test/rules.test.js).
const { minutesBetween } = require('../lib/time');

/**
 * Status of one reading against its limits.
 * critical: above max or below min
 * warning:  >= max * warnRatio (approaching the limit)
 * normal:   otherwise, or no limits configured
 */
function readingStatus(value, min, max, warnRatio) {
  if (value === null || value === undefined || Number.isNaN(Number(value))) return 'nodata';
  const v = Number(value);
  const hasMax = max !== null && max !== undefined && Number(max) > 0;
  const hasMin = min !== null && min !== undefined && Number(min) > 0; // min 0 means "no lower limit"
  if (hasMax && v > Number(max)) return 'critical';
  if (hasMin && v < Number(min)) return 'critical';
  if (hasMax && hasMin) {
    // Range limit (e.g. pH 5.5 - 9): warn inside the outer 10 % of the range on either side
    const band = (Number(max) - Number(min)) * (1 - warnRatio);
    if (v >= Number(max) - band || v <= Number(min) + band) return 'warning';
  } else if (hasMax && v >= Number(max) * warnRatio) return 'warning';
  return 'normal';
}

/**
 * Decide what alerts SHOULD be open for one device right now.
 * @param device  { deviceId, params:[{paramId,name,unit,min,max}] }
 * @param latest  Map paramId -> { log_date, property_value }  (newest reading per parameter)
 * @param now     'YYYY-MM-DD HH:mm:ss' (data timezone)
 * @returns {{ offline: null|{lastReadingAt, minutes}, params: Array<{paramId, status, value, at, min, max, name, unit}> }}
 */
function evaluateDevice(device, latest, now, cfg) {
  let lastAt = null;
  for (const r of latest.values()) if (r && (!lastAt || r.log_date > lastAt)) lastAt = r.log_date;

  const silentMin = lastAt ? minutesBetween(lastAt, now) : Infinity;
  const offline = silentMin > cfg.offlineAfterMinutes
    ? { lastReadingAt: lastAt, minutes: Number.isFinite(silentMin) ? Math.round(silentMin) : null }
    : null;

  const params = device.params.map((p) => {
    const r = latest.get(p.paramId);
    const base = { paramId: p.paramId, name: p.name, unit: p.unit, min: p.min, max: p.max };
    if (!r) return { ...base, status: 'nodata', value: null, at: null };
    const age = minutesBetween(r.log_date, now);
    // Old readings do not drive limit alerts (the device is offline instead)
    const status = age > cfg.maxAgeMinutes ? 'stale' : readingStatus(r.property_value, p.min, p.max, cfg.warnRatio);
    return { ...base, status, value: r.property_value, at: r.log_date };
  });

  return { offline, params };
}

function limitText(p) {
  const u = p.unit ? ` ${p.unit}` : '';
  if (p.status === 'critical') {
    if (p.max !== null && Number(p.value) > Number(p.max)) return `${p.name} is ${p.value}${u}, above limit ${p.max}${u}`;
    return `${p.name} is ${p.value}${u}, below limit ${p.min}${u}`;
  }
  if (p.min !== null && Number(p.min) > 0 && Number(p.value) - Number(p.min) < Number(p.max) - Number(p.value)) {
    return `${p.name} is ${p.value}${u}, close to lower limit ${p.min}${u}`;
  }
  return `${p.name} is ${p.value}${u}, close to limit ${p.max}${u}`;
}

module.exports = { readingStatus, evaluateDevice, limitText };

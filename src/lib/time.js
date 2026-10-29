// tt_raw_device.log_date has no timezone - it is local IST time stored as text-like DATETIME.
// We do all date math on 'YYYY-MM-DD HH:mm:ss' strings in that offset, independent of the
// server's or MySQL's timezone.
const config = require('../config');

function offsetMinutes(offset = config.dataTzOffset) {
  const m = /^([+-])(\d{2}):(\d{2})$/.exec(offset);
  if (!m) throw new Error(`Bad DATA_TZ_OFFSET: ${offset}`);
  return (m[1] === '-' ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3]));
}

/** Date -> 'YYYY-MM-DD HH:mm:ss' in the data timezone */
function toLocal(date = new Date()) {
  const d = new Date(date.getTime() + offsetMinutes() * 60000);
  return d.toISOString().slice(0, 19).replace('T', ' ');
}

/** 'YYYY-MM-DD HH:mm:ss' (data timezone) -> Date */
function fromLocal(s) {
  if (!s) return null;
  const iso = String(s).trim().replace(' ', 'T');
  const d = new Date(`${iso.length === 10 ? iso + 'T00:00:00' : iso}Z`);
  if (Number.isNaN(d.getTime())) return null;
  return new Date(d.getTime() - offsetMinutes() * 60000);
}

const nowLocal = () => toLocal(new Date());
const addMinutesLocal = (s, min) => toLocal(new Date(fromLocal(s).getTime() + min * 60000));
const minutesBetween = (a, b) => (fromLocal(b).getTime() - fromLocal(a).getTime()) / 60000;

/** Validates a user-supplied date/datetime string; returns normalized string or null */
function parseLocalParam(s) {
  if (!s) return null;
  const d = fromLocal(s);
  return d ? toLocal(d) : null;
}

/** 'YYYY-MM-DD HH:mm:ss' (data timezone) -> '2026-10-28T10:30:00+05:30' for the app */
const localToIso = (s) => (s ? `${String(s).slice(0, 19).replace(' ', 'T')}${config.dataTzOffset}` : null);

module.exports = { localToIso, toLocal, fromLocal, nowLocal, addMinutesLocal, minutesBetween, parseLocalParam };

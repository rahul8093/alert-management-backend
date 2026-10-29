// Converts backend data into the exact shapes the React Native app expects (src/api/types.ts in the app).
const { localToIso } = require('../lib/time');

const DECIMALS = { pH: 2 };
const decimalsFor = (paramId) => DECIMALS[paramId] ?? 1;

const hasMin = (min) => min !== null && min !== undefined && Number(min) > 0;
const hasMax = (max) => max !== null && max !== undefined && Number(max) > 0;

const fmt = (v, dec) => (v === null || v === undefined || Number.isNaN(Number(v)) ? '—' : Number(v).toFixed(dec));

/** "30" or "5.5–9" or "—" */
function limitText(min, max) {
  if (hasMin(min) && hasMax(max)) return `${Number(min)}–${Number(max)}`;
  if (hasMax(max)) return `${Number(max)}`;
  if (hasMin(min)) return `≥ ${Number(min)}`;
  return '—';
}

/** App only knows normal / warning / critical */
const status3 = (s) => (s === 'critical' || s === 'warning' ? s : 'normal');

function userShape(u, cat, plantIds) {
  const name = u.name || u.userId;
  const parts = name.split(/\s+/).filter(Boolean);
  const roleIds = u.roles.map((r) => r.id);
  const firstPlant = cat.plants.find((p) => plantIds.includes(p.plantId));
  const client = cat.clients.find((c) => c.id === firstPlant?.clientId) || cat.clients[0] || null;
  return {
    id: u.userId,
    name,
    firstName: parts[0] || name,
    initials: (parts.length > 1 ? parts[0][0] + parts[1][0] : name.slice(0, 2)).toUpperCase(),
    email: u.email || '',
    role: roleIds.includes(3) ? 'superadmin' : u.isAdmin ? 'admin' : 'user',
    company: client ? { id: client.id, name: client.name } : null,
    preferences: { pushAlerts: true, emailAlerts: false },
  };
}

function alertShape(a, cat) {
  const device = cat.deviceById.get(a.device_id);
  const plant = cat.plants.find((p) => p.plantId === Number(a.plant_id));
  const client = cat.clients.find((c) => c.id === plant?.clientId);
  const param = device?.params.find((p) => p.paramId === a.param_id);
  const paramName = param?.name || a.param_id;
  const unit = param?.unit ? ` ${param.unit}` : '';
  const deviceName = device?.name || a.device_id;

  let title;
  if (a.alert_type === 'offline') title = `${deviceName} offline`;
  else if (a.alert_type === 'critical') {
    const below = hasMin(a.min_limit) && Number(a.peak_value ?? a.last_value) < Number(a.min_limit);
    title = `${paramName} ${below ? 'below' : 'above'} limit`;
  } else title = `${paramName} near limit`;

  const value = a.alert_type === 'offline' ? null : (a.peak_value ?? a.last_value);
  const meta = [plant?.name, deviceName, value !== null && value !== undefined ? `${fmt(value, decimalsFor(a.param_id))}${unit}` : null]
    .filter(Boolean).join(' · ');
  const closed = a.status === 'closed';
  return {
    id: String(a.id),
    type: closed ? 'resolved' : a.alert_type,
    severity: a.alert_type,
    status: closed ? 'resolved' : 'open',
    acknowledged: a.status === 'acknowledged',
    title,
    meta: a.alert_type === 'offline' ? `${meta} · ${a.message}` : meta,
    time: localToIso(closed ? a.ended_at : a.started_at),
    openedAt: localToIso(a.started_at),
    resolvedAt: closed ? localToIso(a.ended_at) : null,
    site: { id: Number(a.plant_id), name: plant?.name || `Plant ${a.plant_id}` },
    companyName: client?.name || '',
    parameter: a.param_id ? { key: a.param_id, name: paramName } : null,
    value: value ?? null,
    limit: a.param_id ? limitText(a.min_limit, a.max_limit) : null,
  };
}

module.exports = { decimalsFor, fmt, limitText, status3, hasMin, hasMax, userShape, alertShape };

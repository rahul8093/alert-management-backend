// Master data (plants, devices, parameters, limits). Small, so it is cached for 60 s.
const { srcQuery, appQuery, S, A } = require('../db');

// m_uom is empty in the current data, so units come from here (change if the client uses others).
const DEFAULT_UNITS = { BOD: 'mg/l', COD: 'mg/l', TSS: 'mg/l', pH: '', PM: 'mg/Nm³', flow_volume: 'm³', flow_outlet: 'm³/hr' };
// Devices measuring these parameters are stacks (air / emission); everything else is effluent (water).
const AIR_PARAMS = new Set(['PM', 'PM10', 'PM2.5', 'PM25', 'SO2', 'NOX', 'NOx', 'CO', 'CO2', 'O2', 'HCL', 'HF', 'NH3']);

let cache = null;
let cacheAt = 0;
const TTL_MS = 60 * 1000;

async function load() {
  const [plants, devices, params, maps, setpoints, clients] = await Promise.all([
    srcQuery(`SELECT plant_id, client_id, plant_name, plant_code, plant_no, address, city, status
                FROM ${S('m_plant')} ORDER BY plant_id`),
    srcQuery(`SELECT d.device_id, d.device_name, d.plant_id, d.client_id, d.devicetype_id, d.status,
                     dt.devicetype_name
                FROM ${S('m_device')} d
                LEFT JOIN ${S('m_devicetype')} dt ON dt.devicetype_id = d.devicetype_id
               ORDER BY d.plant_id, d.device_id`),
    srcQuery(`SELECT p.param_id, p.param_name, p.uom_id, u.symbol AS uom, p.status
                FROM ${S('m_device_param')} p
                LEFT JOIN ${S('m_uom')} u ON u.uom_id = p.uom_id`),
    srcQuery(`SELECT device_id, param_id, seq_no, status FROM ${S('m_device_param_map')} ORDER BY device_id, seq_no`),
    srcQuery(`SELECT device_id, device_property, min_setpoint, max_setpoint FROM ${S('m_device_setpoint')}`),
    srcQuery(`SELECT client_id, first_name, last_name, client_code FROM ${S('m_client')}`),
  ]);

  const paramById = new Map(params.map((p) => [p.param_id, p]));
  const limit = new Map(setpoints.map((s) => [`${s.device_id}|${s.device_property}`, s]));

  const deviceList = devices.map((d) => {
    const deviceParams = maps
      .filter((m) => m.device_id === d.device_id && (m.status === null || m.status === 'A'))
      .map((m) => {
        const p = paramById.get(m.param_id) || { param_name: m.param_id };
        const sp = limit.get(`${d.device_id}|${m.param_id}`) || {};
        return {
          paramId: m.param_id,
          name: p.param_name || m.param_id,
          unit: p.uom || DEFAULT_UNITS[m.param_id] || '',
          seq: m.seq_no,
          min: sp.min_setpoint ?? null,
          max: sp.max_setpoint ?? null,
        };
      });
    const isAir = deviceParams.some((p) => AIR_PARAMS.has(p.paramId));
    return {
      deviceId: d.device_id,
      kind: isAir ? 'emission' : 'effluent',
      category: isAir ? 'air' : 'water',
      name: d.device_name,
      plantId: d.plant_id,
      type: d.devicetype_name || null,
      active: d.status === 'A',
      params: deviceParams,
    };
  });

  return {
    plants: plants.map((p) => ({
      plantId: p.plant_id,
      clientId: p.client_id,
      name: p.plant_name,
      code: p.plant_code,
      plantNo: p.plant_no,
      address: p.address,
      city: p.city,
      active: p.status === 'A',
    })),
    clients: clients.map((c) => ({
      id: c.client_id,
      name: [c.first_name, c.last_name].filter(Boolean).join(' ').trim() || c.client_code || `Client ${c.client_id}`,
    })),
    devices: deviceList,
    deviceById: new Map(deviceList.map((d) => [d.deviceId, d])),
  };
}

async function getCatalog(force = false) {
  if (!cache || force || Date.now() - cacheAt > TTL_MS) {
    cache = await load();
    cacheAt = Date.now();
  }
  return cache;
}

/**
 * Plant ids a user may see. Admins: all. Others: rows in am_user_plant if any, otherwise all.
 * (The old database has no user->plant table, so access is open until am_user_plant is filled.)
 */
async function allowedPlantIds(user) {
  const { plants } = await getCatalog();
  const all = plants.filter((p) => p.active).map((p) => p.plantId);
  if (user.isAdmin) return all;
  const rows = await appQuery(`SELECT plant_id FROM ${A('am_user_plant')} WHERE user_id = ?`, [user.userId]);
  if (!rows.length) return all;
  const mine = new Set(rows.map((r) => Number(r.plant_id)));
  return all.filter((id) => mine.has(id));
}

module.exports = { getCatalog, allowedPlantIds };

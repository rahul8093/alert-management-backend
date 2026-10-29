// Quick sanity check: can we read the source tables and is the app DB migrated?
const { pool, srcQuery, appQuery, S, A } = require('../src/db');
const config = require('../src/config');

(async () => {
  const tables = ['m_user', 'm_user_role', 'm_role', 'm_plant', 'm_device', 'm_device_param',
    'm_device_param_map', 'm_device_setpoint', 'tt_raw_device', 'ta_device_hrs'];
  console.log(`Source DB: ${config.srcDb}`);
  for (const t of tables) {
    try {
      const [r] = await srcQuery(`SELECT COUNT(*) AS n FROM ${S(t)}`);
      console.log(`  ok  ${t.padEnd(20)} ${r.n} rows`);
    } catch (e) { console.log(`  ERR ${t.padEnd(20)} ${e.message}`); }
  }
  const [last] = await srcQuery(`SELECT MAX(log_date) AS last FROM ${S('tt_raw_device')}`);
  console.log(`  latest reading: ${last.last}`);

  console.log(`App DB: ${config.appDb}`);
  try {
    const [r] = await appQuery(`SELECT COUNT(*) AS n FROM ${A('am_alert')}`);
    console.log(`  ok  am_alert ${r.n} rows`);
  } catch (e) { console.log(`  ERR ${e.message}  -> run "npm run migrate"`); }

  // Show whether this login could write to the source DB (it should not be able to).
  const grants = await srcQuery('SHOW GRANTS');
  console.log('Grants of this MySQL login:');
  grants.forEach((g) => console.log('  ' + Object.values(g)[0]));
  await pool.end();
})().catch(async (e) => { console.error(e.message); await pool.end(); process.exit(1); });

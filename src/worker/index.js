// Background process: checks alerts every WORKER_INTERVAL_SECONDS and sends queued
// notifications every DISPATCH_INTERVAL_SECONDS. Run it separately from the API:
//   npm run worker          (keeps running)
//   npm run worker:once     (one check, then exit - handy for testing)
const config = require('../config');
const { pool } = require('../db');
const engine = require('./engine');
const notify = require('../services/notify');

let busyCheck = false;
let busySend = false;
let stopping = false;

async function check() {
  if (busyCheck || stopping) return;
  busyCheck = true;
  try {
    const s = await engine.runOnce();
    console.log(`[worker] ${new Date().toISOString()} devices=${s.devices} opened=${s.opened} updated=${s.updated} closed=${s.closed} errors=${s.errors}`);
  } catch (e) {
    console.error('[worker] check failed:', e.message);
  } finally { busyCheck = false; }
}

async function send() {
  if (busySend || stopping) return;
  busySend = true;
  try {
    const n = await notify.dispatchDue();
    if (n) console.log(`[worker] processed ${n} notification(s)`);
  } catch (e) {
    console.error('[worker] dispatch failed:', e.message);
  } finally { busySend = false; }
}

async function main() {
  if (process.argv.includes('--once')) {
    await check();
    await send();
    await pool.end();
    return;
  }
  console.log(`[worker] started: check every ${config.worker.intervalSeconds}s, offline after ${config.worker.offlineAfterMinutes} min`);
  await check();
  const t1 = setInterval(check, config.worker.intervalSeconds * 1000);
  const t2 = setInterval(send, config.notify.dispatchIntervalSeconds * 1000);
  const shutdown = async () => {
    stopping = true;
    clearInterval(t1); clearInterval(t2);
    await pool.end().catch(() => {});
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((e) => { console.error(e); process.exit(1); });

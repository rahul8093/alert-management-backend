// Notifications are queued in am_notification_outbox and sent by the dispatcher (worker),
// so a slow SMTP/Firebase never blocks the alert checks, and failures are retried.
const config = require('../config');
const { appQuery, A } = require('../db');
const users = require('./users');
const catalog = require('./catalog');

/** Push tokens of every active user who can see this plant. */
async function pushTargetsForPlant(plantId) {
  const tokens = await appQuery(`SELECT user_id, token FROM ${A('am_device_token')}`);
  const byUser = new Map();
  for (const t of tokens) {
    if (!byUser.has(t.user_id)) byUser.set(t.user_id, []);
    byUser.get(t.user_id).push(t.token);
  }
  const out = [];
  for (const [userId, list] of byUser) {
    const user = await users.getActiveUser(userId);
    if (!user) continue;
    const allowed = await catalog.allowedPlantIds(user);
    if (plantId === null || allowed.includes(Number(plantId))) out.push(...list);
  }
  return out;
}

async function queueForAlert(alert, title, body) {
  const data = JSON.stringify({
    alertId: String(alert.id),
    type: alert.alert_type,
    deviceId: alert.device_id,
    plantId: alert.plant_id === null ? '' : String(alert.plant_id),
  });
  const rows = [];
  for (const token of await pushTargetsForPlant(alert.plant_id)) rows.push(['push', token]);
  if (config.notify.smtp.host) for (const email of config.notify.alertEmails) rows.push(['email', email]);
  for (const [channel, target] of rows) {
    await appQuery(
      `INSERT INTO ${A('am_notification_outbox')} (alert_id, channel, target, title, body, data_json)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [alert.id, channel, target, title.slice(0, 200), body.slice(0, 2000), data],
    );
  }
  return rows.length;
}

// ---------- senders ----------
let mailer;
function getMailer() {
  if (mailer !== undefined) return mailer;
  const s = config.notify.smtp;
  if (!s.host) { mailer = null; return mailer; }
  const nodemailer = require('nodemailer');
  mailer = nodemailer.createTransport({
    host: s.host, port: s.port, secure: s.port === 465,
    auth: s.user ? { user: s.user, pass: s.password } : undefined,
  });
  return mailer;
}

let messaging;
function getMessaging() {
  if (messaging !== undefined) return messaging;
  if (!config.notify.firebaseServiceAccount) { messaging = null; return messaging; }
  try {
    const admin = require('firebase-admin');
    // eslint-disable-next-line import/no-dynamic-require
    const sa = require(require('path').resolve(config.notify.firebaseServiceAccount));
    admin.initializeApp({ credential: admin.credential.cert(sa) });
    messaging = admin.messaging();
  } catch (e) {
    console.error('[notify] Firebase not available:', e.message);
    messaging = null;
  }
  return messaging;
}

const MAX_ATTEMPTS = 5;

async function dispatchDue(limit = 50) {
  const due = await appQuery(
    `SELECT * FROM ${A('am_notification_outbox')}
      WHERE status = 'pending' AND next_attempt_at <= NOW()
      ORDER BY id LIMIT ?`, [limit]);
  for (const n of due) {
    try {
      if (n.channel === 'email') {
        const m = getMailer();
        if (!m) { await mark(n.id, 'skipped', 'SMTP not configured'); continue; }
        await m.sendMail({ from: config.notify.smtp.from, to: n.target, subject: n.title, text: n.body });
      } else {
        const fcm = getMessaging();
        if (!fcm) { await mark(n.id, 'skipped', 'Firebase not configured'); continue; }
        await fcm.send({
          token: n.target,
          notification: { title: n.title, body: n.body },
          data: n.data_json ? JSON.parse(n.data_json) : {},
          android: { priority: 'high' },
          apns: { payload: { aps: { sound: 'default' } } },
        });
      }
      await appQuery(`UPDATE ${A('am_notification_outbox')} SET status='sent', sent_at=NOW(), attempts=attempts+1 WHERE id=?`, [n.id]);
    } catch (e) {
      const code = e.code || e.errorInfo?.code || '';
      // Token no longer valid -> remove it, do not retry
      if (/registration-token-not-registered|invalid-registration-token|invalid-argument/.test(code)) {
        await appQuery(`DELETE FROM ${A('am_device_token')} WHERE token = ?`, [n.target]);
        await mark(n.id, 'failed', `${code} ${e.message}`);
        continue;
      }
      const attempts = n.attempts + 1;
      if (attempts >= MAX_ATTEMPTS) {
        await mark(n.id, 'failed', e.message, attempts);
      } else {
        const delayMin = 2 ** attempts; // 2, 4, 8, 16 minutes
        await appQuery(
          `UPDATE ${A('am_notification_outbox')}
              SET attempts=?, last_error=?, next_attempt_at = DATE_ADD(NOW(), INTERVAL ? MINUTE) WHERE id=?`,
          [attempts, String(e.message).slice(0, 1000), delayMin, n.id]);
      }
    }
  }
  return due.length;
}

async function mark(id, status, err, attempts) {
  await appQuery(
    `UPDATE ${A('am_notification_outbox')} SET status=?, last_error=?, attempts=COALESCE(?, attempts+1) WHERE id=?`,
    [status, err ? String(err).slice(0, 1000) : null, attempts ?? null, id]);
}

module.exports = { queueForAlert, dispatchDue };

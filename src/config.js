try { require('dotenv').config(); } catch { /* dotenv not installed - use real env vars */ }

const num = (v, d) => (v === undefined || v === '' ? d : Number(v));
const ident = (v, d) => {
  const s = v || d;
  if (!/^[A-Za-z0-9_]+$/.test(s)) throw new Error(`Invalid database name: ${s}`);
  return s;
};

const config = {
  port: num(process.env.PORT, 4000),
  corsOrigin: process.env.CORS_ORIGIN || '*',
  db: {
    host: process.env.DB_HOST || '127.0.0.1',
    port: num(process.env.DB_PORT, 3306),
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
  },
  srcDb: ident(process.env.SRC_DB, 'ptechview_cpcb'),
  appDb: ident(process.env.APP_DB, 'alert_app'),
  dataTzOffset: process.env.DATA_TZ_OFFSET || '+05:30',
  jwtSecret: process.env.JWT_SECRET || '',
  accessTokenMinutes: num(process.env.ACCESS_TOKEN_MINUTES, 15),
  refreshTokenDays: num(process.env.REFRESH_TOKEN_DAYS, 30),
  passwordHash: (process.env.PASSWORD_HASH || 'auto').toLowerCase(),
  adminRoleIds: (process.env.ADMIN_ROLE_IDS || '1,3').split(',').map((s) => Number(s.trim())).filter(Boolean),
  worker: {
    intervalSeconds: num(process.env.WORKER_INTERVAL_SECONDS, 60),
    offlineAfterMinutes: num(process.env.OFFLINE_AFTER_MINUTES, 120),
    warnRatio: num(process.env.WARN_RATIO, 0.9),
    maxAgeMinutes: num(process.env.ALERT_MAX_AGE_MINUTES, 120),
  },
  contact: {
    name: process.env.CONTACT_NAME || 'System Administrator',
    team: process.env.CONTACT_TEAM || 'Prashitech Solutions support',
    email: process.env.CONTACT_EMAIL || '',
    phone: process.env.CONTACT_PHONE || '',
  },
  notify: {
    dispatchIntervalSeconds: num(process.env.DISPATCH_INTERVAL_SECONDS, 10),
    smtp: {
      host: process.env.SMTP_HOST || '',
      port: num(process.env.SMTP_PORT, 587),
      user: process.env.SMTP_USER || '',
      password: process.env.SMTP_PASSWORD || '',
      from: process.env.SMTP_FROM || 'Alert Manager <alerts@example.com>',
    },
    alertEmails: (process.env.ALERT_EMAILS || '').split(',').map((s) => s.trim()).filter(Boolean),
    firebaseServiceAccount: process.env.FIREBASE_SERVICE_ACCOUNT || '',
  },
};

if (!config.jwtSecret || config.jwtSecret.startsWith('change-me')) {
  if (process.env.NODE_ENV === 'production') throw new Error('Set JWT_SECRET in .env');
  console.warn('[config] JWT_SECRET is not set - using an insecure development secret');
  config.jwtSecret = config.jwtSecret || 'dev-only-secret';
}

module.exports = config;

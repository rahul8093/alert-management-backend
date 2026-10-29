const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const config = require('../config');
const { appQuery, A } = require('../db');
const { HttpError } = require('../lib/http');
const { verifyPassword } = require('../lib/password');
const users = require('./users');

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

function signAccess(user) {
  return jwt.sign({ sub: user.userId, adm: user.isAdmin ? 1 : 0 }, config.jwtSecret, {
    expiresIn: `${config.accessTokenMinutes}m`,
  });
}

async function issueRefresh(userId, familyId = crypto.randomUUID()) {
  const token = crypto.randomBytes(48).toString('base64url');
  await appQuery(
    `INSERT INTO ${A('am_refresh_token')} (user_id, token_hash, family_id, expires_at)
     VALUES (?, ?, ?, DATE_ADD(NOW(), INTERVAL ? DAY))`,
    [userId, sha256(token), familyId, config.refreshTokenDays],
  );
  return token;
}

async function tokensFor(user, familyId) {
  return {
    accessToken: signAccess(user),
    accessTokenExpiresIn: config.accessTokenMinutes * 60,
    refreshToken: await issueRefresh(user.userId, familyId),
    user,
  };
}

async function login(username, password) {
  if (!username || !password) throw new HttpError(400, 'username and password are required');
  const name = String(username).trim();
  const row = await users.findForLogin(name);
  // The app always gets the same message; the server log says the real reason (never the password).
  let reason = null;
  if (!row) reason = 'no such user_id/email in m_user';
  else if (row.status !== 'A') reason = `user is inactive (m_user.status = '${row.status}')`;
  else if (!verifyPassword(String(password), row.password, config.passwordHash, row.user_id)) {
    const stored = String(row.password || '');
    const kind = /^[0-9a-f]{64}$/i.test(stored) ? '64 hex chars (SHA-256?)'
      : /^[0-9a-f]{40}$/i.test(stored) ? '40 hex chars (SHA-1?)'
        : /^[0-9a-f]{32}$/i.test(stored) ? '32 hex chars (MD5?)'
          : `${stored.length} chars, not hex`;
    reason = `wrong password (stored password is ${kind}, PASSWORD_HASH=${config.passwordHash})`;
  }
  if (reason) {
    console.warn(`[login] FAILED for "${name}": ${reason}`);
    throw new HttpError(401, 'Invalid username or password');
  }
  console.log(`[login] OK "${row.user_id}"`);
  const user = users.toPublicUser(row, await users.rolesFor(row.user_id, row.role_id));
  return tokensFor(user);
}

/** Rotating refresh tokens: each refresh token works once. Re-use of an old one = theft -> revoke family. */
async function refresh(refreshToken) {
  if (!refreshToken) throw new HttpError(400, 'refreshToken is required');
  const rows = await appQuery(
    `SELECT id, user_id, family_id, revoked_at, expires_at < NOW() AS expired
       FROM ${A('am_refresh_token')} WHERE token_hash = ?`,
    [sha256(refreshToken)],
  );
  const t = rows[0];
  if (!t) throw new HttpError(401, 'Invalid refresh token');
  if (t.revoked_at) {
    await appQuery(`UPDATE ${A('am_refresh_token')} SET revoked_at = NOW() WHERE family_id = ? AND revoked_at IS NULL`, [t.family_id]);
    throw new HttpError(401, 'Refresh token was already used - please log in again');
  }
  if (t.expired) throw new HttpError(401, 'Refresh token expired');

  const result = await appQuery(
    `UPDATE ${A('am_refresh_token')} SET revoked_at = NOW() WHERE id = ? AND revoked_at IS NULL`, [t.id]);
  if (!result.affectedRows) throw new HttpError(401, 'Refresh token was already used');

  const user = await users.getActiveUser(t.user_id);
  if (!user) throw new HttpError(401, 'User is inactive');
  return tokensFor(user, t.family_id);
}

async function logout(refreshToken) {
  if (!refreshToken) return;
  const rows = await appQuery(`SELECT family_id FROM ${A('am_refresh_token')} WHERE token_hash = ?`, [sha256(refreshToken)]);
  if (rows[0]) {
    await appQuery(`UPDATE ${A('am_refresh_token')} SET revoked_at = NOW() WHERE family_id = ? AND revoked_at IS NULL`, [rows[0].family_id]);
  }
}

async function logoutAll(userId) {
  await appQuery(`UPDATE ${A('am_refresh_token')} SET revoked_at = NOW() WHERE user_id = ? AND revoked_at IS NULL`, [userId]);
}

module.exports = { login, refresh, logout, logoutAll };

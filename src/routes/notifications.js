const router = require('express').Router();
const { appQuery, A } = require('../db');
const { asyncH, HttpError } = require('../lib/http');

// POST /api/notifications/device-token  { token, platform: 'android' | 'ios' }
// The mobile app calls this after login with its Firebase (FCM) token.
router.post('/device-token', asyncH(async (req, res) => {
  const token = req.body?.token ? String(req.body.token) : '';
  if (token.length < 10 || token.length > 512) throw new HttpError(400, 'token is required');
  const platform = req.body?.platform ? String(req.body.platform).slice(0, 20) : null;
  await appQuery(
    `INSERT INTO ${A('am_device_token')} (user_id, token, platform) VALUES (?, ?, ?)
     ON DUPLICATE KEY UPDATE user_id = VALUES(user_id), platform = VALUES(platform), last_seen_at = NOW()`,
    [req.user.userId, token, platform]);
  res.json({ ok: true });
}));

// DELETE /api/notifications/device-token  { token }   (call on logout)
router.delete('/device-token', asyncH(async (req, res) => {
  const token = req.body?.token ? String(req.body.token) : '';
  await appQuery(`DELETE FROM ${A('am_device_token')} WHERE token = ? AND user_id = ?`, [token, req.user.userId]);
  res.json({ ok: true });
}));

module.exports = router;

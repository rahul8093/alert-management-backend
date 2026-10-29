const router = require('express').Router();
const auth = require('../services/auth');
const { asyncH } = require('../lib/http');
const { requireAuth } = require('../middleware/auth');

// POST /api/auth/login  { username, password }   username = user_id or email from m_user
router.post('/login', asyncH(async (req, res) => {
  res.json(await auth.login(req.body?.username, req.body?.password));
}));

// POST /api/auth/refresh  { refreshToken }  -> new access + refresh token (old one stops working)
router.post('/refresh', asyncH(async (req, res) => {
  res.json(await auth.refresh(req.body?.refreshToken));
}));

// POST /api/auth/logout  { refreshToken }
router.post('/logout', asyncH(async (req, res) => {
  await auth.logout(req.body?.refreshToken);
  res.json({ ok: true });
}));

// POST /api/auth/logout-all  (signs out every device of this user)
router.post('/logout-all', requireAuth, asyncH(async (req, res) => {
  await auth.logoutAll(req.user.userId);
  res.json({ ok: true });
}));

// GET /api/auth/me
router.get('/me', requireAuth, (req, res) => {
  res.json({ user: req.user, plantIds: req.plantIds });
});

module.exports = router;

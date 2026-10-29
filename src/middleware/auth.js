const jwt = require('jsonwebtoken');
const config = require('../config');
const users = require('../services/users');
const catalog = require('../services/catalog');
const { HttpError } = require('../lib/http');

/** Requires "Authorization: Bearer <accessToken>". Sets req.user and req.plantIds. */
async function requireAuth(req, res, next) {
  try {
    const m = /^Bearer (.+)$/.exec(req.headers.authorization || '');
    if (!m) throw new HttpError(401, 'Missing access token');
    let payload;
    try {
      payload = jwt.verify(m[1], config.jwtSecret);
    } catch (e) {
      throw new HttpError(401, e.name === 'TokenExpiredError' ? 'Access token expired' : 'Invalid access token');
    }
    const user = await users.getActiveUser(payload.sub);
    if (!user) throw new HttpError(401, 'User is inactive');
    req.user = user;
    req.plantIds = await catalog.allowedPlantIds(user);
    next();
  } catch (e) { next(e); }
}

function requireAdmin(req, res, next) {
  if (!req.user?.isAdmin) return next(new HttpError(403, 'Admin only'));
  next();
}

module.exports = { requireAuth, requireAdmin };

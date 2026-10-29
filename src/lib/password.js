// m_user.password was written by the old portal. We only READ and compare it.
// Different systems store passwords differently, so several formats are supported.
// PASSWORD_HASH=auto tries them all; `npm run find-hash` tells you which one your data uses,
// then set that exact value in .env.
const crypto = require('crypto');
const config = require('../config');

const ALGOS = ['sha256', 'sha1', 'md5', 'sha512'];
const hash = (algo, text, enc) => crypto.createHash(algo).update(Buffer.from(text, enc)).digest();

/** Every supported format: name -> function(password, userId) returning candidate stored strings */
const FORMATS = {};
for (const algo of ALGOS) {
  for (const [encName, enc] of [['', 'utf8'], ['-utf16', 'utf16le']]) {
    const out = (buf) => [buf.toString('hex'), buf.toString('base64')];
    FORMATS[`${algo}${encName}`] = (p) => out(hash(algo, p, enc));
    // salted with the user id (before / after), as some portals do
    FORMATS[`${algo}${encName}-userid-before`] = (p, u) => (u ? [...out(hash(algo, u + p, enc)), ...out(hash(algo, String(u).toLowerCase() + p, enc))] : []);
    FORMATS[`${algo}${encName}-userid-after`] = (p, u) => (u ? [...out(hash(algo, p + u, enc)), ...out(hash(algo, p + String(u).toLowerCase(), enc))] : []);
  }
  FORMATS[`${algo}-double`] = (p) => {
    const once = hash(algo, p, 'utf8').toString('hex');
    return [hash(algo, once, 'utf8').toString('hex')];
  };
}
FORMATS.plain = (p) => [p];

function safeEqual(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
}

/** Returns the name of the format that matches, or null */
function matchFormat(plain, stored, userId, mode = 'auto') {
  if (!plain || !stored) return null;
  const s = String(stored).trim();
  const names = mode === 'auto' ? Object.keys(FORMATS) : [mode];
  for (const name of names) {
    const fn = FORMATS[name];
    if (!fn) continue;
    for (const c of fn(plain, userId)) {
      if (safeEqual(c, s) || safeEqual(c, s.toLowerCase())) return name;
    }
  }
  return null;
}

const verifyPassword = (plain, stored, mode = config.passwordHash, userId = null) => matchFormat(plain, stored, userId, mode) !== null;

module.exports = { verifyPassword, matchFormat, FORMATS };

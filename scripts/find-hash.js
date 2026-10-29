// Finds out how the old portal stored passwords in m_user.
// Usage: npm run find-hash   (asks for a user id and that user's REAL password; nothing is saved or printed)
const readline = require('readline');
const { pool, srcQuery, S } = require('../src/db');
const { matchFormat, FORMATS } = require('../src/lib/password');

function ask(question, hidden) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    if (hidden) {
      rl._writeToOutput = (s) => { if (s.includes(question)) rl.output.write(s); else rl.output.write('*'); };
    }
    rl.question(question, (a) => { rl.close(); if (hidden) process.stdout.write('\n'); resolve(a); });
  });
}

(async () => {
  const userId = (await ask('User ID (e.g. Dinesh): ')).trim();
  const rows = await srcQuery(`SELECT user_id, password, status FROM ${S('m_user')} WHERE user_id = ?`, [userId]);
  if (!rows.length) { console.log(`No user "${userId}" in m_user.`); return; }
  const stored = String(rows[0].password || '');
  console.log(`Found ${rows[0].user_id} (status ${rows[0].status}). Stored password: ${stored.length} characters, starts with "${stored.slice(0, 4)}..."`);
  const password = await ask('Real password: ', true);
  const found = matchFormat(password, stored, rows[0].user_id, 'auto');
  if (found) {
    console.log(`\nMATCH: the portal uses "${found}".`);
    console.log(`Put this line in .env and restart the backend:\n\n  PASSWORD_HASH=${found}\n`);
  } else {
    console.log(`\nNo match among ${Object.keys(FORMATS).length} known formats.`);
    console.log('Either the password is mistyped, or the portal uses a secret key/salt we do not have.');
    console.log('Ask the portal developer: "How is m_user.password hashed?" and share the answer.');
  }
})().catch((e) => console.error(e.message)).finally(() => pool.end());

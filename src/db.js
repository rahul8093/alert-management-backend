const mysql = require('mysql2/promise');
const config = require('./config');

// One pool, no default database: every query names its database explicitly.
const pool = mysql.createPool({
  ...config.db,
  waitForConnections: true,
  connectionLimit: 10,
  dateStrings: true, // keep DATETIME as 'YYYY-MM-DD HH:mm:ss' (IST) - no timezone surprises
  decimalNumbers: true,
  charset: 'utf8mb4',
});

/** Fully-qualified name of a table in the existing (read-only) database. */
const S = (table) => `\`${config.srcDb}\`.\`${table}\``;
/** Fully-qualified name of a table in this app's own database. */
const A = (table) => `\`${config.appDb}\`.\`${table}\``;

const READ_ONLY = /^\s*(\(\s*)*(select|with|show|describe|explain)\b/i;

/**
 * Query that touches the existing database. Only SELECT-style statements are allowed,
 * so this app can never change ptechview_cpcb even by mistake.
 */
async function srcQuery(sql, params = []) {
  if (!READ_ONLY.test(sql)) throw new Error('srcQuery only allows SELECT statements');
  const [rows] = await pool.query(sql, params);
  return rows;
}

/** Query on this app's own database (may write). Must not reference SRC_DB for writing. */
async function appQuery(sql, params = []) {
  if (!READ_ONLY.test(sql) && sql.includes(`\`${config.srcDb}\``)) {
    throw new Error('Refusing to write to the source database');
  }
  const [rows] = await pool.query(sql, params);
  return rows;
}

module.exports = { pool, srcQuery, appQuery, S, A };

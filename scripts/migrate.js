// Creates APP_DB (if missing) and runs every migrations/*.sql file once.
// It never touches SRC_DB.
const fs = require('fs');
const path = require('path');
const mysql = require('mysql2/promise');
const config = require('../src/config');

(async () => {
  if (config.appDb === config.srcDb) {
    console.error('APP_DB must be different from SRC_DB - this app never writes to the source database.');
    process.exit(1);
  }
  const conn = await mysql.createConnection({ ...config.db, multipleStatements: true });
  try {
    await conn.query(`CREATE DATABASE IF NOT EXISTS \`${config.appDb}\` CHARACTER SET utf8mb4`);
    await conn.query(`CREATE TABLE IF NOT EXISTS \`${config.appDb}\`.am_migrations (
      name VARCHAR(200) PRIMARY KEY, run_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP)`);
    const [doneRows] = await conn.query(`SELECT name FROM \`${config.appDb}\`.am_migrations`);
    const done = new Set(doneRows.map((r) => r.name));

    const dir = path.join(__dirname, '..', 'migrations');
    const files = fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
    for (const file of files) {
      if (done.has(file)) { console.log(`skip  ${file}`); continue; }
      const sql = fs.readFileSync(path.join(dir, file), 'utf8').replaceAll('{{APP_DB}}', config.appDb);
      if (sql.includes(`\`${config.srcDb}\``)) throw new Error(`${file} references SRC_DB - not allowed`);
      await conn.query(sql);
      await conn.query(`INSERT INTO \`${config.appDb}\`.am_migrations (name) VALUES (?)`, [file]);
      console.log(`ran   ${file}`);
    }
    console.log(`Done. App tables are in database "${config.appDb}".`);
  } finally {
    await conn.end();
  }
})().catch((e) => { console.error('Migration failed:', e.message); process.exit(1); });

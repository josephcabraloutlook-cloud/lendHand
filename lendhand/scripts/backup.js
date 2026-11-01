// Consistent online backup of the SQLite database. Schedule it (cron / platform job) and copy the file off the server.
import fs from 'node:fs';
import path from 'node:path';
import { config, ROOT } from '../lib/config.js';
import { openDb } from '../lib/db.js';

const dir = path.resolve(ROOT, process.env.BACKUP_DIR || 'backups');
const keep = parseInt(process.env.BACKUP_KEEP || '14', 10);
fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
const db = openDb(config.databasePath);
const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+/, '').replace('T', '-');
const target = path.join(dir, `lendhand-${stamp}.db`);
db.exec(`VACUUM INTO '${target.replace(/'/g, "''")}'`);
fs.chmodSync(target, 0o600);
db.close();
const files = fs.readdirSync(dir).filter((f) => /^lendhand-.*\.db$/.test(f)).sort();
for (const f of files.slice(0, Math.max(0, files.length - keep))) fs.rmSync(path.join(dir, f));
console.log(`Backup written: ${target}`);
console.log('Backups contain personal data. Store them encrypted and delete old copies in line with your retention period.');

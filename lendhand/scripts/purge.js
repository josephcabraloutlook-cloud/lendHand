// Run the retention clean-up on demand (the server also does this automatically every few hours).
import { config } from '../lib/config.js';
import { openDb } from '../lib/db.js';
import { purgeExpired } from '../lib/candidates.js';
const db = openDb(config.databasePath);
console.log(`Removed ${purgeExpired(db, config.retentionDays)} record(s) older than ${config.retentionDays} days (Onboarded records are kept).`);
db.close();

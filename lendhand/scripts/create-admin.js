// Create or reset an admin / recruiter account.
//   npm run create-admin                       (interactive, password hidden)
//   npm run create-admin -- --reset you@x.com  (reset an existing password)
//   ADMIN_EMAIL=... ADMIN_PASSWORD=... ADMIN_ROLE=admin npm run create-admin   (non-interactive)
import readline from 'node:readline';
import { config } from '../lib/config.js';
import { openDb, audit } from '../lib/db.js';
import { createUser, hashPassword, passwordProblem } from '../lib/auth.js';

function ask(question, { hidden = false } = {}) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    if (hidden) {
      rl._writeToOutput = (s) => {
        if (s.includes(question)) rl.output.write(s);
        else rl.output.write('');
      };
    }
    rl.question(question, (answer) => {
      rl.close();
      if (hidden) process.stdout.write('\n');
      resolve(answer);
    });
  });
}

const db = openDb(config.databasePath);
const args = process.argv.slice(2);
const resetIdx = args.indexOf('--reset');
const interactive = process.stdin.isTTY;

try {
  const email = (resetIdx >= 0 ? args[resetIdx + 1] : process.env.ADMIN_EMAIL) || (interactive ? await ask('Email address: ') : '');
  if (!email) throw new Error('An email address is required.');
  let password = process.env.ADMIN_PASSWORD;
  if (!password) {
    if (!interactive) throw new Error('Set ADMIN_PASSWORD, or run this in a terminal.');
    password = await ask('Password (12+ characters, hidden): ', { hidden: true });
    const again = await ask('Repeat password: ', { hidden: true });
    if (password !== again) throw new Error('The passwords did not match.');
  }

  if (resetIdx >= 0) {
    const problem = passwordProblem(password);
    if (problem) throw new Error(problem);
    const r = db.prepare('UPDATE users SET password_hash = ?, disabled = 0 WHERE email = ?').run(await hashPassword(password), email.trim().toLowerCase());
    if (!Number(r.changes)) throw new Error('No account with that email.');
    db.prepare('DELETE FROM sessions WHERE user_id IN (SELECT id FROM users WHERE email = ?)').run(email.trim().toLowerCase());
    audit(db, 'cli', 'password_reset', email);
    console.log(`Password updated for ${email}. Existing sessions were signed out.`);
  } else {
    const role = (process.env.ADMIN_ROLE || (interactive ? await ask('Role [admin/recruiter] (admin): ') : '') || 'admin').trim();
    const made = await createUser(db, email, password, role);
    audit(db, 'cli', 'user_created', made, role);
    console.log(`Created ${role} account: ${made}`);
  }
} catch (err) {
  console.error(`\nCould not complete: ${/UNIQUE/.test(err.message) ? 'an account with that email already exists (use --reset to change its password).' : err.message}`);
  process.exitCode = 1;
}
db.close();

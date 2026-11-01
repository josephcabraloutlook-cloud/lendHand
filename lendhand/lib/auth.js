import crypto from 'node:crypto';
import { promisify } from 'node:util';
import { sha256, createLimiter } from './security.js';

const scrypt = promisify(crypto.scrypt);
const N = 16384;
const R = 8;
const P = 1;

export const SESSION_ABSOLUTE_MS = 12 * 60 * 60 * 1000;
export const SESSION_IDLE_MS = 2 * 60 * 60 * 1000;
export const SESSION_COOKIE = 'lh_admin';

export async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const key = await scrypt(password, salt, 64, { N, r: R, p: P, maxmem: 64 * 1024 * 1024 });
  return `scrypt$${N}$${R}$${P}$${salt.toString('base64')}$${key.toString('base64')}`;
}

export async function verifyPassword(password, stored) {
  const parts = String(stored).split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [, n, r, p, saltB64, keyB64] = parts;
  const salt = Buffer.from(saltB64, 'base64');
  const expected = Buffer.from(keyB64, 'base64');
  const key = await scrypt(password, salt, expected.length, { N: +n, r: +r, p: +p, maxmem: 64 * 1024 * 1024 });
  return crypto.timingSafeEqual(key, expected);
}

let dummyHash;
async function getDummyHash() {
  dummyHash ||= await hashPassword(crypto.randomBytes(12).toString('hex'));
  return dummyHash;
}

export function passwordProblem(pw) {
  if (typeof pw !== 'string' || pw.length < 12) return 'Use at least 12 characters.';
  if (pw.length > 200) return 'That password is too long.';
  if (/^(.)\1+$/.test(pw)) return 'That password is too simple.';
  return null;
}

// Throttle sign-in attempts: per IP and per account.
const ipLimiter = createLimiter({ windowMs: 15 * 60 * 1000, max: 20 });
const accountLimiter = createLimiter({ windowMs: 15 * 60 * 1000, max: 5 });

export async function login(db, email, password, ip) {
  const emailKey = String(email || '').trim().toLowerCase();
  if (ipLimiter.hit(ip).allowed === false) return { error: 'locked', retryAfter: ipLimiter.retryAfter(ip) };
  if (accountLimiter.count(emailKey) >= 5) return { error: 'locked', retryAfter: accountLimiter.retryAfter(emailKey) };

  const user = emailKey ? db.prepare('SELECT * FROM users WHERE email = ?').get(emailKey) : null;
  const hash = user && !user.disabled ? user.password_hash : await getDummyHash();
  const ok = await verifyPassword(String(password || ''), hash);
  if (!user || user.disabled || !ok) {
    accountLimiter.hit(emailKey);
    return { error: 'invalid' };
  }
  accountLimiter.clear(emailKey);
  db.prepare('UPDATE users SET last_login_at = ? WHERE id = ?').run(new Date().toISOString(), user.id);
  return { user };
}

export function createSession(db, userId) {
  const token = crypto.randomBytes(32).toString('base64url');
  const csrf = crypto.randomBytes(24).toString('base64url');
  const now = Date.now();
  db.prepare('INSERT INTO sessions (id_hash, user_id, csrf, created_at, last_seen_at, expires_at) VALUES (?,?,?,?,?,?)').run(
    sha256(token),
    userId,
    csrf,
    now,
    now,
    now + SESSION_ABSOLUTE_MS
  );
  return { token, csrf };
}

export function getSession(db, token) {
  if (!token || typeof token !== 'string' || token.length > 100) return null;
  const now = Date.now();
  const row = db
    .prepare(
      `SELECT s.id_hash, s.csrf, s.last_seen_at, s.expires_at, u.id AS user_id, u.email, u.role, u.disabled
       FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.id_hash = ?`
    )
    .get(sha256(token));
  if (!row) return null;
  if (row.disabled || row.expires_at <= now || now - row.last_seen_at > SESSION_IDLE_MS) {
    db.prepare('DELETE FROM sessions WHERE id_hash = ?').run(row.id_hash);
    return null;
  }
  if (now - row.last_seen_at > 60_000) {
    db.prepare('UPDATE sessions SET last_seen_at = ? WHERE id_hash = ?').run(now, row.id_hash);
  }
  return { idHash: row.id_hash, csrf: row.csrf, user: { id: row.user_id, email: row.email, role: row.role } };
}

export function destroySession(db, token) {
  if (token) db.prepare('DELETE FROM sessions WHERE id_hash = ?').run(sha256(token));
}

export function pruneSessions(db) {
  db.prepare('DELETE FROM sessions WHERE expires_at <= ? OR last_seen_at <= ?').run(Date.now(), Date.now() - SESSION_IDLE_MS);
}

export async function createUser(db, email, password, role = 'recruiter') {
  const clean = String(email).trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(clean)) throw new Error('That does not look like a valid email address.');
  const problem = passwordProblem(password);
  if (problem) throw new Error(problem);
  if (!['admin', 'recruiter'].includes(role)) throw new Error('Role must be admin or recruiter.');
  const hash = await hashPassword(password);
  db.prepare('INSERT INTO users (email, password_hash, role, created_at) VALUES (?,?,?,?)').run(clean, hash, role, new Date().toISOString());
  return clean;
}

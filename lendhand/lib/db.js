import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

const SCHEMA_VERSION = 1;

export function openDb(file) {
  if (file !== ':memory:') {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  }
  const db = new DatabaseSync(file);
  // secure_delete overwrites deleted rows so erasure requests really remove the data from the file.
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000; PRAGMA secure_delete = ON;');
  migrate(db);
  if (file !== ':memory:') {
    for (const f of [file, `${file}-wal`, `${file}-shm`]) {
      try {
        fs.chmodSync(f, 0o600);
      } catch {
        /* file may not exist yet */
      }
    }
  }
  return db;
}

function migrate(db) {
  const { user_version: current } = db.prepare('PRAGMA user_version').get();
  if (current >= SCHEMA_VERSION) return;
  db.exec('BEGIN');
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS candidates (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ref TEXT NOT NULL UNIQUE,
        job_slug TEXT NOT NULL,
        full_name TEXT NOT NULL,
        phone TEXT NOT NULL,
        area TEXT NOT NULL,
        right_to_work TEXT,
        answers TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'new',
        notes TEXT NOT NULL DEFAULT '',
        notice_version TEXT NOT NULL,
        privacy_ack_at TEXT NOT NULL,
        updates_opt_in INTEGER NOT NULL DEFAULT 0,
        whatsapp_opt_in INTEGER NOT NULL DEFAULT 0,
        clarification_requested_at TEXT,
        receipt_hash TEXT,
        source TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_candidates_status ON candidates(status);
      CREATE INDEX IF NOT EXISTS idx_candidates_created ON candidates(created_at);
      CREATE INDEX IF NOT EXISTS idx_candidates_phone ON candidates(phone, job_slug);

      CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        email TEXT NOT NULL UNIQUE COLLATE NOCASE,
        password_hash TEXT NOT NULL,
        role TEXT NOT NULL DEFAULT 'recruiter' CHECK (role IN ('admin','recruiter')),
        disabled INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        last_login_at TEXT
      );

      CREATE TABLE IF NOT EXISTS sessions (
        id_hash TEXT PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        csrf TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        last_seen_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS audit_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        at TEXT NOT NULL,
        actor TEXT,
        action TEXT NOT NULL,
        target TEXT,
        detail TEXT
      );
    `);
    db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

const REF_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
export function newRef() {
  let s = 'LH-';
  for (let i = 0; i < 6; i++) s += REF_ALPHABET[crypto.randomInt(REF_ALPHABET.length)];
  return s;
}

export function audit(db, actor, action, target = null, detail = null) {
  db.prepare('INSERT INTO audit_log (at, actor, action, target, detail) VALUES (?,?,?,?,?)').run(
    new Date().toISOString(),
    actor,
    action,
    target,
    detail
  );
}

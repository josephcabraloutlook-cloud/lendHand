// End-to-end API tests. Starts the real server on a temporary database and talks to it over HTTP.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalisePhone } from '../lib/jobs.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 3200 + Math.floor(Math.random() * 500);
const BASE = `http://localhost:${PORT}`;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lendhand-test-'));
const env = {
  ...process.env,
  PORT: String(PORT),
  SITE_URL: BASE,
  DATABASE_PATH: path.join(dir, 'test.db'),
  WHATSAPP_INVITE_URL: 'https://chat.whatsapp.com/TESTINVITE123',
  RETENTION_DAYS: '30',
  NODE_ENV: 'development',
};
let server;
let adminCookie = '';
let adminCsrf = '';
let recCookie = '';
let recCsrf = '';
let formToken;

const base = { full_name: 'Alex Morgan', phone: '07700 900123', area: 'Bath', right_to_work: 'yes', licence: 'yes', vehicle: 'own_car', experience: 'yes', start: 'immediately', days: ['weekdays', 'weekends'] };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const post = (url, body, headers = {}) => fetch(BASE + url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
const apply = (answers, consent = { privacy: true }, extra = {}) => post('/api/apply/delivery-driver', { answers, consent, token: formToken, website: '', ...extra });
const admin = (url, init = {}, who = 'admin') =>
  fetch(BASE + url, { ...init, headers: { cookie: who === 'admin' ? adminCookie : recCookie, 'x-csrf-token': who === 'admin' ? adminCsrf : recCsrf, 'content-type': 'application/json', ...(init.headers || {}) } });

async function signIn(email, password) {
  const res = await post('/api/admin/login', { email, password });
  assert.equal(res.status, 200);
  const cookie = res.headers.get('set-cookie').split(';')[0];
  const { csrf } = await res.json();
  return { cookie, csrf };
}

before(async () => {
  const mk = (email, password, role) => spawnSync('node', ['--disable-warning=ExperimentalWarning', 'scripts/create-admin.js'], { cwd: ROOT, env: { ...env, ADMIN_EMAIL: email, ADMIN_PASSWORD: password, ADMIN_ROLE: role }, stdio: 'ignore' });
  assert.equal(mk('boss@example.test', 'a-long-test-passphrase', 'admin').status, 0);
  assert.equal(mk('staff@example.test', 'another-test-passphrase', 'recruiter').status, 0);
  server = spawn('node', ['--disable-warning=ExperimentalWarning', 'server.js'], { cwd: ROOT, env, stdio: 'ignore' });
  for (let i = 0; i < 50; i++) {
    try {
      if ((await fetch(BASE + '/api/health')).ok) break;
    } catch {
      await sleep(100);
    }
  }
  formToken = (await (await fetch(BASE + '/api/jobs/delivery-driver')).json()).token;
  await sleep(5200); // the form must have been open for a few seconds to count as human
});

after(() => {
  server?.kill();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('UK and international phone numbers are normalised and validated', () => {
  for (const ok of ['07700 900123', '+44 7700 900123', '0044 7700 900123', '7700900123', '+44 (0)7700 900123']) assert.equal(normalisePhone(ok), '+447700900123', ok);
  assert.equal(normalisePhone('+1 415 555 0132'), '+14155550132');
  for (const bad of ['', '12345', '01225 123456', '07012 345678', 'abc', '+44 7700 9001', '0770090012345']) assert.equal(normalisePhone(bad), null, bad);
});

test('public pages render and the privacy notice is flagged as a draft until confirmed', async () => {
  for (const p of ['/', '/apply', '/privacy']) assert.equal((await fetch(BASE + p)).status, 200, p);
  const privacy = await (await fetch(BASE + '/privacy')).text();
  assert.match(privacy, /Draft notice/);
  assert.match(privacy, /Not set: add CONTROLLER_NAME/);
  const home = await fetch(BASE + '/');
  assert.match(await home.text(), /Looking for Delivery Work in Bath\?/);
  assert.match(home.headers.get('content-security-policy'), /default-src 'self'/);
  assert.equal((await fetch(BASE + '/views/index.html')).status, 404);
  assert.equal((await fetch(BASE + '/%2e%2e/package.json')).status, 404);
  assert.equal((await fetch(BASE + '/apply/not-a-job')).status, 404);
});

test('registration: validation errors are specific and nothing is stored', async () => {
  const res = await apply({ full_name: 'x', phone: '123', area: '<b>' }, {});
  assert.equal(res.status, 422);
  const body = await res.json();
  assert.ok(body.fields.full_name && body.fields.phone && body.fields.area && body.fields.privacy);
  const unauth = await admin('/api/admin/candidates');
  assert.equal(unauth.status, 401);
});

test('registration: spam protections', async () => {
  const hp = await apply(base, { privacy: true }, { website: 'http://spam.example' });
  assert.equal(hp.status, 201); // looks like success to the bot
  assert.equal((await hp.json()).ref, null);
  const noToken = await post('/api/apply/delivery-driver', { answers: base, consent: { privacy: true } });
  assert.equal(noToken.status, 400);
  const fast = await fetch(BASE + '/api/jobs/delivery-driver').then((r) => r.json());
  const tooFast = await post('/api/apply/delivery-driver', { answers: base, consent: { privacy: true }, token: fast.token });
  assert.equal((await tooFast.json()).code, 'too_fast');
  const origin = await post('/api/apply/delivery-driver', { answers: base, consent: { privacy: true }, token: formToken }, { origin: 'https://evil.example' });
  assert.equal(origin.status, 403);
});

test('registration: success, WhatsApp only when opted in, duplicates are not stored twice', async () => {
  const none = await apply(base, { privacy: true, updates: false, whatsapp: false });
  assert.equal(none.status, 201);
  const a = await none.json();
  assert.match(a.ref, /^LH-[A-Z0-9]{6}$/);
  assert.equal(a.outcome.whatsapp.url, null, 'no invite without opt-in');

  const dupe = await (await apply(base, { privacy: true, whatsapp: true })).json();
  assert.equal(dupe.ref, null, 'same number again is not stored twice');
  assert.equal(dupe.outcome.whatsapp.url, 'https://chat.whatsapp.com/TESTINVITE123', 'opt-in shows the invite from config');
});

test('right to work: "No" never receives the group invite, "Not sure" can ask for clarification', async () => {
  const no = await (await apply({ ...base, phone: '07700 900200', right_to_work: 'no' }, { privacy: true, whatsapp: true })).json();
  assert.equal(no.outcome.whatsapp.eligible, false);
  assert.equal(no.outcome.whatsapp.url, null);

  const unsure = await (await apply({ ...base, phone: '07700 900201', full_name: 'Sam Rivers', area: 'Keynsham', right_to_work: 'unsure', vehicle: 'company_van', start: '2_weeks', days: ['weekends'] }, { privacy: true, updates: true })).json();
  assert.equal(unsure.outcome.canRequestClarification, true);
  const bad = await post('/api/clarify', { ref: unsure.ref, receipt: 'wrong' });
  assert.equal(bad.status, 400);
  const good = await post('/api/clarify', { ref: unsure.ref, receipt: unsure.receipt });
  assert.equal(good.status, 200);
});

test('admin: sign-in, CSRF, roles', async () => {
  const wrong = await post('/api/admin/login', { email: 'boss@example.test', password: 'nope-nope-nope' });
  assert.equal(wrong.status, 401);
  ({ cookie: adminCookie, csrf: adminCsrf } = await signIn('boss@example.test', 'a-long-test-passphrase'));
  ({ cookie: recCookie, csrf: recCsrf } = await signIn('staff@example.test', 'another-test-passphrase'));

  const list = await (await admin('/api/admin/candidates')).json();
  assert.equal(list.total, 3, 'bot and repeat submissions are not stored');
  const first = list.items[0];
  const noCsrf = await fetch(BASE + `/api/admin/candidates/${first.id}`, { method: 'PATCH', headers: { cookie: adminCookie, 'content-type': 'application/json' }, body: JSON.stringify({ status: 'contacted' }) });
  assert.equal(noCsrf.status, 403);
  assert.equal((await admin('/api/admin/export.csv', {}, 'rec')).status, 403, 'recruiters cannot export');
  assert.equal((await admin(`/api/admin/candidates/${first.id}`, { method: 'DELETE' }, 'rec')).status, 403, 'recruiters cannot delete');
});

test('admin: filters, status updates, notes, CSV export, delete', async () => {
  const q = async (qs) => (await (await admin('/api/admin/candidates?' + qs)).json());
  assert.equal((await q('location=keyns')).total, 1);
  assert.equal((await q('vehicle=company_van')).total, 1);
  assert.equal((await q('start=immediately')).total, 2);
  assert.equal((await q('days=both')).total, 2);
  assert.equal((await q('days=weekends')).total, 3);
  assert.equal((await q('flag=clarify')).total, 1);
  assert.equal((await q("q=%25")).total, 0, 'LIKE wildcards are escaped');
  assert.equal((await q("location=' OR 1=1 --")).total, 0, 'SQL is parameterised');

  const target = (await q('location=keynsham')).items[0];
  assert.equal(target.rightToWork, 'unsure');
  const upd = await admin(`/api/admin/candidates/${target.id}`, { method: 'PATCH', body: JSON.stringify({ status: 'under_review', notes: '=HYPERLINK("x")\nCall back after 5pm' }) }, 'rec');
  assert.equal(upd.status, 200);
  assert.equal((await upd.json()).status, 'under_review');
  assert.equal((await admin(`/api/admin/candidates/${target.id}`, { method: 'PATCH', body: JSON.stringify({ status: 'hired!' }) })).status, 400);

  const csvRes = await admin('/api/admin/export.csv?status=under_review');
  assert.equal(csvRes.status, 200);
  assert.match(csvRes.headers.get('content-disposition'), /attachment; filename="lendhand-candidates-\d{4}-\d{2}-\d{2}\.csv"/);
  const csv = await csvRes.text();
  assert.match(csv, /Sam Rivers/);
  assert.match(csv, /'=HYPERLINK/, 'formula injection is neutralised');
  assert.doesNotMatch(csv, /Alex Morgan/, 'export respects the filters');

  const del = await admin(`/api/admin/candidates/${target.id}`, { method: 'DELETE' });
  assert.equal(del.status, 200);
  assert.equal((await admin(`/api/admin/candidates/${target.id}`)).status, 404);
  assert.equal((await q('')).total, 2);
});

test('admin: sign-out ends the session and repeated bad passwords lock the account', async () => {
  const s = await signIn('staff@example.test', 'another-test-passphrase');
  const out = await fetch(BASE + '/api/admin/logout', { method: 'POST', headers: { cookie: s.cookie, 'x-csrf-token': s.csrf } });
  assert.equal(out.status, 200);
  assert.equal((await fetch(BASE + '/api/admin/me', { headers: { cookie: s.cookie } })).status, 401);

  let last;
  for (let i = 0; i < 6; i++) last = await post('/api/admin/login', { email: 'staff@example.test', password: 'wrong-wrong-wrong' });
  assert.equal(last.status, 429);
  const stillLocked = await post('/api/admin/login', { email: 'staff@example.test', password: 'another-test-passphrase' });
  assert.equal(stillLocked.status, 429, 'even the right password waits out the lockout');
});

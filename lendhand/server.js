// LendHand recruitment site: public site, candidate API and admin API in one dependency-free Node process.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { config, ROOT, configStatus } from './lib/config.js';
import { openDb, audit, newRef } from './lib/db.js';
import { JOBS, STATUSES, getJob, publicField, validateAnswers } from './lib/jobs.js';
import {
  createLimiter, clientIp, mintFormToken, checkFormToken, newReceipt, sha256, safeEqual,
  parseCookies, serializeCookie, securityHeaders,
} from './lib/security.js';
import { login, createSession, getSession, destroySession, pruneSessions, createUser, SESSION_COOKIE, SESSION_ABSOLUTE_MS } from './lib/auth.js';
import { listCandidates, getCandidate, updateCandidate, deleteCandidate, exportCsv, purgeExpired } from './lib/candidates.js';
import { HttpError, sendJson, sendText, readJson, serveStatic, escapeHtml } from './lib/http.js';

const PUBLIC_DIR = path.join(ROOT, 'public');
const VIEWS_DIR = path.join(ROOT, 'views');
const db = openDb(config.databasePath);
const COOKIE_NAME = config.secureCookies ? `__Host-${SESSION_COOKIE}` : SESSION_COOKIE;

const applyLimiter = createLimiter({ windowMs: 60 * 60 * 1000, max: 8 });
const clarifyLimiter = createLimiter({ windowMs: 60 * 60 * 1000, max: 10 });
const readLimiter = createLimiter({ windowMs: 60 * 1000, max: 120 });

// ---------- page templates ----------
const viewCache = new Map();
function readView(name) {
  const file = path.join(VIEWS_DIR, name);
  const mtime = fs.statSync(file).mtimeMs;
  const hit = viewCache.get(name);
  if (hit && hit.mtime === mtime) return hit.text;
  const text = fs.readFileSync(file, 'utf8');
  viewCache.set(name, { mtime, text });
  return text;
}

function placeholder(name) {
  return `<span class="todo">[Not set: add ${escapeHtml(name)} to your configuration]</span>`;
}

function renderView(name, extra = {}) {
  const contact = config.contactEmail
    ? `<a href="mailto:${escapeHtml(config.contactEmail)}">${escapeHtml(config.contactEmail)}</a>`
    : placeholder('CONTACT_EMAIL');
  const vars = {
    SITE_URL: escapeHtml(config.siteUrl),
    YEAR: String(new Date().getFullYear()),
    FOOTER_CONTACT: config.contactEmail
      ? `<a href="mailto:${escapeHtml(config.contactEmail)}">Contact us</a>`
      : '',
    CONTROLLER: config.controllerName ? escapeHtml(config.controllerName) : placeholder('CONTROLLER_NAME'),
    CONTACT: contact,
    ICO_LINE: config.icoNumber
      ? `<p>Our ICO registration number is ${escapeHtml(config.icoNumber)}.</p>`
      : '',
    RETENTION_DAYS: String(config.retentionDays),
    NOTICE_VERSION: escapeHtml(config.noticeVersion),
    DRAFT_BANNER: config.noticeConfirmed
      ? ''
      : '<div class="draft-banner" role="note"><strong>Draft notice.</strong> This Privacy Notice has not yet been reviewed and confirmed by LendHand. Details marked in amber still need completing before launch.</div>',
    ...extra,
  };
  return readView(name).replace(/\{\{([A-Z_]+)\}\}/g, (_, k) => (k in vars ? vars[k] : ''));
}

function sendPage(res, name, status = 200, headers = {}) {
  sendText(res, status, renderView(name), 'text/html; charset=utf-8', { 'Cache-Control': 'no-cache', ...headers });
}

// ---------- routing ----------
const routes = [];
function route(method, pattern, handler, opts = {}) {
  routes.push({ method, re: new RegExp(`^${pattern}$`), handler, opts });
}

function sameOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return true;
  try {
    const o = new URL(origin);
    return o.host === req.headers.host || o.host === new URL(config.siteUrl).host;
  } catch {
    return false;
  }
}

function adminAuth(ctx, { role } = {}) {
  const { req } = ctx;
  const token = parseCookies(req.headers.cookie)[COOKIE_NAME];
  const session = getSession(db, token);
  if (!session) throw new HttpError(401, 'Please sign in.');
  if (!['GET', 'HEAD'].includes(req.method)) {
    if (!sameOrigin(req)) throw new HttpError(403, 'Request blocked.');
    if (!safeEqual(req.headers['x-csrf-token'] || '', session.csrf)) throw new HttpError(403, 'Your session needs refreshing. Please reload the page.');
  }
  if (role === 'admin' && session.user.role !== 'admin') throw new HttpError(403, 'Only an admin can do that.');
  ctx.session = session;
  ctx.actor = session.user.email;
  return session;
}

// ----- public API -----
route('GET', '/api/health', (ctx) => {
  db.prepare('SELECT 1').get();
  sendJson(ctx.res, 200, { ok: true });
});

route('GET', '/api/jobs', (ctx) => {
  sendJson(ctx.res, 200, { jobs: JOBS.filter((j) => j.active).map((j) => ({ slug: j.slug, title: j.title, area: j.area })) });
});

route('GET', '/api/jobs/([a-z0-9-]+)', (ctx) => {
  const job = getJob(ctx.params[0]);
  if (!job) throw new HttpError(404, 'That opportunity is not open for applications.');
  sendJson(ctx.res, 200, {
    slug: job.slug,
    title: job.title,
    area: job.area,
    fields: job.fields.map(publicField),
    noticeVersion: config.noticeVersion,
    token: mintFormToken(config.secret),
  });
});

const fakeOutcome = { rightToWork: 'yes', whatsapp: { requested: false, eligible: false, configured: false, url: null }, canRequestClarification: false };

route('POST', '/api/apply/([a-z0-9-]+)', async (ctx) => {
  const { req, res } = ctx;
  const job = getJob(ctx.params[0]);
  if (!job) throw new HttpError(404, 'That opportunity is not open for applications.');
  if (!sameOrigin(req)) throw new HttpError(403, 'Request blocked.');

  const rl = applyLimiter.hit(ctx.ip);
  if (!rl.allowed) throw new HttpError(429, 'We have had a lot of submissions from your connection. Please try again later.', { retryAfter: rl.retryAfter });

  const body = await readJson(req);

  // Honeypot: real people never see or fill this field. Pretend it worked so bots learn nothing.
  if (typeof body.website === 'string' && body.website.trim() !== '') {
    return sendJson(res, 201, { ok: true, ref: null, receipt: null, outcome: fakeOutcome });
  }

  const tok = checkFormToken(config.secret, body.token);
  if (!tok.ok || tok.age > 6 * 3600 * 1000) throw new HttpError(400, 'This page has been open for a while. Please refresh it and try again.', { code: 'token' });
  if (tok.age < 5000) throw new HttpError(400, 'That was very quick! Please check your answers and try again.', { code: 'too_fast' });

  const { values, errors, ok } = validateAnswers(job, body.answers);
  const consent = body.consent && typeof body.consent === 'object' ? body.consent : {};
  if (consent.privacy !== true) errors.privacy = 'Please confirm you have read the Privacy Notice.';
  if (!ok || errors.privacy) throw new HttpError(422, 'Please check the highlighted answers.', { fields: errors });

  const updates = consent.updates === true;
  const whatsapp = consent.whatsapp === true;
  const { full_name, phone, area, right_to_work, ...rest } = values;
  const source = typeof body.src === 'string' && /^[a-z0-9_.-]{1,40}$/i.test(body.src) ? body.src : null;
  const now = new Date().toISOString();

  let ref = null;
  let receipt = null;
  const dupe = db
    .prepare('SELECT id FROM candidates WHERE phone = ? AND job_slug = ? AND created_at > ?')
    .get(phone, job.slug, new Date(Date.now() - 30 * 86400000).toISOString());

  if (!dupe) {
    receipt = newReceipt();
    for (let i = 0; i < 6; i++) {
      ref = newRef();
      try {
        db.prepare(
          `INSERT INTO candidates (ref, job_slug, full_name, phone, area, right_to_work, answers, status, notice_version, privacy_ack_at,
             updates_opt_in, whatsapp_opt_in, receipt_hash, source, created_at, updated_at)
           VALUES (?,?,?,?,?,?,?,'new',?,?,?,?,?,?,?,?)`
        ).run(ref, job.slug, full_name, phone, area, right_to_work, JSON.stringify(rest), config.noticeVersion, now, updates ? 1 : 0, whatsapp ? 1 : 0, sha256(receipt), source, now, now);
        break;
      } catch (err) {
        if (i < 5 && /UNIQUE/i.test(String(err.message))) continue;
        throw err;
      }
    }
  } else {
    ref = null; // already registered recently: confirm without creating a duplicate or revealing anything
  }

  const eligible = whatsapp && right_to_work !== 'no';
  sendJson(res, 201, {
    ok: true,
    ref,
    receipt,
    outcome: {
      rightToWork: right_to_work,
      whatsapp: {
        requested: whatsapp,
        eligible,
        configured: !!config.whatsappUrl,
        url: eligible && config.whatsappUrl ? config.whatsappUrl : null,
      },
      canRequestClarification: right_to_work === 'unsure' && !!receipt,
    },
  });
});

route('POST', '/api/clarify', async (ctx) => {
  if (!sameOrigin(ctx.req)) throw new HttpError(403, 'Request blocked.');
  const rl = clarifyLimiter.hit(ctx.ip);
  if (!rl.allowed) throw new HttpError(429, 'Please try again later.', { retryAfter: rl.retryAfter });
  const body = await readJson(ctx.req);
  const row = typeof body.ref === 'string' ? db.prepare('SELECT id, receipt_hash FROM candidates WHERE ref = ?').get(body.ref) : null;
  if (!row || typeof body.receipt !== 'string' || !row.receipt_hash || !safeEqual(sha256(body.receipt), row.receipt_hash)) {
    throw new HttpError(400, 'We could not match that request.');
  }
  const now = new Date().toISOString();
  db.prepare('UPDATE candidates SET clarification_requested_at = ?, updated_at = ? WHERE id = ?').run(now, now, row.id);
  sendJson(ctx.res, 200, { ok: true });
});

// ----- admin API -----
route('POST', '/api/admin/login', async (ctx) => {
  const { req, res } = ctx;
  if (!sameOrigin(req)) throw new HttpError(403, 'Request blocked.');
  const body = await readJson(req, 4096);
  const result = await login(db, body.email, body.password, ctx.ip);
  if (result.error === 'locked') {
    throw new HttpError(429, 'Too many sign-in attempts. Please wait a few minutes and try again.', { retryAfter: result.retryAfter });
  }
  if (result.error) {
    audit(db, String(body.email || '').slice(0, 120), 'login_failed');
    throw new HttpError(401, 'That email or password is not right.');
  }
  const { token, csrf } = createSession(db, result.user.id);
  audit(db, result.user.email, 'login');
  sendJson(
    res,
    200,
    { user: { email: result.user.email, role: result.user.role }, csrf },
    { 'Set-Cookie': serializeCookie(COOKIE_NAME, token, { maxAge: Math.floor(SESSION_ABSOLUTE_MS / 1000), secure: config.secureCookies }) }
  );
});

route('POST', '/api/admin/logout', (ctx) => {
  adminAuth(ctx);
  destroySession(db, parseCookies(ctx.req.headers.cookie)[COOKIE_NAME]);
  audit(db, ctx.actor, 'logout');
  sendJson(ctx.res, 200, { ok: true }, { 'Set-Cookie': serializeCookie(COOKIE_NAME, '', { maxAge: 0, secure: config.secureCookies }) });
});

function filterOptions() {
  const find = (id) => {
    for (const j of JOBS) {
      const f = j.fields.find((x) => x.id === id);
      if (f) return f.options;
    }
    return [];
  };
  return { vehicle: find('vehicle'), start: find('start'), days: [...find('days'), { value: 'both', label: 'Both' }] };
}

route('GET', '/api/admin/me', (ctx) => {
  const s = adminAuth(ctx);
  sendJson(ctx.res, 200, {
    user: s.user,
    csrf: s.csrf,
    statuses: STATUSES,
    jobs: JOBS.map((j) => ({ slug: j.slug, title: j.title })),
    filters: filterOptions(),
    config: configStatus(),
    retentionDays: config.retentionDays,
  });
});

route('GET', '/api/admin/candidates', (ctx) => {
  adminAuth(ctx);
  sendJson(ctx.res, 200, listCandidates(db, Object.fromEntries(ctx.url.searchParams)));
});

route('GET', '/api/admin/candidates/(\\d+)', (ctx) => {
  adminAuth(ctx);
  const c = getCandidate(db, Number(ctx.params[0]));
  if (!c) throw new HttpError(404, 'Candidate not found.');
  sendJson(ctx.res, 200, c);
});

route('PATCH', '/api/admin/candidates/(\\d+)', async (ctx) => {
  adminAuth(ctx);
  const body = await readJson(ctx.req, 8192);
  try {
    const c = updateCandidate(db, Number(ctx.params[0]), { status: body.status, notes: body.notes }, ctx.actor);
    if (!c) throw new HttpError(404, 'Candidate not found.');
    sendJson(ctx.res, 200, c);
  } catch (err) {
    if (err instanceof HttpError) throw err;
    if (err.status === 400) throw new HttpError(400, err.message);
    throw err;
  }
});

route('DELETE', '/api/admin/candidates/(\\d+)', (ctx) => {
  adminAuth(ctx, { role: 'admin' });
  if (!deleteCandidate(db, Number(ctx.params[0]), ctx.actor)) throw new HttpError(404, 'Candidate not found.');
  sendJson(ctx.res, 200, { ok: true });
});

route('GET', '/api/admin/export.csv', (ctx) => {
  adminAuth(ctx, { role: 'admin' });
  const query = Object.fromEntries(ctx.url.searchParams);
  const { csv, count } = exportCsv(db, query);
  audit(db, ctx.actor, 'csv_export', null, `${count} record(s)`);
  const stamp = new Date().toISOString().slice(0, 10);
  sendText(ctx.res, 200, csv, 'text/csv; charset=utf-8', {
    'Content-Disposition': `attachment; filename="lendhand-candidates-${stamp}.csv"`,
    'Cache-Control': 'no-store',
  });
});

// ----- pages -----
const NOINDEX = { 'X-Robots-Tag': 'noindex, nofollow', 'Cache-Control': 'no-store' };
route('GET', '/', (ctx) => sendPage(ctx.res, 'index.html'));
route('GET', '/apply(?:/([a-z0-9-]+))?', (ctx) => {
  const slug = ctx.params[0] || ctx.url.searchParams.get('job') || JOBS.find((j) => j.active)?.slug;
  if (!getJob(slug)) return sendPage(ctx.res, '404.html', 404);
  sendPage(ctx.res, 'apply.html', 200, { 'Referrer-Policy': 'no-referrer' });
});
route('GET', '/privacy', (ctx) => sendPage(ctx.res, 'privacy.html'));
route('GET', '/admin/?', (ctx) => sendPage(ctx.res, 'admin.html', 200, NOINDEX));

// ---------- server ----------
const server = http.createServer(async (req, res) => {
  const started = Date.now();
  const ctx = { req, res, ip: clientIp(req, config.trustProxy) };
  try {
    for (const [k, v] of Object.entries(securityHeaders({ secure: config.secureCookies }))) res.setHeader(k, v);
    const url = new URL(req.url, config.siteUrl);
    ctx.url = url;
    const method = req.method === 'HEAD' ? 'GET' : req.method;
    const pathname = url.pathname.replace(/\/{2,}/g, '/');

    if (pathname.startsWith('/api/') || pathname.startsWith('/admin')) res.setHeader('X-Robots-Tag', 'noindex, nofollow');
    if (method === 'GET' && !readLimiter.hit(ctx.ip).allowed) throw new HttpError(429, 'Too many requests. Please slow down.');

    for (const r of routes) {
      if (r.method !== method) continue;
      const m = pathname.match(r.re);
      if (!m) continue;
      ctx.params = m.slice(1);
      await r.handler(ctx);
      return;
    }

    if (method === 'GET' && serveStatic(req, res, PUBLIC_DIR, pathname)) return;

    if (pathname.startsWith('/api/')) throw new HttpError(404, 'Not found.');
    if (method === 'GET') return sendPage(res, '404.html', 404);
    throw new HttpError(405, 'Method not allowed.');
  } catch (err) {
    if (res.headersSent) return res.end();
    if (err instanceof HttpError) {
      const headers = err.extra?.retryAfter ? { 'Retry-After': String(err.extra.retryAfter) } : {};
      return sendJson(res, err.status, { error: err.message, ...err.extra }, headers);
    }
    console.error(`[error] ${req.method} ${req.url?.split('?')[0]}: ${err?.stack || err}`);
    sendJson(res, 500, { error: 'Something went wrong on our side. Please try again.' });
  } finally {
    if (process.env.LOG_REQUESTS === '1') console.log(`${req.method} ${req.url?.split('?')[0]} ${res.statusCode} ${Date.now() - started}ms`);
  }
});

server.requestTimeout = 30_000;
server.headersTimeout = 15_000;
server.keepAliveTimeout = 5_000;

// ---------- startup ----------
async function bootstrapAdmin() {
  const n = db.prepare('SELECT COUNT(*) AS n FROM users').get().n;
  if (n > 0 || !config.bootstrapAdminEmail || !config.bootstrapAdminPassword) return;
  try {
    await createUser(db, config.bootstrapAdminEmail, config.bootstrapAdminPassword, 'admin');
    audit(db, 'system', 'admin_bootstrap', config.bootstrapAdminEmail);
    console.log(`Created the first admin account (${config.bootstrapAdminEmail}). Remove ADMIN_PASSWORD from your environment now.`);
  } catch (err) {
    console.warn(`Could not create the admin account from ADMIN_EMAIL/ADMIN_PASSWORD: ${err.message}`);
  }
}

function maintenance() {
  try {
    pruneSessions(db);
    const n = purgeExpired(db, config.retentionDays);
    if (n) console.log(`Retention: removed ${n} expired candidate record(s).`);
  } catch (err) {
    console.error('Maintenance failed:', err.message);
  }
}

await bootstrapAdmin();
maintenance();
setInterval(maintenance, 6 * 3600 * 1000).unref();

server.listen(config.port, config.host, () => {
  console.log(`LendHand is running at ${config.siteUrl} (port ${config.port}, ${config.production ? 'production' : 'development'} mode)`);
  for (const w of config.warnings) console.warn(`Warning: ${w}`);
  const todo = configStatus().filter((c) => !c.ok);
  if (todo.length) console.warn(`Setup still needed: ${todo.map((c) => c.key).join(', ')}`);
  if (db.prepare('SELECT COUNT(*) AS n FROM users').get().n === 0) {
    console.warn('No admin account yet. Create one with:  npm run create-admin');
  }
});

for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, () => {
    server.close(() => {
      try {
        db.close();
      } catch {
        /* already closed */
      }
      process.exit(0);
    });
    setTimeout(() => process.exit(0), 5000).unref();
  });
}

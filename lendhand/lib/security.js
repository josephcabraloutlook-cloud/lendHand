import crypto from 'node:crypto';

export const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');

export function safeEqual(a, b) {
  const A = Buffer.from(String(a));
  const B = Buffer.from(String(b));
  return A.length === B.length && crypto.timingSafeEqual(A, B);
}

/** Small in-memory fixed-window rate limiter. Fine for a single instance; use an external store if you scale out. */
export function createLimiter({ windowMs, max }) {
  const hits = new Map();
  const timer = setInterval(() => {
    const now = Date.now();
    for (const [k, v] of hits) if (v.reset <= now) hits.delete(k);
  }, 60_000);
  timer.unref();
  return {
    hit(key) {
      const now = Date.now();
      let e = hits.get(key);
      if (!e || e.reset <= now) {
        e = { count: 0, reset: now + windowMs };
        hits.set(key, e);
      }
      e.count += 1;
      return { allowed: e.count <= max, retryAfter: Math.max(1, Math.ceil((e.reset - now) / 1000)) };
    },
    count(key) {
      const e = hits.get(key);
      return e && e.reset > Date.now() ? e.count : 0;
    },
    retryAfter(key) {
      const e = hits.get(key);
      return e ? Math.max(1, Math.ceil((e.reset - Date.now()) / 1000)) : 0;
    },
    clear(key) {
      hits.delete(key);
    },
  };
}

export function clientIp(req, trustProxy) {
  if (trustProxy) {
    const xff = req.headers['x-forwarded-for'];
    if (xff) {
      const parts = String(xff).split(',').map((s) => s.trim()).filter(Boolean);
      // With a single trusted proxy, the last entry is the address that proxy saw.
      if (parts.length) return parts[parts.length - 1];
    }
  }
  return req.socket.remoteAddress || 'unknown';
}

// ---- timing token: proves the form was loaded a few seconds before submission (cheap bot filter) ----
export function mintFormToken(secret) {
  const ts = Date.now().toString(36);
  const mac = crypto.createHmac('sha256', secret).update('form:' + ts).digest('base64url');
  return `${ts}.${mac}`;
}
export function checkFormToken(secret, token) {
  if (typeof token !== 'string' || token.length > 100) return { ok: false, age: 0 };
  const [ts, mac] = token.split('.');
  if (!ts || !mac) return { ok: false, age: 0 };
  const expected = crypto.createHmac('sha256', secret).update('form:' + ts).digest('base64url');
  if (!safeEqual(mac, expected)) return { ok: false, age: 0 };
  const age = Date.now() - parseInt(ts, 36);
  return { ok: Number.isFinite(age), age };
}

export function newReceipt() {
  return crypto.randomBytes(18).toString('base64url');
}

// ---- cookies ----
export function parseCookies(header) {
  const out = {};
  if (!header) return out;
  for (const part of String(header).split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    const v = part.slice(i + 1).trim();
    if (k && !(k in out)) {
      try {
        out[k] = decodeURIComponent(v);
      } catch {
        out[k] = v;
      }
    }
  }
  return out;
}

export function serializeCookie(name, value, { maxAge, secure, sameSite = 'Strict' } = {}) {
  let c = `${name}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=${sameSite}`;
  if (secure) c += '; Secure';
  if (maxAge !== undefined) c += `; Max-Age=${maxAge}`;
  return c;
}

export function securityHeaders({ secure }) {
  const h = {
    'Content-Security-Policy':
      "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'; object-src 'none'",
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=()',
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Cross-Origin-Resource-Policy': 'same-origin',
  };
  if (secure) h['Strict-Transport-Security'] = 'max-age=31536000; includeSubDomains';
  return h;
}

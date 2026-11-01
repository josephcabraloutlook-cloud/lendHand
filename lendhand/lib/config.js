// Central configuration. Everything secret or deployment-specific comes from environment variables
// (or a local .env file, which is never committed). Nothing here is invented: if a value is missing,
// the feature that needs it reports itself as "not configured" instead of pretending to work.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function loadEnvFile(file) {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (!m || line.trim().startsWith('#')) continue;
    let v = m[2];
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    if (process.env[m[1]] === undefined) process.env[m[1]] = v;
  }
}
loadEnvFile(path.join(ROOT, '.env'));

const env = process.env;
const bool = (v, d = false) => (v === undefined || v === '' ? d : /^(1|true|yes|on)$/i.test(v));
const int = (v, d) => {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : d;
};
const str = (v) => (v && v.trim() ? v.trim() : '');

const production = env.NODE_ENV === 'production';
const warnings = [];

let secret = str(env.SESSION_SECRET);
if (!secret) {
  if (production) {
    throw new Error(
      'SESSION_SECRET is not set. Generate one with:  node -e "console.log(require(\'crypto\').randomBytes(48).toString(\'base64url\'))"  and set it in your hosting environment.'
    );
  }
  secret = crypto.randomBytes(32).toString('hex');
  warnings.push('SESSION_SECRET not set: using a temporary secret for development (form tokens reset on restart).');
} else if (production && secret.length < 32) {
  throw new Error('SESSION_SECRET must be at least 32 characters in production.');
}

let whatsappUrl = str(env.WHATSAPP_INVITE_URL);
if (whatsappUrl && !/^https:\/\/chat\.whatsapp\.com\/[A-Za-z0-9_-]+(\?[^\s]*)?$/.test(whatsappUrl)) {
  warnings.push('WHATSAPP_INVITE_URL is not a valid WhatsApp invitation link (https://chat.whatsapp.com/...) and has been ignored.');
  whatsappUrl = '';
}

const siteUrl = (str(env.SITE_URL) || `http://localhost:${int(env.PORT, 3000)}`).replace(/\/+$/, '');

export const config = {
  production,
  port: int(env.PORT, 3000),
  host: str(env.HOST) || '0.0.0.0',
  siteUrl,
  secret,
  databasePath: path.resolve(ROOT, str(env.DATABASE_PATH) || 'data/lendhand.db'),
  trustProxy: bool(env.TRUST_PROXY, false),
  secureCookies: bool(env.COOKIE_SECURE, production || siteUrl.startsWith('https://')),
  whatsappUrl,
  controllerName: str(env.CONTROLLER_NAME),
  contactEmail: str(env.CONTACT_EMAIL),
  icoNumber: str(env.ICO_REGISTRATION_NUMBER),
  noticeVersion: str(env.PRIVACY_NOTICE_VERSION) || '2026-11-01',
  noticeConfirmed: bool(env.PRIVACY_NOTICE_CONFIRMED, false),
  retentionDays: Math.max(30, int(env.RETENTION_DAYS, 180)),
  bootstrapAdminEmail: str(env.ADMIN_EMAIL),
  bootstrapAdminPassword: env.ADMIN_PASSWORD || '',
  warnings,
};

// A plain-English readiness checklist, shown to admins so nothing is silently "pretend live".
export function configStatus() {
  const https = config.siteUrl.startsWith('https://');
  return [
    {
      key: 'WHATSAPP_INVITE_URL',
      label: 'WhatsApp invitation link',
      ok: !!config.whatsappUrl,
      detail: config.whatsappUrl
        ? 'Configured. Shown only to candidates who opt in.'
        : 'Not set. Candidates who opt in will be told the community is not open yet.',
    },
    {
      key: 'CONTROLLER_NAME',
      label: 'Legal name of the data controller',
      ok: !!config.controllerName,
      detail: config.controllerName ? 'Shown in the Privacy Notice.' : 'Not set. The Privacy Notice shows a placeholder.',
    },
    {
      key: 'CONTACT_EMAIL',
      label: 'Contact email for data requests',
      ok: !!config.contactEmail,
      detail: config.contactEmail ? 'Shown in the Privacy Notice and footer.' : 'Not set. Candidates have no way to exercise their rights by email.',
    },
    {
      key: 'PRIVACY_NOTICE_CONFIRMED',
      label: 'Privacy Notice reviewed',
      ok: config.noticeConfirmed,
      detail: config.noticeConfirmed
        ? `Marked as reviewed (version ${config.noticeVersion}).`
        : 'The public notice is flagged as a draft until you set PRIVACY_NOTICE_CONFIRMED=true after reviewing it.',
    },
    {
      key: 'SITE_URL',
      label: 'HTTPS site address',
      ok: https,
      detail: https ? 'Secure cookies and HSTS are on.' : 'SITE_URL is not an https:// address. Do not collect real candidate data over plain HTTP.',
    },
    {
      key: 'SESSION_SECRET',
      label: 'Session secret',
      ok: production,
      detail: production ? 'Set.' : 'Running in development mode with a temporary secret.',
    },
    {
      key: 'RETENTION_DAYS',
      label: 'Retention period',
      ok: true,
      detail: `Unreviewed and closed records are deleted automatically ${config.retentionDays} days after their last update. Onboarded records are kept until you delete them.`,
    },
  ];
}

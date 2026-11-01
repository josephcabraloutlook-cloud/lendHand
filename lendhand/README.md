# LendHand recruitment site

Candidate landing page, one-question-at-a-time registration form, SQLite database and a password-protected
admin dashboard. It has **no npm dependencies**: you only need Node.js 22.13 or newer.

## Run it locally (2 minutes)
```bash
npm run create-admin      # asks for your email and a password (12+ characters)
npm start                 # http://localhost:3000   (admin: /admin)
npm test                  # 9 end-to-end tests
```

## Put it live
1. **Host.** Use any host that runs Node or Docker and gives you a **persistent disk** (Render, Railway, Fly.io, a UK VPS).
   Mount the disk at `/data`. Without a persistent disk, candidate data is lost on every deploy.
2. **Domain + HTTPS.** Point your domain at the host; set `SITE_URL` to the https address.
3. **Secret.** `node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"` and set it as `SESSION_SECRET`.
4. **Environment variables.** Set everything in `.env.example` (see comments). Start command: `npm start`.
5. **Admin account.** Open your host's shell and run `npm run create-admin`. Roles: `admin` (can export and delete) and
   `recruiter` (view and update status/notes only). Forgot a password: `npm run create-admin -- --reset you@example.com`.
6. **WhatsApp link.** Create the group in WhatsApp, copy its invite link and set `WHATSAPP_INVITE_URL`. Until then,
   candidates who opt in are told the community is not open yet. The link is only ever sent to people who opted in
   and did not answer "No" to Right to Work.
7. **Privacy Notice.** Set `CONTROLLER_NAME`, `CONTACT_EMAIL`, then **have the notice reviewed** (`/privacy`) and only then set
   `PRIVACY_NOTICE_CONFIRMED=true`. Until then it shows a draft banner. The dashboard's setup checklist shows what is outstanding.
8. **Backups.** Schedule `npm run backup` daily and copy the files off the server. They contain personal data: keep them encrypted.

## How it works
- **Retention:** records are deleted automatically `RETENTION_DAYS` after last update (Onboarded records are kept until you delete them). `npm run purge` runs it on demand.
- **Spam protection:** hidden honeypot field, signed form token with a minimum fill time, per-IP rate limits, origin checks, sign-in lockout.
- **Security:** scrypt password hashing, HttpOnly SameSite sessions, CSRF tokens, strict Content-Security-Policy, parameterised SQL, CSV formula-injection protection, audit log of sign-ins, exports and deletions.
- **Add a new job category** (warehouse, cleaning, admin...): add an entry to `JOBS` in `lib/jobs.js` with its questions. The form at `/apply/<slug>`, validation, dashboard and CSV pick it up automatically. The homepage copy is currently delivery-specific.
- **Fonts and images** are self-hosted (no Google Fonts requests). The logo files in `public/assets` are derived from your supplied artwork; `tools/make_logo.py` shows how.

## Things only you can confirm before launch
Legal entity and ICO status, the Privacy Notice text and lawful bases, the retention period, who may see candidate data, whether and how
the client (e.g. Tarosso) may be named (it is **not** named anywhere on the public site), pay and role terms (none are advertised), and a compact
logo symbol for the favicon/profile image (a plain brand-green tile is used meanwhile). This software is not legal advice.

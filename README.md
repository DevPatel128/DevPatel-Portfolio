# Dev Patel — Portfolio

I build fast, secure websites and digital systems that turn ideas into shipped outcomes.

This is the source behind my personal portfolio — built from scratch, shipped with
obsession. No frameworks, no shortcuts. Just clean code, sharp design, and a story
worth reading.

Founder & Builder. BTech CS. Turning curiosity into creation.

**Live:** <https://info.dvpatel.workers.dev>

---

## Architecture

```text
GitHub (source of truth)
   └── GitHub Actions ──► lint → typecheck → test → build → deploy
                                                              │
                                                              ▼
                                    Cloudflare Workers ── Static Assets (./public)
                                              │      └───── Workers KV (rate limit)
                                              │      └───── Turnstile (bot check)
                                              ▼
                                    Cloudflare D1 (contact_messages)
                                              +
                                     Resend (transactional email)
```

| Layer | Service | Why |
|---|---|---|
| Source + CI/CD | GitHub Actions | Single pipeline, no vendor deploy hooks |
| Static hosting | Cloudflare Workers Static Assets | Same origin as the API — no CORS, one deploy |
| API | Cloudflare Workers | `POST /api/contact`, `GET /api/health`, `GET /api/config` |
| Rate limiting | Cloudflare Workers KV | 5 submissions per IP per 10 minutes |
| Bot protection | Cloudflare Turnstile | Contact form; honeypot as the always-on baseline |
| Database | Cloudflare D1 | Permanent record of every inquiry; no public endpoint, no client key |
| Email | Resend | Owner notification + visitor auto-reply |

Deliberately **not** used, because nothing in the project needs them: R2 (no user
uploads — site images are static assets), Queues (no async work), Durable Objects
(no coordinated state), any auth provider (no accounts), Stripe (no payments),
Sentry and PostHog (Workers Observability already covers logs and errors for a
single-page static site).

---

## Stack

- Vanilla HTML5 · CSS3 · JavaScript (ES6+)
- Zero frameworks · Zero bundlers · Zero build step for the site itself
- Cloudflare Workers — hosting, edge API, rate limiting
- Cloudflare D1 — contact message storage
- Resend — transactional email (FormSubmit remains as a fallback)

---

## Repository layout

```text
public/                 Everything published to the web
  index.html            Entire page, all sections
  style.css             All styles
  script.js             All interactivity
  _headers              Security headers (CSP, HSTS, COOP/CORP …)
worker/index.js         Edge Worker — serves assets + the /api routes
d1/migrations/          D1 schema for contact_messages
.github/workflows/      CI and deployment pipelines
wrangler.jsonc          Cloudflare configuration
.env.example            Every environment variable, documented
```

Anything outside `public/` is never served — that is what keeps the engineering
docs off the public internet. Never point `assets.directory` at the repository root.

---

## Features

- Custom animated cursor
- Scroll-triggered reveal animations (Intersection Observer)
- Typewriter effect with reduced-motion support
- Animated skill progress bars
- Photography carousel with touch/swipe
- Contact form: honeypot + per-IP rate limit + optional Turnstile
- Selected work cards and deeper case-study blocks
- Meeting request path with preferred call slots
- Resume PDF download
- Full SEO — OG tags, JSON-LD Person schema, sitemap
- Security hardened — CSP, HSTS, COOP/CORP, X-Frame-Options, nosniff

---

## Local development

```bash
npm install
cp .env.example .dev.vars   # fill in what you need; every value is optional
npm run dev                 # wrangler dev — serves ./public and the /api routes
```

The site works with an empty `.dev.vars`: unconfigured providers are skipped
rather than fatal. `GET /api/health` reports which bindings are live.

---

## Checks

```bash
npm run check
```

Runs lint (ESLint), typecheck (`tsc --checkJs` over the Worker and its tests),
tests (`node:test`), and a `wrangler deploy --dry-run` build. CI runs the same
four steps on every push and pull request.

---

## Deployment

**The site is not hosted right now, and deployment is switched off by default.**
Every push to `main` still runs the full check suite, so the code stays
continuously verified while it is unhosted — the deploy job is *skipped*, not
failed, until you opt in.

### Going live

Everything below is dashboard work; the repository is already complete.

1. **Cloudflare credentials** → GitHub → Settings → Secrets and variables → Actions → *Secrets*
   - `CLOUDFLARE_API_TOKEN` — permissions: Workers Scripts:Edit, Workers KV Storage:Edit, D1:Edit
   - `CLOUDFLARE_ACCOUNT_ID` — Cloudflare dashboard → Workers & Pages
2. **Bindings** — [wrangler.jsonc](wrangler.jsonc) points at an existing KV namespace
   and D1 database. Deploying under a different Cloudflare account needs new ones:
   `npx wrangler kv namespace create RATE_LIMIT` and
   `npx wrangler d1 create portfolio-contact`, then update the `id` values.
3. **Worker secrets** — set what you need (all optional; see [.env.example](.env.example)):
   ```bash
   npx wrangler secret put FORMSUBMIT_TOKEN
   npx wrangler secret put TURNSTILE_SECRET_KEY
   npx wrangler secret put TURNSTILE_SITE_KEY
   ```
   These are managed outside GitHub so a missing repository secret can never
   blank one out mid-deploy.
4. **Turn deploys on** → same settings page, *Variables* tab:
   `DEPLOY_ENABLED` = `true`. Push to `main` and it ships.

To deploy once without enabling automatic deploys, run the **Deploy** workflow
manually from the Actions tab — a manual run bypasses the variable.

Nothing deploys from a laptop. If Cloudflare Workers Builds is ever connected to
this repository, disconnect it: it would deploy in parallel with Actions.

---

## Database

Contact submissions are stored in Cloudflare D1. Apply the schema once:

```bash
npx wrangler d1 execute portfolio-contact --remote --file=./d1/migrations/0001_contact_messages.sql
```

Read messages back with:

```bash
npx wrangler d1 execute portfolio-contact --remote --command "SELECT created_at, name, email, project_type, message FROM contact_messages ORDER BY created_at DESC LIMIT 20"
```

The database has no public endpoint and no client-side key — the only path to it
is the Worker's `DB` binding. Storage degrades gracefully: if D1 is unreachable
the form still emails, and `/api/health` reports `database: false`.

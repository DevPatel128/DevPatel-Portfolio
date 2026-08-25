# Dev Patel — Portfolio

I build fast, secure websites and digital systems that turn ideas into shipped outcomes.

This is the source behind my personal portfolio — built from scratch, shipped with
obsession. No frameworks, no shortcuts. Just clean code, sharp design, and a story
worth reading.

Founder of Navdek. BTech CS. Turning curiosity into creation.

**Live:** <https://devpatel-portfolio.devpatel1286.workers.dev>

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
                                   Supabase Postgres (contact_messages, RLS)
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
| Database | Supabase Postgres | Permanent record of every inquiry, insert-only RLS |
| Email | Resend | Owner notification + visitor auto-reply |

Deliberately **not** used, because nothing in the project needs them: R2 (no user
uploads — site images are static assets), Queues (no async work), Supabase Auth
(no accounts), Supabase Realtime (no live data), Stripe (no payments), Sentry and
PostHog (Workers Observability already covers logs and errors for a single-page
static site).

---

## Stack

- Vanilla HTML5 · CSS3 · JavaScript (ES6+)
- Zero frameworks · Zero bundlers · Zero build step for the site itself
- Cloudflare Workers — hosting, edge API, rate limiting
- Supabase Postgres — contact message storage
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
supabase/migrations/    Database schema + RLS policies
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
   - `CLOUDFLARE_API_TOKEN` — permissions: Workers Scripts:Edit, Workers KV Storage:Edit
   - `CLOUDFLARE_ACCOUNT_ID` — Cloudflare dashboard → Workers & Pages
2. **KV namespace** — [wrangler.jsonc](wrangler.jsonc) points at an existing namespace.
   Deploying under a different Cloudflare account needs a new one:
   `npx wrangler kv namespace create RATE_LIMIT`, then update the `id`.
3. **Worker secrets** — set what you need (all optional; see [.env.example](.env.example)):
   ```bash
   npx wrangler secret put SUPABASE_URL
   npx wrangler secret put SUPABASE_PUBLISHABLE_KEY
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

Optional. Without Supabase the contact form still emails; it just keeps no
permanent record, and `/api/health` reports `supabase: false`.

```bash
npx supabase link --project-ref <your-project-ref>
npx supabase db push
```

Applies [supabase/migrations](supabase/migrations) — the `contact_messages` table
with row-level security. The anon key can insert and nothing else; reading
messages requires `service_role`.

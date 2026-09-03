# Deployment Runbook

Live URL: **https://info.dvpatel.workers.dev**
Worker: `info` · Account subdomain: `devpatel` · Repo: `DevPatel128/DevPatel-Portfolio`

Covers `Framework/STEP2_ENGINEERING_MASTER_PROMPT.md` §8 *DevOps & Infrastructure*
— pipeline, monitoring, failover, backup, rollback.

---

## 1. Pipeline

```
push / PR ──► ci.yml ──────► verify.yml ──► lint → typecheck → test → build
push to main ─► deploy.yml ─► verify.yml ──► ... ──► wrangler deploy ──► health check
```

`ci.yml` and `deploy.yml` both call the same `verify.yml`, so a PR and a
production run execute byte-identical checks. `deploy.yml` runs only when
`vars.DEPLOY_ENABLED == 'true'`, or on a manual **Run workflow** from the Actions
tab — a manual run deploys without switching automatic deploys on permanently.

Concurrency is `deploy-production` with `cancel-in-progress: false`: one
deployment at a time, and a run that is mid-deploy is never cancelled.

**Nothing deploys from a laptop.** If Cloudflare Workers Builds is ever connected
to this repository, disconnect it — it would deploy in parallel with Actions and
the two would race.

The gate before any push:

```bash
npm run check
```

Identical to what CI runs: `eslint` → `tsc --noEmit` → `node --test` → `wrangler deploy --dry-run`.

---

## 2. Required configuration

**GitHub** → Settings → Secrets and variables → Actions

| Kind | Name | Value |
|---|---|---|
| Secret | `CLOUDFLARE_API_TOKEN` | Custom token: Workers Scripts:Edit, Workers KV Storage:Edit, D1:Edit |
| Secret | `CLOUDFLARE_ACCOUNT_ID` | Dashboard → Workers & Pages → Account ID |
| Variable | `DEPLOY_ENABLED` | `true` |

**Worker secrets** — set out of band, never through the workflow:

```bash
npx wrangler secret put FORMSUBMIT_TOKEN
npx wrangler secret put TURNSTILE_SECRET_KEY
npx wrangler secret put TURNSTILE_SITE_KEY
```

**Bindings** — already provisioned, declared in `wrangler.jsonc`:

| Binding | Resource | ID |
|---|---|---|
| `ASSETS` | Static assets | `./public` |
| `RATE_LIMIT` | KV namespace `portfolio-contact-ratelimit` | `02434550c7fc4dea95584e0c0a0e8076` |
| `DB` | D1 database `portfolio-contact` (APAC) | `f969cf74-2654-4524-ac86-b95f4cc67fb4` |

---

## 3. First deploy

1. Change the account subdomain to `devpatel` — dashboard → Workers & Pages →
   **Change** next to *Your subdomain*. Account-wide: `trove` and `vroe-labs`
   move to the new subdomain and their old URLs stop resolving.
2. Apply the D1 schema:
   ```bash
   npx wrangler d1 execute portfolio-contact --remote --file=./d1/migrations/0001_contact_messages.sql
   ```
3. Set the Worker secrets (§2).
4. Add the GitHub secrets and `DEPLOY_ENABLED` (§2).
5. Merge to `main`. The Deploy workflow verifies, deploys, then polls
   `/api/health` five times before declaring success.

---

## 4. Post-deploy verification

```bash
# Bindings all wired
curl -s https://info.dvpatel.workers.dev/api/health | python3 -m json.tool

# Security headers present
curl -sI https://info.dvpatel.workers.dev/ | grep -iE 'content-security-policy|strict-transport|x-frame|x-content-type|referrer-policy|permissions-policy|cross-origin'

# Engineering docs are not served
for f in CLAUDE.md Coder.md docs/security_architecture.md .env.example wrangler.jsonc; do
  curl -s -o /dev/null -w "$f %{http_code}\n" "https://info.dvpatel.workers.dev/$f"
done

# Submissions landing
npx wrangler d1 execute portfolio-contact --remote \
  --command "SELECT created_at, name, email, project_type FROM contact_messages ORDER BY created_at DESC LIMIT 5"
```

Health returns `200` with every flag true, headers all present, every doc `404`.
A `503` from health names the unconfigured binding without leaking a value.

---

## 5. Monitoring

- **Workers Observability** — enabled in `wrangler.jsonc`. Dashboard → Workers &
  Pages → `info` → Logs. Retains invocations, errors and console output.
- **Live tail**: `npx wrangler tail info --format pretty`
- **Health probe**: `GET /api/health` is a stable uptime-check target. It returns
  `503` when a binding is missing, so an external monitor catches a
  half-configured deploy, not just a hard outage.
- **What to watch**: `D1 insert failed` and `Email notification failed` in the
  logs. Either alone still returns `200` to the visitor by design — only a
  correlated pair means a lead was actually lost (`502`).

---

## 6. Rollback

Every deploy creates a version. To revert:

```bash
npx wrangler deployments list
npx wrangler rollback [<version-id>]
```

Rollback restores Worker code and configuration. It does **not** revert D1 schema
changes — a migration that must be undone needs its own reversing SQL, applied
before the rollback.

To stop deploys entirely while investigating, set `DEPLOY_ENABLED` to `false`.
CI keeps running on `main`, so the code stays continuously verified while unhosted.

---

## 7. Backup and recovery

| Asset | Recovery |
|---|---|
| Site code | Git. `main` is the source of truth. |
| Worker config | `wrangler.jsonc`, in git. |
| Worker secrets | **Not recoverable from anywhere.** Keep them in a password manager — losing them means re-issuing from each provider. |
| D1 data | Export below. Cloudflare also keeps point-in-time restore for D1. |
| KV rate-limit counters | Disposable — 10-minute TTL, regenerates itself. |

Manual D1 export:

```bash
npx wrangler d1 export portfolio-contact --remote --output ./contact-backup-$(date +%F).sql
```

Worth running before any schema change and periodically while inquiries matter.
The file contains visitor PII — store it accordingly and never commit it.

Full rebuild from scratch: create the KV namespace and D1 database, update the
IDs in `wrangler.jsonc`, apply `d1/migrations/0001_contact_messages.sql`, set the
Worker secrets, push to `main`.

---

## 8. Failure modes

| Symptom | Likely cause | Action |
|---|---|---|
| Deploy job skipped | `DEPLOY_ENABLED` unset | Set the variable, or run the workflow manually |
| Deploy fails on credentials | Token missing, expired, or under-scoped | Re-issue with Workers Scripts:Edit + KV:Edit + D1:Edit |
| `/api/health` → `503` | A binding is unconfigured | The response body names which one |
| Form returns `502` | D1 **and** email both failed | Check `wrangler tail`; the visitor is told to email directly |
| Form returns `403` | Turnstile failed, or a cross-origin POST | Check the widget's hostname matches the live domain |
| Form returns `429` | Rate limit — 5 per IP per 10 min | Expected under load; expires on its own |
| Site 404s entirely | Worker not deployed, or subdomain changed | Cloudflare error 1042 means no Worker at that name |

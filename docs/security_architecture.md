# Security Architecture

Scope: `info.devpatel.workers.dev` — a single-page static portfolio plus a
three-route edge API. Structured on `Framework/STEP2_ENGINEERING_MASTER_PROMPT.md`
§6 *Security Architecture*, trimmed to the sections a site of this shape actually
has. Sections the framework lists that do not apply here (authentication,
authorization, AI safety, prompt-injection defence) are recorded as N/A rather
than filled with invented content — the site has no accounts, no sessions and no
model in the request path.

---

## 1. Trust boundaries

```
Visitor ──HTTPS──► Cloudflare edge ──► Worker (info)
                                         ├─► ASSETS      (read-only, ./public)
                                         ├─► RATE_LIMIT  (KV, per-IP counters)
                                         ├─► DB          (D1, insert-only in practice)
                                         ├─► Turnstile   (siteverify, outbound)
                                         └─► Resend / FormSubmit (outbound email)
```

Everything inside the Worker is trusted; everything crossing into it is not.
There is exactly one path that accepts visitor-supplied data — `POST /api/contact`
— and it is the only surface with real attack value.

---

## 2. Attack surface and controls

| Route | Method | Auth | Controls |
|---|---|---|---|
| `/*` | GET | none | Static assets, read-only binding. No user input reaches disk. |
| `/api/health` | GET | none | Returns booleans only — never a secret, never a secret's name. |
| `/api/config` | GET | none | Returns the Turnstile **site** key, which is public by design. |
| `/api/contact` | POST | none | Full stack below. |

### `POST /api/contact`, in execution order

| # | Control | Implementation | Defeats |
|---|---|---|---|
| 1 | Method allowlist | `405` on anything but POST | Verb tampering |
| 2 | Same-origin enforcement | `isSameOrigin()` vs `url.origin` | Cross-site form POSTs |
| 3 | Content-type pin | `415` unless `application/json` | Simple-request CSRF |
| 4 | Body cap | `413` above 16 KB | Memory / cost abuse |
| 5 | JSON parse guard | `400` on malformed input | Parser abuse |
| 6 | Honeypot | `_honey` filled → `200`, nothing stored or sent | Naive bots, silently |
| 7 | Per-IP rate limit | KV, 5 per 10 min on `cf-connecting-ip` | Flooding, enumeration |
| 8 | Turnstile | Server-side `siteverify`, active when the secret is set | Scripted and headless bots |
| 9 | Field sanitisation | `sanitise()` — trim, per-field length cap, unknown keys dropped | Oversized and unexpected input |
| 10 | Format validation | Required-field check + email regex | Junk submissions |
| 11 | Parameter binding | D1 prepared statement, `.bind()` on all 8 values | **SQL injection** |
| 12 | Schema constraints | `CHECK (length(...) BETWEEN …)` on every column | Direct-write drift |
| 13 | Graceful degradation | `Promise.allSettled`; `502` only if storage *and* email fail | Silent lead loss |

Controls 6 and 8 are complementary: the honeypot is always on and costs nothing;
Turnstile is the real verification and activates the moment
`TURNSTILE_SECRET_KEY` exists. Neither is load-bearing alone.

Control 11 is the one that must never regress. User input is passed as bound
parameters and never concatenated into SQL text. `test/worker.test.js` asserts
this directly with an injection payload — the test fails if anyone reaches for
string interpolation.

---

## 3. Transport and browser controls

Sent from [`public/_headers`](../public/_headers) on every static response:

| Header | Value | Purpose |
|---|---|---|
| `Content-Security-Policy` | `default-src 'self'` + explicit allowances | Blocks injected script and exfiltration |
| `Strict-Transport-Security` | `max-age=31536000; includeSubDomains; preload` | Forces HTTPS |
| `X-Frame-Options` / `frame-ancestors 'none'` | `DENY` | Clickjacking |
| `X-Content-Type-Options` | `nosniff` | MIME confusion |
| `Referrer-Policy` | `strict-origin-when-cross-origin` | Referrer leakage |
| `Permissions-Policy` | camera, mic, geolocation, payment all `()` | Silent capability use |
| `Cross-Origin-Opener-Policy` | `same-origin` | Cross-origin window handles |
| `Cross-Origin-Resource-Policy` | `same-origin` | Cross-origin embedding |
| `X-Robots-Tag` | `noindex` on preview URLs only | Keeps branch previews out of search |

The CSP allows exactly three external origins, all Cloudflare or Google Fonts:
`challenges.cloudflare.com` (script + frame, Turnstile), `fonts.googleapis.com`
(style) and `fonts.gstatic.com` (font). `connect-src` is `'self'` only, so a
successful script injection still has nowhere to send stolen data.

**`_headers` never applies to responses built in Worker code.** The API therefore
carries its own set in `JSON_HEADERS`: `no-store`, `nosniff`, `X-Frame-Options`
and `Referrer-Policy`.

The CSP is duplicated in a `<meta>` tag in `index.html` as defence in depth. The
two copies must stay identical except for `frame-ancestors`, which the spec
ignores in meta tags — a comment above the tag records this so it is not
"corrected" later.

---

## 4. Secrets management

| Secret | Lives in | Reaches the browser? |
|---|---|---|
| `FORMSUBMIT_TOKEN` | Worker secret | No |
| `TURNSTILE_SECRET_KEY` | Worker secret | No |
| `RESEND_API_KEY` | Worker secret | No |
| `TURNSTILE_SITE_KEY` | Worker secret → `GET /api/config` | Yes — public by design |
| `CLOUDFLARE_API_TOKEN` | GitHub Actions secret | No |
| `CLOUDFLARE_ACCOUNT_ID` | GitHub Actions secret | No |

Rules:

- Worker secrets are set out of band (`wrangler secret put`), never through the
  deploy workflow. A missing GitHub secret therefore cannot blank a Worker secret
  mid-deploy.
- The API token is custom-scoped to Workers Scripts:Edit, Workers KV Storage:Edit
  and D1:Edit. Never the Global API Key. Set an expiry and rotate on expiry.
- `.dev.vars` and `.env` are gitignored. [`.env.example`](../.env.example) is the
  only inventory and carries no real values.
- `wrangler.jsonc` holds binding IDs, not secrets. A KV namespace ID and a D1
  database ID are addresses, not credentials — neither grants access without the
  account.
- Rotation: revoke in the provider, `wrangler secret put` the replacement,
  redeploy. No code change required for any of them.

**Removed by the D1 migration:** the previous Supabase design required a
publishable anon key held by the Worker against a public REST endpoint, with an
insert-only RLS policy as the only thing standing between a leaked key and the
data. D1 has no key and no public endpoint — the only route in is the `DB`
binding. This deletes a credential and an internet-facing surface outright.

---

## 5. Data handling

`contact_messages` holds visitor-submitted PII: name, email, message body, plus
`source_ip_country` (ISO-2 country, not an IP address) and `user_agent`.

- **Raw IP addresses are never stored.** `cf-connecting-ip` is used for the KV
  rate-limit key and discarded; only the country code is persisted.
- **Metadata never leaves the database.** Email notifications receive
  `fields` only — `user_agent` and `source_ip_country` are excluded. A test
  enforces this.
- Access is via `wrangler d1 execute` under the account owner's credentials.
- Retention is currently unbounded. If the table ever grows past casual review,
  add a scheduled prune of rows older than 24 months.

---

## 6. Not applicable

| Framework §6 item | Status |
|---|---|
| Authentication | N/A — no accounts, no sessions, no login |
| Authorization | N/A — no roles; the only writer is the Worker itself |
| Encryption at rest | Handled by Cloudflare for D1 and KV; nothing custom |
| Media protection | N/A — all images are public static assets |
| AI safety / prompt-injection defence | N/A — no model in the request path |

---

## 7. Review checklist

Run before merging any change to the Worker, the form, or `_headers`:

- [ ] Honeypot field `_honey` still present in the form markup
- [ ] All D1 writes use `.bind()` — no string interpolation anywhere near SQL
- [ ] No credential, email address or API key hardcoded in a tracked file
- [ ] Every external link carries `rel="noopener noreferrer"`
- [ ] No `innerHTML` with unsanitised input, no `eval()`, no `document.write()`
- [ ] `_headers` CSP and the `index.html` meta CSP still match
- [ ] Any new env var added to `.env.example`
- [ ] `npm run check` passes

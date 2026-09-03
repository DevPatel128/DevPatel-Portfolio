/**
 * Dev Patel portfolio — Cloudflare Worker
 *
 * Serves the static site from the ASSETS binding and exposes a small API:
 *   GET  /api/health   — binding readiness (booleans only, never values)
 *   GET  /api/config   — client-safe config (Turnstile site key)
 *   POST /api/contact  — contact form intake
 *
 * Contact pipeline:
 *   1. Same-origin check + honeypot reject bots cheaply
 *   2. Per-IP rate limit via Workers KV
 *   3. Cloudflare Turnstile verification (only when TURNSTILE_SECRET_KEY is set)
 *   4. Store the message in Cloudflare D1 (permanent record)
 *   5. Send the email notification via Resend, falling back to FormSubmit
 *
 * Every integration is optional at runtime: an unconfigured provider is skipped
 * rather than fatal, and a submission only fails when both the database and the
 * email path fail. See .env.example for the full variable list.
 */

/**
 * @typedef {object} Env
 * @property {Fetcher} ASSETS Static assets from ./public
 * @property {KVNamespace} RATE_LIMIT Per-IP contact throttle
 * @property {D1Database} DB Contact submissions — reachable only through this binding
 * @property {string} [RESEND_API_KEY] Preferred transactional email provider
 * @property {string} [CONTACT_TO_EMAIL] Inbox that receives inquiries
 * @property {string} [CONTACT_FROM_EMAIL] Verified Resend sender, e.g. "Dev <hello@example.com>"
 * @property {string} [FORMSUBMIT_TOKEN] Legacy email fallback, used only without Resend
 * @property {string} [TURNSTILE_SECRET_KEY] Enables server-side Turnstile verification
 * @property {string} [TURNSTILE_SITE_KEY] Client-safe key, served from /api/config
 */

/**
 * @typedef {object} ContactFields
 * @property {string} name
 * @property {string} email
 * @property {string} project_type
 * @property {string} timeline
 * @property {string | null} preferred_call_time
 * @property {string} message
 */

/**
 * A ContactFields set plus the request metadata recorded alongside it.
 *
 * @typedef {ContactFields & {
 *   source_ip_country: string | null,
 *   user_agent: string,
 * }} ContactRecord
 */

const CONTACT_PATH = '/api/contact';
const HEALTH_PATH = '/api/health';
const CONFIG_PATH = '/api/config';

const MAX_BODY_BYTES = 16 * 1024;
const RATE_LIMIT_MAX = 5;
const RATE_LIMIT_WINDOW_S = 600;
const TURNSTILE_VERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';
const RESEND_URL = 'https://api.resend.com/emails';

/** @type {ReadonlyArray<'name' | 'email' | 'project_type' | 'timeline' | 'message'>} */
const REQUIRED_FIELDS = ['name', 'email', 'project_type', 'timeline', 'message'];
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

/** @type {Record<string, number>} */
const FIELD_LIMITS = {
    name: 120,
    email: 254,
    project_type: 40,
    timeline: 40,
    preferred_call_time: 160,
    message: 5000,
};

// public/_headers is applied by the static-asset layer and never reaches a
// response built in Worker code, so the API carries its own hardening.
const JSON_HEADERS = {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
};

export default {
    /**
     * @param {Request} request
     * @param {Env} env
     * @returns {Promise<Response> | Response}
     */
    fetch(request, env) {
        const url = new URL(request.url);

        switch (url.pathname) {
            case CONTACT_PATH:
                return handleContact(request, env, url);
            case HEALTH_PATH:
                return handleHealth(env);
            case CONFIG_PATH:
                return handleConfig(env);
            default:
                return env.ASSETS.fetch(request);
        }
    },
};

/**
 * @param {number} status
 * @param {Record<string, unknown>} body
 * @param {Record<string, string>} [extraHeaders]
 * @returns {Response}
 */
function json(status, body, extraHeaders) {
    return new Response(JSON.stringify(body), {
        status,
        headers: { ...JSON_HEADERS, ...extraHeaders },
    });
}

/**
 * Reports whether each binding is configured. Deliberately returns booleans
 * only — never a secret value, never a secret name.
 *
 * @param {Env} env
 * @returns {Response}
 */
export function handleHealth(env) {
    const configured = {
        assets: typeof env.ASSETS?.fetch === 'function',
        rate_limit_kv: typeof env.RATE_LIMIT?.get === 'function',
        database: typeof env.DB?.prepare === 'function',
        email: hasResend(env) || Boolean(env.FORMSUBMIT_TOKEN),
        turnstile: Boolean(env.TURNSTILE_SECRET_KEY) && Boolean(env.TURNSTILE_SITE_KEY),
    };

    // Turnstile is hardening, not a dependency — the form works without it.
    const ready =
        configured.assets && configured.rate_limit_kv && configured.database && configured.email;

    return json(ready ? 200 : 503, { ready, configured });
}

/**
 * Client-safe configuration. The Turnstile *site* key is public by design;
 * serving it here keeps environment-specific values out of the static HTML.
 *
 * @param {Env} env
 * @returns {Response}
 */
export function handleConfig(env) {
    return json(
        200,
        { turnstile_site_key: env.TURNSTILE_SITE_KEY ?? null },
        { 'Cache-Control': 'public, max-age=300' },
    );
}

/**
 * @param {Request} request
 * @param {Env} env
 * @param {URL} url
 * @returns {Promise<Response>}
 */
export async function handleContact(request, env, url) {
    if (request.method !== 'POST') {
        return json(405, { error: 'Method not allowed' }, { Allow: 'POST' });
    }

    // Same-origin only. Browsers always send Origin on a cross-site POST, so a
    // mismatch means the submission did not come from this site.
    const origin = request.headers.get('origin');
    if (origin && !isSameOrigin(origin, url)) {
        return json(403, { error: 'Cross-origin submissions are not accepted' });
    }

    if (!request.headers.get('content-type')?.includes('application/json')) {
        return json(415, { error: 'Expected application/json' });
    }

    const declaredLength = Number(request.headers.get('content-length') ?? 0);
    if (declaredLength > MAX_BODY_BYTES) {
        return json(413, { error: 'Message too large' });
    }

    let payload;
    try {
        payload = await request.json();
    } catch {
        return json(400, { error: 'Malformed request body' });
    }

    if (typeof payload !== 'object' || payload === null) {
        return json(400, { error: 'Malformed request body' });
    }

    const body = /** @type {Record<string, unknown>} */ (payload);

    // Honeypot: a real browser never fills this. Answer 200 so bots learn nothing.
    if (typeof body._honey === 'string' && body._honey.trim() !== '') {
        return json(200, { ok: true });
    }

    const clientIp = request.headers.get('cf-connecting-ip') ?? 'unknown';
    if (await isRateLimited(env, clientIp)) {
        return json(429, { error: 'Too many submissions. Please try again shortly.' });
    }

    if (env.TURNSTILE_SECRET_KEY) {
        const token =
            typeof body.cf_turnstile_response === 'string' ? body.cf_turnstile_response : '';
        if (!(await verifyTurnstile(env.TURNSTILE_SECRET_KEY, token, clientIp))) {
            return json(403, { error: 'Bot check failed. Please retry the verification.' });
        }
    }

    const fields = sanitise(body);

    const missing = REQUIRED_FIELDS.filter((field) => !fields[field]);
    if (missing.length > 0) {
        return json(422, { error: `Missing required field(s): ${missing.join(', ')}` });
    }

    if (!EMAIL_PATTERN.test(fields.email)) {
        return json(422, { error: 'Please enter a valid email address' });
    }

    // Both metadata fields are truncated to the column's CHECK constraint here,
    // the same way sanitise() bounds the user-supplied fields.
    const country = request.cf?.country;

    /** @type {ContactRecord} */
    const record = {
        ...fields,
        source_ip_country: typeof country === 'string' ? country.slice(0, 2) : null,
        user_agent: (request.headers.get('user-agent') ?? '').slice(0, 500),
    };

    const [stored, notified] = await Promise.allSettled([
        storeMessage(env, record),
        sendNotification(env, fields, url.origin),
    ]);

    if (stored.status === 'rejected') {
        console.error('D1 insert failed:', stored.reason);
    }
    if (notified.status === 'rejected') {
        console.error('Email notification failed:', notified.reason);
    }

    // The lead is only lost if both paths failed.
    if (stored.status === 'rejected' && notified.status === 'rejected') {
        return json(502, { error: 'Could not deliver your message. Please email me directly.' });
    }

    return json(200, { ok: true });
}

/**
 * @param {string} origin
 * @param {URL} url
 * @returns {boolean}
 */
function isSameOrigin(origin, url) {
    try {
        return new URL(origin).origin === url.origin;
    } catch {
        return false;
    }
}

/**
 * @param {Record<string, unknown>} payload
 * @returns {ContactFields}
 */
export function sanitise(payload) {
    /** @type {Record<string, string | null>} */
    const clean = {};

    for (const [field, limit] of Object.entries(FIELD_LIMITS)) {
        const value = payload[field];
        clean[field] = typeof value === 'string' ? value.trim().slice(0, limit) : '';
    }

    // Optional field: store null rather than an empty string.
    clean.preferred_call_time = clean.preferred_call_time || null;

    return /** @type {ContactFields} */ (/** @type {unknown} */ (clean));
}

/**
 * @param {Env} env
 * @param {string} clientIp
 * @returns {Promise<boolean>}
 */
async function isRateLimited(env, clientIp) {
    const key = `contact:${clientIp}`;
    const raw = await env.RATE_LIMIT.get(key);
    const used = Number.parseInt(raw ?? '0', 10);
    const count = Number.isFinite(used) ? used : 0;

    if (count >= RATE_LIMIT_MAX) {
        return true;
    }

    await env.RATE_LIMIT.put(key, String(count + 1), { expirationTtl: RATE_LIMIT_WINDOW_S });
    return false;
}

/**
 * @param {string} secret
 * @param {string} token
 * @param {string} clientIp
 * @returns {Promise<boolean>}
 */
async function verifyTurnstile(secret, token, clientIp) {
    if (!token) {
        return false;
    }

    const form = new URLSearchParams({ secret, response: token });
    if (clientIp !== 'unknown') {
        form.set('remoteip', clientIp);
    }

    try {
        const response = await fetch(TURNSTILE_VERIFY_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: form,
        });

        if (!response.ok) {
            console.error('Turnstile siteverify responded', response.status);
            return false;
        }

        const result = /** @type {{ success?: boolean }} */ (await response.json());
        return result.success === true;
    } catch (error) {
        console.error('Turnstile verification error:', error);
        return false;
    }
}

/**
 * Every value is bound rather than interpolated, so the statement stays
 * injection-proof no matter what survives sanitise(). The table's CHECK
 * constraints are the layer behind this one.
 *
 * @param {Env} env
 * @param {ContactRecord} record
 * @returns {Promise<void>}
 */
async function storeMessage(env, record) {
    if (typeof env.DB?.prepare !== 'function') {
        throw new Error('D1 binding DB is not configured');
    }

    const result = await env.DB.prepare(
        `INSERT INTO contact_messages
             (name, email, project_type, timeline,
              preferred_call_time, message, source_ip_country, user_agent)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
        .bind(
            record.name,
            record.email,
            record.project_type,
            record.timeline,
            record.preferred_call_time,
            record.message,
            record.source_ip_country,
            record.user_agent,
        )
        .run();

    if (!result.success) {
        throw new Error('D1 insert did not succeed');
    }
}

/**
 * @param {Env} env
 * @returns {boolean}
 */
function hasResend(env) {
    return Boolean(env.RESEND_API_KEY && env.CONTACT_TO_EMAIL && env.CONTACT_FROM_EMAIL);
}

/**
 * Resend is the target provider; FormSubmit stays as a fallback so the form
 * keeps working until Resend credentials are in place.
 *
 * @param {Env} env
 * @param {ContactFields} fields
 * @param {string} origin
 * @returns {Promise<void>}
 */
async function sendNotification(env, fields, origin) {
    if (hasResend(env)) {
        return sendViaResend(env, fields, origin);
    }

    if (env.FORMSUBMIT_TOKEN) {
        return sendViaFormSubmit(env.FORMSUBMIT_TOKEN, fields, origin);
    }

    throw new Error('No email provider is configured');
}

/**
 * @param {Env} env
 * @param {ContactFields} fields
 * @param {string} origin
 * @returns {Promise<void>}
 */
async function sendViaResend(env, fields, origin) {
    const from = /** @type {string} */ (env.CONTACT_FROM_EMAIL);

    const notify = resendSend(env, {
        from,
        to: [/** @type {string} */ (env.CONTACT_TO_EMAIL)],
        reply_to: fields.email,
        subject: `New portfolio inquiry — ${fields.project_type}`,
        text: inquiryBody(fields, origin),
    });

    // The visitor auto-reply is a courtesy: never fail the submission over it.
    const autoReply = resendSend(env, {
        from,
        to: [fields.email],
        subject: 'Thanks for reaching out — Dev Patel',
        text: autoResponse(origin),
    }).catch((error) => {
        console.error('Resend auto-reply failed:', error);
    });

    await notify;
    await autoReply;
}

/**
 * @param {Env} env
 * @param {Record<string, unknown>} message
 * @returns {Promise<void>}
 */
async function resendSend(env, message) {
    const response = await fetch(RESEND_URL, {
        method: 'POST',
        headers: {
            Authorization: `Bearer ${env.RESEND_API_KEY}`,
            'Content-Type': 'application/json',
        },
        body: JSON.stringify(message),
    });

    if (!response.ok) {
        throw new Error(`Resend responded ${response.status}: ${await response.text()}`);
    }
}

/**
 * @param {string} token
 * @param {ContactFields} fields
 * @param {string} origin
 * @returns {Promise<void>}
 */
async function sendViaFormSubmit(token, fields, origin) {
    const response = await fetch(`https://formsubmit.co/ajax/${token}`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            Accept: 'application/json',
        },
        body: JSON.stringify({
            ...fields,
            source: `Portfolio website — ${origin}`,
            _captcha: false,
            _template: 'table',
            _subject: `New portfolio inquiry — ${fields.project_type}`,
            _autoresponse: autoResponse(origin),
        }),
    });

    if (!response.ok) {
        throw new Error(`FormSubmit responded ${response.status}: ${await response.text()}`);
    }
}

/**
 * @param {ContactFields} fields
 * @param {string} origin
 * @returns {string}
 */
function inquiryBody(fields, origin) {
    return [
        `Name:       ${fields.name}`,
        `Email:      ${fields.email}`,
        `About:      ${fields.project_type}`,
        `Timeline:   ${fields.timeline}`,
        `Call slots: ${fields.preferred_call_time ?? '—'}`,
        '',
        'Message:',
        fields.message,
        '',
        `Source: ${origin}`,
    ].join('\n');
}

/**
 * @param {string} origin
 * @returns {string}
 */
function autoResponse(origin) {
    return [
        'Hey — your message just landed in my inbox.',
        '',
        "I'm Dev Patel — founder of Navdek and builder of fast, secure digital systems. If you've reached out, you're already thinking about building something worth launching. I want to hear all of it.",
        '',
        "I'll review your message and reply with a clear next step — typically within 24 hours.",
        '',
        `Portfolio: ${origin}`,
        '',
        'Stay curious. Stay building.',
        '',
        '— Dev Patel',
        'Founder, Navdek',
    ].join('\n');
}

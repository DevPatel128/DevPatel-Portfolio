/**
 * Dev Patel portfolio — Cloudflare Worker
 *
 * Serves the static site from the ASSETS binding, and handles contact form
 * submissions at POST /api/contact:
 *   1. Rejects bots via the honeypot field
 *   2. Rate limits per client IP using Workers KV
 *   3. Stores the message in Supabase (permanent record)
 *   4. Relays it to FormSubmit for the email notification
 *
 * Secrets required: SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, FORMSUBMIT_TOKEN
 */

const CONTACT_PATH = '/api/contact';
const HEALTH_PATH = '/api/health';
const MAX_BODY_BYTES = 16 * 1024;
const RATE_LIMIT_MAX = 5;
const RATE_LIMIT_WINDOW_S = 600;

const REQUIRED_FIELDS = ['name', 'email', 'project_type', 'timeline', 'message'];
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

const FIELD_LIMITS = {
    name: 120,
    email: 254,
    project_type: 40,
    timeline: 40,
    preferred_call_time: 160,
    message: 5000,
};

const JSON_HEADERS = {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
};

export default {
    async fetch(request, env) {
        const url = new URL(request.url);

        if (url.pathname === CONTACT_PATH) {
            return handleContact(request, env, url.origin);
        }

        if (url.pathname === HEALTH_PATH) {
            return handleHealth(env);
        }

        return env.ASSETS.fetch(request);
    },
};

function json(status, body) {
    return new Response(JSON.stringify(body), { status, headers: JSON_HEADERS });
}

/**
 * Reports whether each binding is configured. Deliberately returns booleans
 * only — never a secret value, never a secret name.
 */
function handleHealth(env) {
    const configured = {
        assets: typeof env.ASSETS?.fetch === 'function',
        rate_limit_kv: typeof env.RATE_LIMIT?.get === 'function',
        supabase: Boolean(env.SUPABASE_URL) && Boolean(env.SUPABASE_PUBLISHABLE_KEY),
        formsubmit: Boolean(env.FORMSUBMIT_TOKEN),
    };

    const ready = Object.values(configured).every(Boolean);
    return json(ready ? 200 : 503, { ready, configured });
}

async function handleContact(request, env, origin) {
    if (request.method !== 'POST') {
        return json(405, { error: 'Method not allowed' });
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

    // Honeypot: a real browser never fills this. Answer 200 so bots learn nothing.
    if (typeof payload._honey === 'string' && payload._honey.trim() !== '') {
        return json(200, { ok: true });
    }

    const clientIp = request.headers.get('cf-connecting-ip') ?? 'unknown';
    if (await isRateLimited(env, clientIp)) {
        return json(429, { error: 'Too many submissions. Please try again shortly.' });
    }

    const fields = sanitise(payload);

    const missing = REQUIRED_FIELDS.filter((field) => !fields[field]);
    if (missing.length > 0) {
        return json(422, { error: `Missing required field(s): ${missing.join(', ')}` });
    }

    if (!EMAIL_PATTERN.test(fields.email)) {
        return json(422, { error: 'Please enter a valid email address' });
    }

    const record = {
        ...fields,
        source_ip_country: request.cf?.country ?? null,
        user_agent: (request.headers.get('user-agent') ?? '').slice(0, 500),
    };

    const [stored, notified] = await Promise.allSettled([
        storeMessage(env, record),
        sendNotification(env, fields, origin),
    ]);

    if (stored.status === 'rejected') {
        console.error('Supabase insert failed:', stored.reason);
    }
    if (notified.status === 'rejected') {
        console.error('FormSubmit relay failed:', notified.reason);
    }

    // The lead is only lost if both paths failed.
    if (stored.status === 'rejected' && notified.status === 'rejected') {
        return json(502, { error: 'Could not deliver your message. Please email me directly.' });
    }

    return json(200, { ok: true });
}

function sanitise(payload) {
    const clean = {};

    for (const [field, limit] of Object.entries(FIELD_LIMITS)) {
        const value = payload[field];
        clean[field] = typeof value === 'string' ? value.trim().slice(0, limit) : '';
    }

    // Optional field: store null rather than an empty string.
    clean.preferred_call_time = clean.preferred_call_time || null;

    return clean;
}

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

async function storeMessage(env, record) {
    const response = await fetch(`${env.SUPABASE_URL}/rest/v1/contact_messages`, {
        method: 'POST',
        headers: {
            apikey: env.SUPABASE_PUBLISHABLE_KEY,
            Authorization: `Bearer ${env.SUPABASE_PUBLISHABLE_KEY}`,
            'Content-Type': 'application/json',
            Prefer: 'return=minimal',
        },
        body: JSON.stringify(record),
    });

    if (!response.ok) {
        throw new Error(`Supabase responded ${response.status}: ${await response.text()}`);
    }
}

async function sendNotification(env, fields, origin) {
    const response = await fetch(`https://formsubmit.co/ajax/${env.FORMSUBMIT_TOKEN}`, {
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

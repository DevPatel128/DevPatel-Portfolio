import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import worker, { sanitise, handleHealth, handleConfig } from '../worker/index.js';

/** In-memory stand-in for the RATE_LIMIT KV namespace. */
function kvStub() {
    /** @type {Map<string, string>} */
    const store = new Map();
    return {
        /** @param {string} key */
        async get(key) {
            return store.get(key) ?? null;
        },
        /**
         * @param {string} key
         * @param {string} value
         */
        async put(key, value) {
            store.set(key, value);
        },
    };
}

/**
 * Deliberately partial stand-in for the Worker `Env` binding — typed loose so
 * each test can supply only the bindings it exercises.
 *
 * @param {Partial<Record<string, unknown>>} [overrides]
 * @returns {any}
 */
function envStub(overrides = {}) {
    return {
        ASSETS: { fetch: async () => new Response('asset', { status: 200 }) },
        RATE_LIMIT: kvStub(),
        SUPABASE_URL: 'https://project.supabase.co',
        SUPABASE_PUBLISHABLE_KEY: 'test-publishable-key',
        FORMSUBMIT_TOKEN: 'test-token',
        ...overrides,
    };
}

/** @param {Record<string, unknown>} body */
function contactRequest(body, headers = {}) {
    return new Request('https://portfolio.test/api/contact', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...headers },
        body: JSON.stringify(body),
    });
}

const validPayload = {
    name: 'Ada Lovelace',
    email: 'ada@example.com',
    project_type: 'Project',
    timeline: 'ASAP',
    message: 'Lets build something.',
};

const realFetch = globalThis.fetch;
/** @type {Array<{ url: string, init: RequestInit | undefined }>} */
let outbound = [];

describe('worker', () => {
    beforeEach(() => {
        outbound = [];
        globalThis.fetch = /** @type {typeof fetch} */ (
            async (/** @type {any} */ url, /** @type {any} */ init) => {
                outbound.push({ url: String(url), init });
                return new Response('{}', { status: 200 });
            }
        );
    });

    afterEach(() => {
        globalThis.fetch = realFetch;
    });

    describe('sanitise', () => {
        test('trims and truncates every known field', () => {
            const fields = sanitise({ name: `  ${'a'.repeat(200)}  `, message: '  hi  ' });
            assert.equal(fields.name.length, 120);
            assert.equal(fields.message, 'hi');
        });

        test('drops unknown keys so they never reach the database', () => {
            const fields = sanitise({ ...validPayload, is_admin: 'true', cf_turnstile_response: 'x' });
            assert.deepEqual(Object.keys(fields).sort(), [
                'email',
                'message',
                'name',
                'preferred_call_time',
                'project_type',
                'timeline',
            ]);
        });

        test('normalises the optional call time to null', () => {
            assert.equal(sanitise({ preferred_call_time: '   ' }).preferred_call_time, null);
            assert.equal(sanitise({ preferred_call_time: '9:00 AM' }).preferred_call_time, '9:00 AM');
        });

        test('coerces non-string input to an empty string', () => {
            assert.equal(sanitise({ name: { toString: () => 'evil' } }).name, '');
        });
    });

    describe('routing', () => {
        test('unknown paths fall through to static assets', async () => {
            const response = await worker.fetch(new Request('https://portfolio.test/'), envStub());
            assert.equal(await response.text(), 'asset');
        });

        test('health reports ready when the required bindings exist', async () => {
            const body = await handleHealth(envStub()).json();
            assert.equal(body.ready, true);
            assert.equal(body.configured.turnstile, false);
        });

        test('health reports not-ready without an email provider', async () => {
            const env = envStub({ FORMSUBMIT_TOKEN: undefined });
            const response = handleHealth(env);
            assert.equal(response.status, 503);
            assert.equal((await response.json()).configured.email, false);
        });

        test('config exposes the turnstile site key and nothing else', async () => {
            const env = envStub({ TURNSTILE_SITE_KEY: 'site-key', TURNSTILE_SECRET_KEY: 'secret' });
            const body = await handleConfig(env).json();
            assert.deepEqual(body, { turnstile_site_key: 'site-key' });
        });

        test('config returns null when turnstile is not configured', async () => {
            const body = await handleConfig(envStub()).json();
            assert.deepEqual(body, { turnstile_site_key: null });
        });
    });

    describe('POST /api/contact', () => {
        test('rejects non-POST methods', async () => {
            const request = new Request('https://portfolio.test/api/contact');
            const response = await worker.fetch(request, envStub());
            assert.equal(response.status, 405);
        });

        test('rejects a cross-origin submission', async () => {
            const request = contactRequest(validPayload, { Origin: 'https://attacker.test' });
            const response = await worker.fetch(request, envStub());
            assert.equal(response.status, 403);
            assert.equal(outbound.length, 0);
        });

        test('accepts a same-origin submission', async () => {
            const request = contactRequest(validPayload, { Origin: 'https://portfolio.test' });
            const response = await worker.fetch(request, envStub());
            assert.equal(response.status, 200);
        });

        test('rejects a non-JSON content type', async () => {
            const request = new Request('https://portfolio.test/api/contact', {
                method: 'POST',
                headers: { 'Content-Type': 'text/plain' },
                body: 'nope',
            });
            assert.equal((await worker.fetch(request, envStub())).status, 415);
        });

        test('rejects a malformed body', async () => {
            const request = new Request('https://portfolio.test/api/contact', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: '{ not json',
            });
            assert.equal((await worker.fetch(request, envStub())).status, 400);
        });

        test('swallows honeypot hits without contacting any provider', async () => {
            const request = contactRequest({ ...validPayload, _honey: 'bot' });
            const response = await worker.fetch(request, envStub());
            assert.equal(response.status, 200);
            assert.equal(outbound.length, 0);
        });

        test('reports missing required fields', async () => {
            const request = contactRequest({ name: 'Ada' });
            const response = await worker.fetch(request, envStub());
            assert.equal(response.status, 422);
            assert.match((await response.json()).error, /email/);
        });

        test('rejects an invalid email address', async () => {
            const request = contactRequest({ ...validPayload, email: 'ada@localhost' });
            assert.equal((await worker.fetch(request, envStub())).status, 422);
        });

        test('rate limits after five submissions from one IP', async () => {
            const env = envStub();
            const headers = { 'CF-Connecting-IP': '203.0.113.7' };

            for (let i = 0; i < 5; i += 1) {
                const ok = await worker.fetch(contactRequest(validPayload, headers), env);
                assert.equal(ok.status, 200);
            }

            const blocked = await worker.fetch(contactRequest(validPayload, headers), env);
            assert.equal(blocked.status, 429);
        });

        test('stores in Supabase and notifies over FormSubmit', async () => {
            const response = await worker.fetch(contactRequest(validPayload), envStub());

            assert.equal(response.status, 200);
            assert.ok(outbound.some((call) => call.url.includes('/rest/v1/contact_messages')));
            assert.ok(outbound.some((call) => call.url.startsWith('https://formsubmit.co/ajax/')));
        });

        test('prefers Resend when it is configured', async () => {
            const env = envStub({
                RESEND_API_KEY: 'resend-key',
                CONTACT_TO_EMAIL: 'inbox@example.com',
                CONTACT_FROM_EMAIL: 'Dev <hello@example.com>',
            });

            const response = await worker.fetch(contactRequest(validPayload), env);

            assert.equal(response.status, 200);
            const resendCalls = outbound.filter((call) => call.url === 'https://api.resend.com/emails');
            assert.equal(resendCalls.length, 2, 'owner notification + visitor auto-reply');
            assert.ok(!outbound.some((call) => call.url.includes('formsubmit.co')));

            const notification = JSON.parse(String(resendCalls[0].init?.body));
            assert.equal(notification.reply_to, validPayload.email);
        });

        test('never sends the raw Supabase key to the email provider', async () => {
            await worker.fetch(contactRequest(validPayload), envStub());
            const emailCall = outbound.find((call) => call.url.includes('formsubmit.co'));
            assert.ok(!String(emailCall?.init?.body).includes('test-publishable-key'));
        });

        test('returns 502 only when both storage and email fail', async () => {
            globalThis.fetch = /** @type {typeof fetch} */ (
                async () => new Response('down', { status: 500 })
            );

            const response = await worker.fetch(contactRequest(validPayload), envStub());
            assert.equal(response.status, 502);
        });

        test('still succeeds when only Supabase fails', async () => {
            globalThis.fetch = /** @type {typeof fetch} */ (
                async (/** @type {any} */ url) =>
                    String(url).includes('supabase')
                        ? new Response('down', { status: 500 })
                        : new Response('{}', { status: 200 })
            );

            const response = await worker.fetch(contactRequest(validPayload), envStub());
            assert.equal(response.status, 200);
        });
    });

    describe('turnstile', () => {
        const turnstileEnv = () =>
            envStub({ TURNSTILE_SECRET_KEY: 'secret', TURNSTILE_SITE_KEY: 'site-key' });

        test('rejects a submission with no token', async () => {
            const response = await worker.fetch(contactRequest(validPayload), turnstileEnv());
            assert.equal(response.status, 403);
            assert.equal(outbound.length, 0);
        });

        test('rejects a token Cloudflare marks invalid', async () => {
            globalThis.fetch = /** @type {typeof fetch} */ (
                async () => new Response(JSON.stringify({ success: false }), { status: 200 })
            );

            const response = await worker.fetch(
                contactRequest({ ...validPayload, cf_turnstile_response: 'bad-token' }),
                turnstileEnv(),
            );
            assert.equal(response.status, 403);
        });

        test('accepts a verified token and never forwards it downstream', async () => {
            globalThis.fetch = /** @type {typeof fetch} */ (
                async (/** @type {any} */ url, /** @type {any} */ init) => {
                    outbound.push({ url: String(url), init });
                    return String(url).includes('siteverify')
                        ? new Response(JSON.stringify({ success: true }), { status: 200 })
                        : new Response('{}', { status: 200 });
                }
            );

            const response = await worker.fetch(
                contactRequest({ ...validPayload, cf_turnstile_response: 'good-token' }),
                turnstileEnv(),
            );

            assert.equal(response.status, 200);
            const verify = outbound.find((call) => call.url.includes('siteverify'));
            assert.ok(verify, 'siteverify was called');

            const stored = outbound.find((call) => call.url.includes('/rest/v1/contact_messages'));
            assert.ok(!String(stored?.init?.body).includes('good-token'));
        });
    });
});

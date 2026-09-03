-- Contact form intake for the portfolio site.
--
-- Written to by the Cloudflare Worker (POST /api/contact) through the DB
-- binding. Unlike the Supabase setup this replaces, there is no publishable
-- key and no public REST endpoint: the only path to this table is the Worker
-- itself, so row-level security has nothing to protect against.
--
-- The Worker validates and truncates every field before it gets here; the
-- CHECK constraints below are the second line of defence so the database stays
-- consistent even if it is ever written to directly via `wrangler d1 execute`.

CREATE TABLE IF NOT EXISTS contact_messages (
    id                  TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
    created_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    name                TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
    email               TEXT NOT NULL CHECK (length(email) BETWEEN 3 AND 254),
    project_type        TEXT NOT NULL CHECK (length(project_type) BETWEEN 1 AND 40),
    timeline            TEXT NOT NULL CHECK (length(timeline) BETWEEN 1 AND 40),
    preferred_call_time TEXT CHECK (preferred_call_time IS NULL OR length(preferred_call_time) <= 160),
    message             TEXT NOT NULL CHECK (length(message) BETWEEN 1 AND 5000),
    source_ip_country   TEXT CHECK (source_ip_country IS NULL OR length(source_ip_country) <= 2),
    user_agent          TEXT CHECK (user_agent IS NULL OR length(user_agent) <= 500)
);

-- Newest-first is the only way this table is ever read.
CREATE INDEX IF NOT EXISTS contact_messages_created_at_idx
    ON contact_messages (created_at DESC);

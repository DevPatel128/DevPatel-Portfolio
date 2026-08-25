-- Contact form intake for the portfolio site.
--
-- Written to by the Cloudflare Worker (POST /api/contact) using the Supabase
-- publishable/anon key. The Worker validates and truncates every field before
-- it gets here; the CHECK constraints below are the second line of defence so
-- the database is safe even if it is ever written to directly.

create table if not exists public.contact_messages (
    id                  uuid primary key default gen_random_uuid(),
    created_at          timestamptz not null default now(),
    name                text not null check (char_length(name) between 1 and 120),
    email               text not null check (char_length(email) between 3 and 254),
    project_type        text not null check (char_length(project_type) between 1 and 40),
    timeline            text not null check (char_length(timeline) between 1 and 40),
    preferred_call_time text check (char_length(preferred_call_time) <= 160),
    message             text not null check (char_length(message) between 1 and 5000),
    source_ip_country   text check (char_length(source_ip_country) <= 2),
    user_agent          text check (char_length(user_agent) <= 500)
);

comment on table public.contact_messages is
    'Portfolio contact form submissions. Insert-only for anon; readable only via service_role.';

-- Newest-first is the only way this table is ever read.
create index if not exists contact_messages_created_at_idx
    on public.contact_messages (created_at desc);

alter table public.contact_messages enable row level security;

-- Insert-only for the anon role. There is deliberately no SELECT, UPDATE or
-- DELETE policy, so the publishable key cannot read anyone else's message —
-- only service_role (the dashboard) can.
drop policy if exists "anon may submit a contact message" on public.contact_messages;
create policy "anon may submit a contact message"
    on public.contact_messages
    for insert
    to anon
    with check (true);

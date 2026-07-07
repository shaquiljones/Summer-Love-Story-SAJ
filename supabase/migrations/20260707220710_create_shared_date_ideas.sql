-- Documentation migration for the "Add Activity" shared date-idea board.
--
-- This table already exists in the production Supabase project
-- (zhvoyvjpytauobqdszkm) and is only ever read/written by the
-- `love-date-board` edge function using the service-role key. This file is
-- committed for version-control / documentation purposes so the schema lives
-- alongside the code that depends on it. It is NOT applied automatically as
-- part of any deployment in this repository, and running it against
-- production is a manual, deliberate decision — not something this project's
-- tooling does for you.
--
-- Row Level Security is enabled with no public policies attached, so the
-- table is not directly queryable by anon/authenticated clients. All access
-- goes through the edge function, which enforces the shared board key.

create table if not exists public.shared_date_ideas (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  source_url text not null,
  planned_for date,
  submitted_by text not null check (submitted_by in ('Shaq', 'Drea')),
  preview_image_url text,
  preview_title text,
  created_at timestamptz not null default now()
);

alter table public.shared_date_ideas enable row level security;

-- Intentionally no policies are created here: with RLS enabled and zero
-- policies, all access via the anon/authenticated Postgres roles is denied
-- by default. Only the service-role key (used exclusively inside the
-- `love-date-board` edge function) can read or write this table.

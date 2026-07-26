-- Documentation migration for the cross-device sync of Photo Book, Calendar,
-- Eats/Restaurants, and the new Movie List tab.
--
-- Same pattern as 20260707220710_create_shared_date_ideas.sql: these tables
-- live in the production Supabase project (zhvoyvjpytauobqdszkm) and are only
-- ever read/written by the `love-date-board` edge function using the
-- service-role key. This file is committed for version-control /
-- documentation purposes so the schema lives alongside the code that depends
-- on it. It is NOT applied automatically as part of any deployment in this
-- repository — running it against production is a manual, deliberate
-- decision, not something this project's tooling does for you.
--
-- Row Level Security is enabled with no public policies attached on every
-- table, so none of them are directly queryable by anon/authenticated
-- clients. All access goes through the edge function, which enforces the
-- shared board key (the same code already used to unlock Add Activity).

create table if not exists public.shared_photos (
  id uuid primary key default gen_random_uuid(),
  src_url text not null,
  caption text,
  taken_on text,
  storage_path text not null,
  created_at timestamptz not null default now()
);

create table if not exists public.shared_calendar_events (
  id uuid primary key default gen_random_uuid(),
  event_date date not null,
  title text not null,
  event_time text,
  category text not null check (category in ('Date Night', 'Dinner', 'Fun/Outing', 'Trip')),
  created_at timestamptz not null default now()
);

create table if not exists public.shared_restaurants (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  addr text,
  description text,
  link text,
  created_at timestamptz not null default now()
);

create table if not exists public.shared_movies (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  poster_url text,
  added_by text check (added_by in ('Shaq', 'Drea')),
  watched boolean not null default false,
  created_at timestamptz not null default now()
);

alter table public.shared_photos enable row level security;
alter table public.shared_calendar_events enable row level security;
alter table public.shared_restaurants enable row level security;
alter table public.shared_movies enable row level security;

-- Intentionally no policies are created on any of these tables: with RLS
-- enabled and zero policies, all access via the anon/authenticated Postgres
-- roles is denied by default. Only the service-role key (used exclusively
-- inside the `love-date-board` edge function) can read or write these rows.

-- A public Storage bucket also needs to exist for Photo Book uploads:
--   supabase storage buckets create date-photos --public
-- Photo binaries are uploaded by the edge function with the service-role
-- key (never directly from the browser), so no Storage RLS policy grants
-- public/anon write access — only public *read* access on the bucket itself
-- (needed so <img> tags can load photos on both phones), matching the same
-- "server writes, client only reads" model as the rest of this file.

-- Malkiaa Studio: initial database schema
-- Apply ONLY to the empty STAGING Supabase project.
-- This schema intentionally gives visitors no direct table access.
-- Public order submission/tracking and uploads must go through commission-api.
-- Creator table access is restricted by public.is_owner().

begin;

create extension if not exists pgcrypto;

-- Creator allow-list. Add the owner's auth.users UUID here after creating the Auth user.
create table if not exists public.admins (
  user_id uuid primary key references auth.users(id) on delete cascade,
  created_at timestamptz not null default now()
);

create or replace function public.is_owner()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.admins a
    where a.user_id = (select auth.uid())
  );
$$;

revoke all on function public.is_owner() from public;
grant execute on function public.is_owner() to authenticated;

-- Main commission request; form and estimate retain the website's JSON payloads.
create table if not exists public.commission_requests (
  id text primary key,
  created_at timestamptz not null default now(),
  "createdAt" text,
  status text not null default 'Pending Review',
  payment text not null default 'Unpaid',
  "serviceId" text,
  "serviceTitle" text,
  "tierName" text,
  form jsonb not null default '{}'::jsonb,
  estimate jsonb not null default '{}'::jsonb,
  notes text not null default '',
  "finalPrice" numeric,
  "extraLines" text not null default ''
);

create index if not exists commission_requests_created_at_idx
  on public.commission_requests (created_at desc);

-- Client tracking view. Access is mediated by commission-api, not table policies.
create table if not exists public.order_tracks (
  id text primary key references public.commission_requests(id) on delete cascade,
  created_at timestamptz not null default now(),
  "createdAt" text,
  "serviceTitle" text,
  status text,
  payment text,
  estimate numeric,
  custom boolean not null default false,
  "emailHash" text not null,
  proposal jsonb,
  updates jsonb not null default '[]'::jsonb,
  "finalFiles" jsonb not null default '[]'::jsonb
);

-- Creator-only operational fields.
create table if not exists public.commission_management (
  id text primary key references public.commission_requests(id) on delete cascade,
  status text,
  payment text,
  notes text,
  "finalPrice" numeric,
  "extraLines" text
);

create table if not exists public.app_settings (
  key text primary key,
  value jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

create table if not exists public.email_notification_log (
  id text primary key,
  sent_at timestamptz not null default now(),
  type text,
  recipient text
);

-- Dashboard notification history. Edge Functions (service role) create records.
create table if not exists public.notifications (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  order_id text,
  kind text not null default 'email',
  status text not null default 'queued',
  message text,
  recipient text,
  attempts integer not null default 0,
  sent_at timestamptz
);

create index if not exists notifications_created_at_idx
  on public.notifications (created_at desc);

-- Server-side rate-limit audit for tracking lookups.
create table if not exists public.track_attempts (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  request_id text,
  ip_hash text,
  succeeded boolean not null default false
);

create index if not exists track_attempts_created_at_idx
  on public.track_attempts (created_at desc);

-- Enable RLS on every application table.
alter table public.admins enable row level security;
alter table public.commission_requests enable row level security;
alter table public.order_tracks enable row level security;
alter table public.commission_management enable row level security;
alter table public.app_settings enable row level security;
alter table public.email_notification_log enable row level security;
alter table public.notifications enable row level security;
alter table public.track_attempts enable row level security;

-- Remove legacy permissive policies if this script is ever reapplied to staging.
drop policy if exists admins_read_self on public.admins;
drop policy if exists creator_read_requests on public.commission_requests;
drop policy if exists creator_update_requests on public.commission_requests;
drop policy if exists creator_insert_requests on public.commission_requests;
drop policy if exists creator_read_tracks on public.order_tracks;
drop policy if exists creator_update_tracks on public.order_tracks;
drop policy if exists creator_insert_tracks on public.order_tracks;
drop policy if exists creator_manage_commissions on public.commission_management;
drop policy if exists creator_manage_settings on public.app_settings;
drop policy if exists creator_read_notifications on public.notifications;

-- Only a signed-in user can read their own allow-list row.
create policy admins_read_self on public.admins
  for select to authenticated
  using (user_id = (select auth.uid()));

-- All operational access is owner-only. Visitors use the Edge Function.
create policy creator_read_requests on public.commission_requests
  for select to authenticated using ((select public.is_owner()));
create policy creator_insert_requests on public.commission_requests
  for insert to authenticated with check ((select public.is_owner()));
create policy creator_update_requests on public.commission_requests
  for update to authenticated
  using ((select public.is_owner()))
  with check ((select public.is_owner()));

create policy creator_read_tracks on public.order_tracks
  for select to authenticated using ((select public.is_owner()));
create policy creator_insert_tracks on public.order_tracks
  for insert to authenticated with check ((select public.is_owner()));
create policy creator_update_tracks on public.order_tracks
  for update to authenticated
  using ((select public.is_owner()))
  with check ((select public.is_owner()));

create policy creator_manage_commissions on public.commission_management
  for all to authenticated
  using ((select public.is_owner()))
  with check ((select public.is_owner()));

create policy creator_manage_settings on public.app_settings
  for all to authenticated
  using ((select public.is_owner()))
  with check ((select public.is_owner()));

create policy creator_read_notifications on public.notifications
  for select to authenticated using ((select public.is_owner()));

-- Explicit table grants: no anon access. service_role bypasses RLS in Edge Functions.
revoke all on public.admins, public.commission_requests, public.order_tracks,
  public.commission_management, public.app_settings, public.email_notification_log,
  public.notifications, public.track_attempts from anon, authenticated;

grant select on public.admins to authenticated;
grant select, insert, update on public.commission_requests to authenticated;
grant select, insert, update on public.order_tracks to authenticated;
grant select, insert, update, delete on public.commission_management to authenticated;
grant select, insert, update, delete on public.app_settings to authenticated;
grant select on public.notifications to authenticated;

-- Private references bucket. Upload/download authorization is issued by commission-api.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'references',
  'references',
  false,
  15728640,
  array['image/jpeg','image/png','image/webp','image/gif','application/pdf']
)
on conflict (id) do update
set public = false,
    file_size_limit = excluded.file_size_limit,
    allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists creator_read_reference_files on storage.objects;
drop policy if exists creator_delete_reference_files on storage.objects;

create policy creator_read_reference_files on storage.objects
  for select to authenticated
  using (bucket_id = 'references' and (select public.is_owner()));

create policy creator_delete_reference_files on storage.objects
  for delete to authenticated
  using (bucket_id = 'references' and (select public.is_owner()));

commit;

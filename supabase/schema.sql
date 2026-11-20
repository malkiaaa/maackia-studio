-- Malkiaa Studio: initial database schema
-- Apply ONLY to the empty STAGING Supabase project.
-- This schema intentionally gives visitors no direct table access.
-- Public order submission/tracking and uploads must go through commission-api.
-- Creator table access is restricted by public.is_owner().

begin;

create extension if not exists pgcrypto;

-- Atomic yearly sequence for public commission IDs.
create table if not exists public.commission_counters (
  year integer primary key,
  last_number integer not null default 0
);

create or replace function public.next_commission_id()
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  current_year integer := extract(year from now())::integer;
  next_number integer;
begin
  insert into public.commission_counters (year, last_number)
  values (current_year, 1)
  on conflict (year) do update
    set last_number = public.commission_counters.last_number + 1
  returning last_number into next_number;
  return 'COMMISSION-' || current_year::text || '-' || lpad(next_number::text, 4, '0');
end;
$$;
revoke all on function public.next_commission_id() from public, anon, authenticated;
grant execute on function public.next_commission_id() to service_role;

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
  client_name text not null default 'Client',
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
alter table public.commission_counters enable row level security;
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
  public.notifications, public.track_attempts, public.commission_counters from anon, authenticated;

grant select on public.admins to authenticated;
grant select, insert, update on public.commission_requests to authenticated;
grant select, insert, update on public.order_tracks to authenticated;
grant select, insert, update, delete on public.commission_management to authenticated;
grant select, insert, update, delete on public.app_settings to authenticated;
grant select on public.notifications to authenticated;

-- Edge Functions use the service role only on the server.
grant all on public.admins, public.commission_requests, public.order_tracks,
  public.commission_management, public.app_settings, public.email_notification_log,
  public.notifications, public.track_attempts, public.commission_counters to service_role;

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


-- One server-side write path for the three commission state tables.
-- emailHash is intentionally not accepted in p_track_patch.
create or replace function public.sync_commission_state(
  p_commission_id text,
  p_status text,
  p_payment text,
  p_notes text,
  p_final_price numeric,
  p_extra_lines text,
  p_track_patch jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $
declare
  v_track public.order_tracks%rowtype;
begin
  if coalesce(p_commission_id, '') !~ '^COMMISSION-[0-9]{4}-[0-9]{4,}
     or p_status not in (
       'Pending Review', 'Reviewing', 'Proposal Sent',
       'Awaiting Client Approval', 'Awaiting Payment', 'Paid',
       'In Progress', 'Waiting for Feedback', 'Revision',
       'Completed', 'Cancelled', 'Rejected'
     )
     or p_payment not in ('Unpaid', 'Invoice sent', 'Paid', 'Refunded')
     or p_track_patch is null
     or pg_catalog.jsonb_typeof(p_track_patch) is distinct from 'object'
     or p_track_patch ? 'emailHash' then
    raise exception 'Invalid commission state payload' using errcode = '22023';
  end if;

  if p_track_patch ? 'updates'
     and pg_catalog.jsonb_typeof(p_track_patch->'updates') is distinct from 'array' then
    raise exception 'Tracking updates must be an array' using errcode = '22023';
  end if;

  if p_track_patch ? 'finalFiles'
     and pg_catalog.jsonb_typeof(p_track_patch->'finalFiles') is distinct from 'array' then
    raise exception 'Final files must be an array' using errcode = '22023';
  end if;

  if p_track_patch ? 'proposal'
     and p_track_patch->'proposal' <> 'null'::jsonb
     and pg_catalog.jsonb_typeof(p_track_patch->'proposal') is distinct from 'object' then
    raise exception 'Proposal must be an object or null' using errcode = '22023';
  end if;

  update public.commission_requests
     set status = p_status,
         payment = p_payment,
         notes = coalesce(p_notes, ''),
         "finalPrice" = p_final_price,
         "extraLines" = coalesce(p_extra_lines, '')
   where id = p_commission_id;

  if not found then
    raise exception 'Commission request not found' using errcode = 'P0002';
  end if;

  insert into public.commission_management (
    id, status, payment, notes, "finalPrice", "extraLines"
  ) values (
    p_commission_id, p_status, p_payment, coalesce(p_notes, ''),
    p_final_price, coalesce(p_extra_lines, '')
  )
  on conflict (id) do update set
    status = excluded.status,
    payment = excluded.payment,
    notes = excluded.notes,
    "finalPrice" = excluded."finalPrice",
    "extraLines" = excluded."extraLines";

  update public.order_tracks
     set status = p_status,
         payment = p_payment,
         proposal = case
           when p_track_patch ? 'proposal' then nullif(p_track_patch->'proposal', 'null'::jsonb)
           else proposal
         end,
         updates = case
           when p_track_patch ? 'updates' then p_track_patch->'updates'
           else updates
         end,
         "finalFiles" = case
           when p_track_patch ? 'finalFiles' then p_track_patch->'finalFiles'
           else "finalFiles"
         end,
         estimate = case
           when p_track_patch ? 'estimate' then (p_track_patch->>'estimate')::numeric
           else estimate
         end,
         custom = case
           when p_track_patch ? 'custom' then (p_track_patch->>'custom')::boolean
           else custom
         end
   where id = p_commission_id
   returning * into v_track;

  if not found then
    raise exception 'Tracking record not found' using errcode = 'P0002';
  end if;

  return pg_catalog.to_jsonb(v_track);
end;
$;

revoke all on function public.sync_commission_state(text, text, text, text, numeric, text, jsonb)
  from public, anon, authenticated;
grant execute on function public.sync_commission_state(text, text, text, text, numeric, text, jsonb)
  to service_role;


commit;

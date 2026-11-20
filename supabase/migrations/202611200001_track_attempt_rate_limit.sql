-- Atomic tracking rate limit for Malkiaa Studio.
-- Apply manually to the STAGING Supabase project only.
-- No raw IP address or email address is stored by these functions.
begin;

alter table public.track_attempts
  add column if not exists email_hash text;

create index if not exists track_attempts_rate_limit_idx
  on public.track_attempts (ip_hash, email_hash, request_id, created_at desc)
  where succeeded = false;

create index if not exists track_attempts_cleanup_idx
  on public.track_attempts (created_at);

create or replace function public.record_track_attempt(
  p_ip_hash text,
  p_email_hash text,
  p_request_id text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_failed_count integer := 0;
  v_attempt_id uuid;
  v_allowed boolean;
  v_lock_key bigint;
begin
  if coalesce(length(p_ip_hash), 0) <> 64
     or coalesce(length(p_email_hash), 0) <> 64
     or p_request_id is null
     or length(p_request_id) > 80 then
    raise exception 'Invalid tracking rate-limit key' using errcode = '22023';
  end if;

  v_lock_key := pg_catalog.hashtextextended(
    p_ip_hash || ':' || p_email_hash || ':' || p_request_id,
    0
  );
  perform pg_catalog.pg_advisory_xact_lock(v_lock_key);

  -- Keep a bounded audit window. The table already has a created_at index.
  delete from public.track_attempts
   where created_at < now() - interval '30 days';

  select count(*)::integer
    into v_failed_count
    from public.track_attempts
   where ip_hash = p_ip_hash
     and email_hash = p_email_hash
     and request_id = p_request_id
     and succeeded = false
     and created_at >= now() - interval '15 minutes';

  v_allowed := v_failed_count < 5;

  -- Every attempt is recorded. It is pessimistically marked failed until
  -- the Edge Function confirms that both Request ID and email matched.
  insert into public.track_attempts (ip_hash, email_hash, request_id, succeeded)
  values (p_ip_hash, p_email_hash, p_request_id, false)
  returning id into v_attempt_id;

  return jsonb_build_object(
    'allowed', v_allowed,
    'attempt_id', v_attempt_id,
    'failed_count', v_failed_count + 1
  );
end;
$$;

create or replace function public.mark_track_attempt_success(p_attempt_id uuid)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.track_attempts
     set succeeded = true
   where id = p_attempt_id;
  return found;
end;
$$;

create or replace function public.cleanup_track_attempts()
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_deleted integer;
begin
  delete from public.track_attempts
   where created_at < now() - interval '30 days';
  get diagnostics v_deleted = row_count;
  return v_deleted;
end;
$$;

revoke all on function public.record_track_attempt(text, text, text) from public, anon, authenticated;
revoke all on function public.mark_track_attempt_success(uuid) from public, anon, authenticated;
revoke all on function public.cleanup_track_attempts() from public, anon, authenticated;
grant execute on function public.record_track_attempt(text, text, text) to service_role;
grant execute on function public.mark_track_attempt_success(uuid) to service_role;
grant execute on function public.cleanup_track_attempts() to service_role;

commit;

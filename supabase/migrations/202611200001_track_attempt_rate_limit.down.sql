-- DOWN / rollback for 202611200001_track_attempt_rate_limit.sql
-- Run manually in STAGING only after disabling/reverting the Edge Function
-- code that calls these RPCs. Existing attempt rows are preserved.
begin;
revoke all on function public.record_track_attempt(text, text, text) from public, anon, authenticated, service_role;
revoke all on function public.mark_track_attempt_success(uuid) from public, anon, authenticated, service_role;
revoke all on function public.cleanup_track_attempts() from public, anon, authenticated, service_role;
drop function if exists public.record_track_attempt(text, text, text);
drop function if exists public.mark_track_attempt_success(uuid);
drop function if exists public.cleanup_track_attempts();
drop index if exists public.track_attempts_rate_limit_idx;
drop index if exists public.track_attempts_cleanup_idx;
alter table public.track_attempts drop column if exists email_hash;
commit;

-- DOWN / rollback for 202611200002_atomic_commissions.sql
-- Revert the Edge Function to its pre-RPC version before running this script.
-- This drops idempotency history, but leaves commission/order data untouched.
begin;
revoke all on function public.submit_commission_atomic(text, text, jsonb, jsonb) from public, anon, authenticated, service_role;
revoke all on function public.delete_commission_atomic(text) from public, anon, authenticated, service_role;
drop function if exists public.submit_commission_atomic(text, text, jsonb, jsonb);
drop function if exists public.delete_commission_atomic(text);
drop table if exists public.commission_submit_keys;
commit;

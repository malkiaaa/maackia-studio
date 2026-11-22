-- Rollback for 202611230001_respond_commission_proposal.sql.
begin;
revoke all on function public.respond_commission_proposal(text, text, text)
  from public, anon, authenticated, service_role;
drop function if exists public.respond_commission_proposal(text, text, text);
commit;

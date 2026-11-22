-- Atomic, one-time client response to a commission proposal.
-- This migration adds a database function only; no table or column is changed.
-- Apply to an isolated staging Supabase project before deploying the Edge Function.

begin;

create or replace function public.respond_commission_proposal(
  p_commission_id text,
  p_response text,
  p_note text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_order public.commission_requests%rowtype;
  v_track public.order_tracks%rowtype;
  v_status text;
  v_now timestamptz := pg_catalog.clock_timestamp();
  v_proposal jsonb;
  v_updates jsonb;
  v_updated jsonb;
begin
  if coalesce(p_commission_id, '') !~ '^COMMISSION-[0-9]{4}-[0-9]{4,}$'
     or p_response is null
     or p_response not in ('Accepted', 'Declined')
     or coalesce(length(p_note), 0) > 1000 then
    raise exception 'Invalid proposal response payload' using errcode = '22023';
  end if;

  -- Lock in the same order used by sync_commission_state:
  -- commission_requests first, then order_tracks. This avoids lock inversion
  -- with Creator-side commission updates.
  select *
    into v_order
    from public.commission_requests
   where id = p_commission_id
   for update;

  if not found then
    return pg_catalog.jsonb_build_object('ok', false, 'code', 'NOT_FOUND');
  end if;

  select *
    into v_track
    from public.order_tracks
   where id = p_commission_id
   for update;

  if not found then
    return pg_catalog.jsonb_build_object('ok', false, 'code', 'NOT_FOUND');
  end if;

  if v_track.proposal is null
     or pg_catalog.jsonb_typeof(v_track.proposal) is distinct from 'object' then
    return pg_catalog.jsonb_build_object('ok', false, 'code', 'NO_PROPOSAL');
  end if;

  if pg_catalog.jsonb_typeof(coalesce(v_track.updates, '[]'::jsonb)) is distinct from 'array' then
    raise exception 'Commission tracking updates are invalid' using errcode = '22023';
  end if;

  if v_track.proposal->>'response' in ('Accepted', 'Declined')
     or coalesce(v_track.proposal->>'respondedAt', '') <> '' then
    return pg_catalog.jsonb_build_object('ok', false, 'code', 'ALREADY_RESPONDED');
  end if;

  if v_order.status not in ('Proposal Sent', 'Awaiting Client Approval')
     or v_track.status not in ('Proposal Sent', 'Awaiting Client Approval') then
    return pg_catalog.jsonb_build_object('ok', false, 'code', 'NOT_PENDING');
  end if;

  v_status := case
    when p_response = 'Accepted' then 'Awaiting Payment'
    else 'Cancelled'
  end;

  v_proposal := v_track.proposal || pg_catalog.jsonb_build_object(
    'response', p_response,
    'respondedAt', v_now
  );

  v_updates := coalesce(v_track.updates, '[]'::jsonb) ||
    pg_catalog.jsonb_build_array(
      pg_catalog.jsonb_build_object(
        'at', v_now,
        'from', 'client',
        'decision', p_response,
        'text', coalesce(
          nullif(pg_catalog.btrim(p_note), ''),
          'Client: ' || p_response
        )
      )
    );

  -- [ATOMIC GUARD] Only the first request can change a pending proposal.
  -- Concurrent/replayed requests see the new status/response and cannot pass.
  update public.order_tracks
     set status = v_status,
         proposal = v_proposal,
         updates = v_updates
   where id = p_commission_id
     and status in ('Proposal Sent', 'Awaiting Client Approval')
     and proposal is not null
     and coalesce(proposal->>'response', '') not in ('Accepted', 'Declined')
     and coalesce(proposal->>'respondedAt', '') = ''
   returning * into v_track;

  if not found then
    return pg_catalog.jsonb_build_object('ok', false, 'code', 'ALREADY_RESPONDED');
  end if;

  -- Reuse the established synchronization function. Because this call is
  -- inside the same transaction, any failure rolls back the guarded update.
  v_updated := public.sync_commission_state(
    p_commission_id,
    v_status,
    coalesce(v_track.payment, 'Unpaid'),
    coalesce(v_order.notes, ''),
    v_order."finalPrice",
    coalesce(v_order."extraLines", ''),
    pg_catalog.jsonb_build_object(
      'proposal', v_proposal,
      'updates', v_updates
    )
  );

  return pg_catalog.jsonb_build_object(
    'ok', true,
    'track', v_updated
  );
end;
$function$;

revoke all on function public.respond_commission_proposal(text, text, text)
  from public, anon, authenticated;
grant execute on function public.respond_commission_proposal(text, text, text)
  to service_role;

commit;

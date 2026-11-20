begin;

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
as $$
declare
  v_track public.order_tracks%rowtype;
  v_status text;
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

  v_status := case
    when p_payment = 'Paid' and p_status = 'Awaiting Payment' then 'Paid'
    else p_status
  end;

  update public.commission_requests
     set status = v_status,
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
    p_commission_id, v_status, p_payment, coalesce(p_notes, ''),
    p_final_price, coalesce(p_extra_lines, '')
  )
  on conflict (id) do update set
    status = excluded.status,
    payment = excluded.payment,
    notes = excluded.notes,
    "finalPrice" = excluded."finalPrice",
    "extraLines" = excluded."extraLines";

  update public.order_tracks
     set status = v_status,
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
$$;

revoke all on function public.sync_commission_state(text, text, text, text, numeric, text, jsonb)
  from public, anon, authenticated;
grant execute on function public.sync_commission_state(text, text, text, text, numeric, text, jsonb)
  to service_role;

-- Repair legacy split-brain state from the Creator management record.
-- This migration intentionally does not touch emailHash or client review rows.
update public.commission_requests r
   set status = case
         when coalesce(m.payment, r.payment) = 'Paid'
          and coalesce(m.status, r.status) = 'Awaiting Payment' then 'Paid'
         else coalesce(m.status, r.status)
       end,
       payment = coalesce(m.payment, r.payment),
       notes = coalesce(m.notes, r.notes),
       "finalPrice" = coalesce(m."finalPrice", r."finalPrice"),
       "extraLines" = coalesce(m."extraLines", r."extraLines")
  from public.commission_management m
 where m.id = r.id
   and (m.status is not null or m.payment is not null);

update public.order_tracks t
   set status = r.status,
       payment = r.payment
  from public.commission_requests r
 where r.id = t.id;

commit;

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
$$;

revoke all on function public.sync_commission_state(text, text, text, text, numeric, text, jsonb)
  from public, anon, authenticated;
grant execute on function public.sync_commission_state(text, text, text, text, numeric, text, jsonb)
  to service_role;

-- Repair legacy split-brain state from the Creator management record.
-- This migration intentionally does not touch emailHash or client review rows.
update public.commission_requests r
   set status = coalesce(m.status, r.status),
       payment = coalesce(m.payment, r.payment),
       notes = coalesce(m.notes, r.notes),
       "finalPrice" = coalesce(m."finalPrice", r."finalPrice"),
       "extraLines" = coalesce(m."extraLines", r."extraLines")
  from public.commission_management m
 where m.id = r.id
   and (m.status is not null or m.payment is not null);

update public.order_tracks t
   set status = r.status,
       payment = r.payment
  from public.commission_requests r
 where r.id = t.id;

commit;

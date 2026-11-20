-- Staging integration tests for submit_commission_atomic() and delete_commission_atomic().
-- Run only AFTER 202611200002_atomic_commissions.sql has been applied to STAGING.
-- All test writes are rolled back. Uses a synthetic commission ID and no payment calls.
begin;

do $$
declare
  v_id text := 'COMMISSION-2099-987654321';
  v_order jsonb;
  v_track jsonb;
  v_first jsonb;
  v_second jsonb;
  v_deleted boolean;
  v_failed boolean := false;
begin
  if exists (select 1 from public.commission_requests where id = v_id) then
    raise exception 'Synthetic test commission ID already exists; choose another ID.';
  end if;

  v_order := jsonb_build_object(
    'id', v_id,
    'created_at', now()::text,
    'createdAt', now()::text,
    'serviceId', 'test-service',
    'serviceTitle', 'Atomic RPC Test',
    'tierName', 'Test tier',
    'form', jsonb_build_object('email', 'atomic-test@example.invalid'),
    'estimate', jsonb_build_object('total', 12345, 'custom', false)
  );
  v_track := jsonb_build_object(
    'id', v_id,
    'created_at', 'not-a-timestamp',
    'createdAt', now()::text,
    'emailHash', repeat('c', 64),
    'client_name', 'SQL Test'
  );

  -- Force failure after commission_requests insert; the RPC call must roll back it.
  begin
    perform public.submit_commission_atomic(repeat('a', 64), repeat('b', 64), v_order, v_track);
  exception when invalid_datetime_format then
    v_failed := true;
  end;
  if not v_failed then
    raise exception 'Expected tracking timestamp failure was not raised.';
  end if;
  if exists (select 1 from public.commission_requests where id = v_id) then
    raise exception 'Atomic rollback failed: commission_requests row survived tracking insert failure.';
  end if;

  v_track := jsonb_set(v_track, '{created_at}', to_jsonb(now()::text));
  v_first := public.submit_commission_atomic(repeat('a', 64), repeat('b', 64), v_order, v_track);
  if (v_first->>'duplicate')::boolean is distinct from false then
    raise exception 'First submit should not be marked duplicate: %', v_first;
  end if;
  if v_first->'track'->>'id' <> v_id then
    raise exception 'First submit returned unexpected commission ID: %', v_first;
  end if;

  v_second := public.submit_commission_atomic(repeat('a', 64), repeat('b', 64), v_order, v_track);
  if (v_second->>'duplicate')::boolean is distinct from true
     or v_second->'track'->>'id' <> v_id then
    raise exception 'Idempotent replay did not return the original commission: %', v_second;
  end if;
  if (select count(*) from public.commission_requests where id = v_id) <> 1
     or (select count(*) from public.order_tracks where id = v_id) <> 1 then
    raise exception 'Idempotent replay created duplicate rows.';
  end if;

  begin
    perform public.submit_commission_atomic(repeat('a', 64), repeat('d', 64), v_order, v_track);
    raise exception 'Expected idempotency conflict was not raised.';
  exception when raise_exception then
    if sqlerrm <> 'IDEMPOTENCY_KEY_CONFLICT' then raise; end if;
  end;

  v_deleted := public.delete_commission_atomic(v_id);
  if v_deleted is distinct from true then
    raise exception 'Atomic deletion did not report a deleted commission.';
  end if;
  if exists (select 1 from public.commission_requests where id = v_id)
     or exists (select 1 from public.order_tracks where id = v_id)
     or exists (select 1 from public.commission_management where id = v_id)
     or exists (select 1 from public.notifications where order_id = v_id)
     or exists (select 1 from public.client_reviews where commission_id = v_id) then
    raise exception 'Atomic deletion left related commission rows behind.';
  end if;

  begin
    perform public.submit_commission_atomic(repeat('a', 64), repeat('b', 64), v_order, v_track);
    raise exception 'Expected retired idempotency key rejection was not raised.';
  exception when raise_exception then
    if sqlerrm <> 'IDEMPOTENCY_KEY_RETIRED' then raise; end if;
  end;

  raise notice 'PASS: rollback, single-row insert, idempotent replay, conflict rejection, and atomic deletion.';
end;
$$;

rollback;

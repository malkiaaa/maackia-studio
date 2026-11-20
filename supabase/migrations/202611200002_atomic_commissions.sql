-- Atomic commission submit/delete RPCs with idempotency.
-- Apply manually to the STAGING Supabase project only. Never run against production.
-- Payment state and payment provider flows are intentionally untouched.
begin;

create table if not exists public.commission_submit_keys (
  key_hash text primary key check (key_hash ~ '^[0-9a-f]{64}$'),
  request_hash text not null check (request_hash ~ '^[0-9a-f]{64}$'),
  commission_id text not null,
  created_at timestamptz not null default now(),
  deleted_at timestamptz
);

create index if not exists commission_submit_keys_commission_idx
  on public.commission_submit_keys (commission_id);

alter table public.commission_submit_keys enable row level security;
revoke all on public.commission_submit_keys from public, anon, authenticated;
grant all on public.commission_submit_keys to service_role;

create or replace function public.submit_commission_atomic(
  p_idempotency_key_hash text,
  p_request_hash text,
  p_order jsonb,
  p_track jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_key public.commission_submit_keys%rowtype;
  v_id text;
  v_track public.order_tracks%rowtype;
  v_lock_key bigint;
begin
  if coalesce(p_idempotency_key_hash, '') !~ '^[0-9a-f]{64}
     or jsonb_typeof(p_track) is distinct from 'object'
     or coalesce(p_order->>'id', '') !~ '^COMMISSION-[0-9]{4}-[0-9]{4,}
     or coalesce(p_order->>'serviceTitle', '') = ''
     or jsonb_typeof(p_order->'form') is distinct from 'object'
     or jsonb_typeof(p_order->'estimate') is distinct from 'object' then
    raise exception 'Invalid commission submission payload' using errcode = '22023';
  end if;

  v_lock_key := pg_catalog.hashtextextended(p_idempotency_key_hash, 0);
  perform pg_catalog.pg_advisory_xact_lock(v_lock_key);

  select * into v_key
    from public.commission_submit_keys
   where key_hash = p_idempotency_key_hash
   for update;

  if found then
    if v_key.request_hash <> p_request_hash then
      raise exception 'IDEMPOTENCY_KEY_CONFLICT' using errcode = 'P0001';
    end if;
    if v_key.deleted_at is not null then
      raise exception 'IDEMPOTENCY_KEY_RETIRED' using errcode = 'P0001';
    end if;
    select * into v_track
      from public.order_tracks
     where id = v_key.commission_id;
    if not found then
      raise exception 'IDEMPOTENCY_RESULT_MISSING' using errcode = 'P0001';
    end if;
    return jsonb_build_object('track', to_jsonb(v_track), 'duplicate', true);
  end if;

  v_id := p_order->>'id';

  insert into public.commission_requests (
    id, created_at, "createdAt", status, payment,
    "serviceId", "serviceTitle", "tierName",
    form, estimate, notes, "finalPrice", "extraLines"
  ) values (
    v_id,
    coalesce(nullif(p_order->>'created_at', '')::timestamptz, now()),
    coalesce(p_order->>'createdAt', now()::text),
    'Pending Review',
    'Unpaid',
    p_order->>'serviceId',
    p_order->>'serviceTitle',
    coalesce(p_order->>'tierName', ''),
    p_order->'form',
    p_order->'estimate',
    '',
    null,
    ''
  );

  insert into public.order_tracks (
    id, created_at, "createdAt", "serviceTitle", status, payment,
    estimate, custom, "emailHash", client_name, proposal, updates, "finalFiles"
  ) values (
    v_id,
    coalesce(nullif(p_track->>'created_at', '')::timestamptz, now()),
    coalesce(p_track->>'createdAt', now()::text),
    p_order->>'serviceTitle',
    'Pending Review',
    'Unpaid',
    (p_order->'estimate'->>'total')::numeric,
    coalesce((p_order->'estimate'->>'custom')::boolean, false),
    p_track->>'emailHash',
    coalesce(nullif(p_track->>'client_name', ''), 'Client'),
    null,
    '[]'::jsonb,
    '[]'::jsonb
  )
  returning * into v_track;

  insert into public.commission_submit_keys (key_hash, request_hash, commission_id)
  values (p_idempotency_key_hash, p_request_hash, v_id);

  return jsonb_build_object('track', to_jsonb(v_track), 'duplicate', false);
end;
$$;

create or replace function public.delete_commission_atomic(p_commission_id text)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_deleted integer;
begin
  if coalesce(p_commission_id, '') !~ '^COMMISSION-[0-9]{4}-[0-9]{4,}$' then
    raise exception 'Invalid commission ID' using errcode = '22023';
  end if;

  -- Explicitly remove every related row inside this transaction.
  delete from public.client_reviews where commission_id = p_commission_id;
  delete from public.order_tracks where id = p_commission_id;
  delete from public.commission_management where id = p_commission_id;
  delete from public.notifications where order_id = p_commission_id;
  delete from public.commission_requests where id = p_commission_id;
  get diagnostics v_deleted = row_count;

  -- Retain a tombstone so a replayed idempotency key cannot recreate a deleted order.
  update public.commission_submit_keys
     set deleted_at = coalesce(deleted_at, now())
   where commission_id = p_commission_id;

  return v_deleted > 0;
end;
$$;

revoke all on function public.submit_commission_atomic(text, text, jsonb, jsonb) from public, anon, authenticated;
revoke all on function public.delete_commission_atomic(text) from public, anon, authenticated;
grant execute on function public.submit_commission_atomic(text, text, jsonb, jsonb) to service_role;
grant execute on function public.delete_commission_atomic(text) to service_role;

commit;

     or coalesce(p_request_hash, '') !~ '^[0-9a-f]{64}
     or jsonb_typeof(p_order) is distinct from 'object'
     or jsonb_typeof(p_track) is distinct from 'object'
     or coalesce(p_order->>'serviceId', '') = ''
     or coalesce(p_order->>'serviceTitle', '') = ''
     or jsonb_typeof(p_order->'form') is distinct from 'object'
     or jsonb_typeof(p_order->'estimate') is distinct from 'object'
     or coalesce(p_track->>'emailHash', '') !~ '^[0-9a-f]{64}$' then
    raise exception 'Invalid commission submission payload' using errcode = '22023';
  end if;

  v_lock_key := pg_catalog.hashtextextended(p_idempotency_key_hash, 0);
  perform pg_catalog.pg_advisory_xact_lock(v_lock_key);

  select * into v_key
    from public.commission_submit_keys
   where key_hash = p_idempotency_key_hash
   for update;

  if found then
    if v_key.request_hash <> p_request_hash then
      raise exception 'IDEMPOTENCY_KEY_CONFLICT' using errcode = 'P0001';
    end if;
    if v_key.deleted_at is not null then
      raise exception 'IDEMPOTENCY_KEY_RETIRED' using errcode = 'P0001';
    end if;
    select * into v_track
      from public.order_tracks
     where id = v_key.commission_id;
    if not found then
      raise exception 'IDEMPOTENCY_RESULT_MISSING' using errcode = 'P0001';
    end if;
    return jsonb_build_object('track', to_jsonb(v_track), 'duplicate', true);
  end if;

  v_id := public.next_commission_id();

  insert into public.commission_requests (
    id, created_at, "createdAt", status, payment,
    "serviceId", "serviceTitle", "tierName",
    form, estimate, notes, "finalPrice", "extraLines"
  ) values (
    v_id,
    coalesce(nullif(p_order->>'created_at', '')::timestamptz, now()),
    coalesce(p_order->>'createdAt', now()::text),
    'Pending Review',
    'Unpaid',
    p_order->>'serviceId',
    p_order->>'serviceTitle',
    coalesce(p_order->>'tierName', ''),
    p_order->'form',
    p_order->'estimate',
    '',
    null,
    ''
  );

  insert into public.order_tracks (
    id, created_at, "createdAt", "serviceTitle", status, payment,
    estimate, custom, "emailHash", client_name, proposal, updates, "finalFiles"
  ) values (
    v_id,
    coalesce(nullif(p_track->>'created_at', '')::timestamptz, now()),
    coalesce(p_track->>'createdAt', now()::text),
    p_order->>'serviceTitle',
    'Pending Review',
    'Unpaid',
    (p_order->'estimate'->>'total')::numeric,
    coalesce((p_order->'estimate'->>'custom')::boolean, false),
    p_track->>'emailHash',
    coalesce(nullif(p_track->>'client_name', ''), 'Client'),
    null,
    '[]'::jsonb,
    '[]'::jsonb
  )
  returning * into v_track;

  insert into public.commission_submit_keys (key_hash, request_hash, commission_id)
  values (p_idempotency_key_hash, p_request_hash, v_id);

  return jsonb_build_object('track', to_jsonb(v_track), 'duplicate', false);
end;
$$;

create or replace function public.delete_commission_atomic(p_commission_id text)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_deleted integer;
begin
  if coalesce(p_commission_id, '') !~ '^COMMISSION-[0-9]{4}-[0-9]{4,}$' then
    raise exception 'Invalid commission ID' using errcode = '22023';
  end if;

  -- Explicitly remove every related row inside this transaction.
  delete from public.client_reviews where commission_id = p_commission_id;
  delete from public.order_tracks where id = p_commission_id;
  delete from public.commission_management where id = p_commission_id;
  delete from public.notifications where order_id = p_commission_id;
  delete from public.commission_requests where id = p_commission_id;
  get diagnostics v_deleted = row_count;

  -- Retain a tombstone so a replayed idempotency key cannot recreate a deleted order.
  update public.commission_submit_keys
     set deleted_at = coalesce(deleted_at, now())
   where commission_id = p_commission_id;

  return v_deleted > 0;
end;
$$;

revoke all on function public.submit_commission_atomic(text, text, jsonb, jsonb) from public, anon, authenticated;
revoke all on function public.delete_commission_atomic(text) from public, anon, authenticated;
grant execute on function public.submit_commission_atomic(text, text, jsonb, jsonb) to service_role;
grant execute on function public.delete_commission_atomic(text) to service_role;

commit;

     or jsonb_typeof(p_order) is distinct from 'object'
     or jsonb_typeof(p_track) is distinct from 'object'
     or coalesce(p_order->>'serviceId', '') = ''
     or coalesce(p_order->>'serviceTitle', '') = ''
     or jsonb_typeof(p_order->'form') is distinct from 'object'
     or jsonb_typeof(p_order->'estimate') is distinct from 'object'
     or coalesce(p_track->>'emailHash', '') !~ '^[0-9a-f]{64}$' then
    raise exception 'Invalid commission submission payload' using errcode = '22023';
  end if;

  v_lock_key := pg_catalog.hashtextextended(p_idempotency_key_hash, 0);
  perform pg_catalog.pg_advisory_xact_lock(v_lock_key);

  select * into v_key
    from public.commission_submit_keys
   where key_hash = p_idempotency_key_hash
   for update;

  if found then
    if v_key.request_hash <> p_request_hash then
      raise exception 'IDEMPOTENCY_KEY_CONFLICT' using errcode = 'P0001';
    end if;
    if v_key.deleted_at is not null then
      raise exception 'IDEMPOTENCY_KEY_RETIRED' using errcode = 'P0001';
    end if;
    select * into v_track
      from public.order_tracks
     where id = v_key.commission_id;
    if not found then
      raise exception 'IDEMPOTENCY_RESULT_MISSING' using errcode = 'P0001';
    end if;
    return jsonb_build_object('track', to_jsonb(v_track), 'duplicate', true);
  end if;

  v_id := public.next_commission_id();

  insert into public.commission_requests (
    id, created_at, "createdAt", status, payment,
    "serviceId", "serviceTitle", "tierName",
    form, estimate, notes, "finalPrice", "extraLines"
  ) values (
    v_id,
    coalesce(nullif(p_order->>'created_at', '')::timestamptz, now()),
    coalesce(p_order->>'createdAt', now()::text),
    'Pending Review',
    'Unpaid',
    p_order->>'serviceId',
    p_order->>'serviceTitle',
    coalesce(p_order->>'tierName', ''),
    p_order->'form',
    p_order->'estimate',
    '',
    null,
    ''
  );

  insert into public.order_tracks (
    id, created_at, "createdAt", "serviceTitle", status, payment,
    estimate, custom, "emailHash", client_name, proposal, updates, "finalFiles"
  ) values (
    v_id,
    coalesce(nullif(p_track->>'created_at', '')::timestamptz, now()),
    coalesce(p_track->>'createdAt', now()::text),
    p_order->>'serviceTitle',
    'Pending Review',
    'Unpaid',
    (p_order->'estimate'->>'total')::numeric,
    coalesce((p_order->'estimate'->>'custom')::boolean, false),
    p_track->>'emailHash',
    coalesce(nullif(p_track->>'client_name', ''), 'Client'),
    null,
    '[]'::jsonb,
    '[]'::jsonb
  )
  returning * into v_track;

  insert into public.commission_submit_keys (key_hash, request_hash, commission_id)
  values (p_idempotency_key_hash, p_request_hash, v_id);

  return jsonb_build_object('track', to_jsonb(v_track), 'duplicate', false);
end;
$$;

create or replace function public.delete_commission_atomic(p_commission_id text)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_deleted integer;
begin
  if coalesce(p_commission_id, '') !~ '^COMMISSION-[0-9]{4}-[0-9]{4,}$' then
    raise exception 'Invalid commission ID' using errcode = '22023';
  end if;

  -- Explicitly remove every related row inside this transaction.
  delete from public.client_reviews where commission_id = p_commission_id;
  delete from public.order_tracks where id = p_commission_id;
  delete from public.commission_management where id = p_commission_id;
  delete from public.notifications where order_id = p_commission_id;
  delete from public.commission_requests where id = p_commission_id;
  get diagnostics v_deleted = row_count;

  -- Retain a tombstone so a replayed idempotency key cannot recreate a deleted order.
  update public.commission_submit_keys
     set deleted_at = coalesce(deleted_at, now())
   where commission_id = p_commission_id;

  return v_deleted > 0;
end;
$$;

revoke all on function public.submit_commission_atomic(text, text, jsonb, jsonb) from public, anon, authenticated;
revoke all on function public.delete_commission_atomic(text) from public, anon, authenticated;
grant execute on function public.submit_commission_atomic(text, text, jsonb, jsonb) to service_role;
grant execute on function public.delete_commission_atomic(text) to service_role;

commit;

     or coalesce(p_request_hash, '') !~ '^[0-9a-f]{64}
     or jsonb_typeof(p_track) is distinct from 'object'
     or coalesce(p_order->>'serviceId', '') = ''
     or coalesce(p_order->>'serviceTitle', '') = ''
     or jsonb_typeof(p_order->'form') is distinct from 'object'
     or jsonb_typeof(p_order->'estimate') is distinct from 'object' then
    raise exception 'Invalid commission submission payload' using errcode = '22023';
  end if;

  v_lock_key := pg_catalog.hashtextextended(p_idempotency_key_hash, 0);
  perform pg_catalog.pg_advisory_xact_lock(v_lock_key);

  select * into v_key
    from public.commission_submit_keys
   where key_hash = p_idempotency_key_hash
   for update;

  if found then
    if v_key.request_hash <> p_request_hash then
      raise exception 'IDEMPOTENCY_KEY_CONFLICT' using errcode = 'P0001';
    end if;
    if v_key.deleted_at is not null then
      raise exception 'IDEMPOTENCY_KEY_RETIRED' using errcode = 'P0001';
    end if;
    select * into v_track
      from public.order_tracks
     where id = v_key.commission_id;
    if not found then
      raise exception 'IDEMPOTENCY_RESULT_MISSING' using errcode = 'P0001';
    end if;
    return jsonb_build_object('track', to_jsonb(v_track), 'duplicate', true);
  end if;

  v_id := public.next_commission_id();

  insert into public.commission_requests (
    id, created_at, "createdAt", status, payment,
    "serviceId", "serviceTitle", "tierName",
    form, estimate, notes, "finalPrice", "extraLines"
  ) values (
    v_id,
    coalesce(nullif(p_order->>'created_at', '')::timestamptz, now()),
    coalesce(p_order->>'createdAt', now()::text),
    'Pending Review',
    'Unpaid',
    p_order->>'serviceId',
    p_order->>'serviceTitle',
    coalesce(p_order->>'tierName', ''),
    p_order->'form',
    p_order->'estimate',
    '',
    null,
    ''
  );

  insert into public.order_tracks (
    id, created_at, "createdAt", "serviceTitle", status, payment,
    estimate, custom, "emailHash", client_name, proposal, updates, "finalFiles"
  ) values (
    v_id,
    coalesce(nullif(p_track->>'created_at', '')::timestamptz, now()),
    coalesce(p_track->>'createdAt', now()::text),
    p_order->>'serviceTitle',
    'Pending Review',
    'Unpaid',
    (p_order->'estimate'->>'total')::numeric,
    coalesce((p_order->'estimate'->>'custom')::boolean, false),
    pg_catalog.encode(public.digest(lower(trim(p_order->'form'->>'email')) || '|' || v_id, 'sha256'), 'hex'),
    coalesce(nullif(p_track->>'client_name', ''), 'Client'),
    null,
    '[]'::jsonb,
    '[]'::jsonb
  )
  returning * into v_track;

  insert into public.commission_submit_keys (key_hash, request_hash, commission_id)
  values (p_idempotency_key_hash, p_request_hash, v_id);

  return jsonb_build_object('track', to_jsonb(v_track), 'duplicate', false);
end;
$$;

create or replace function public.delete_commission_atomic(p_commission_id text)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_deleted integer;
begin
  if coalesce(p_commission_id, '') !~ '^COMMISSION-[0-9]{4}-[0-9]{4,}$' then
    raise exception 'Invalid commission ID' using errcode = '22023';
  end if;

  -- Explicitly remove every related row inside this transaction.
  delete from public.client_reviews where commission_id = p_commission_id;
  delete from public.order_tracks where id = p_commission_id;
  delete from public.commission_management where id = p_commission_id;
  delete from public.notifications where order_id = p_commission_id;
  delete from public.commission_requests where id = p_commission_id;
  get diagnostics v_deleted = row_count;

  -- Retain a tombstone so a replayed idempotency key cannot recreate a deleted order.
  update public.commission_submit_keys
     set deleted_at = coalesce(deleted_at, now())
   where commission_id = p_commission_id;

  return v_deleted > 0;
end;
$$;

revoke all on function public.submit_commission_atomic(text, text, jsonb, jsonb) from public, anon, authenticated;
revoke all on function public.delete_commission_atomic(text) from public, anon, authenticated;
grant execute on function public.submit_commission_atomic(text, text, jsonb, jsonb) to service_role;
grant execute on function public.delete_commission_atomic(text) to service_role;

commit;

     or coalesce(p_request_hash, '') !~ '^[0-9a-f]{64}
     or jsonb_typeof(p_order) is distinct from 'object'
     or jsonb_typeof(p_track) is distinct from 'object'
     or coalesce(p_order->>'serviceId', '') = ''
     or coalesce(p_order->>'serviceTitle', '') = ''
     or jsonb_typeof(p_order->'form') is distinct from 'object'
     or jsonb_typeof(p_order->'estimate') is distinct from 'object'
     or coalesce(p_track->>'emailHash', '') !~ '^[0-9a-f]{64}$' then
    raise exception 'Invalid commission submission payload' using errcode = '22023';
  end if;

  v_lock_key := pg_catalog.hashtextextended(p_idempotency_key_hash, 0);
  perform pg_catalog.pg_advisory_xact_lock(v_lock_key);

  select * into v_key
    from public.commission_submit_keys
   where key_hash = p_idempotency_key_hash
   for update;

  if found then
    if v_key.request_hash <> p_request_hash then
      raise exception 'IDEMPOTENCY_KEY_CONFLICT' using errcode = 'P0001';
    end if;
    if v_key.deleted_at is not null then
      raise exception 'IDEMPOTENCY_KEY_RETIRED' using errcode = 'P0001';
    end if;
    select * into v_track
      from public.order_tracks
     where id = v_key.commission_id;
    if not found then
      raise exception 'IDEMPOTENCY_RESULT_MISSING' using errcode = 'P0001';
    end if;
    return jsonb_build_object('track', to_jsonb(v_track), 'duplicate', true);
  end if;

  v_id := public.next_commission_id();

  insert into public.commission_requests (
    id, created_at, "createdAt", status, payment,
    "serviceId", "serviceTitle", "tierName",
    form, estimate, notes, "finalPrice", "extraLines"
  ) values (
    v_id,
    coalesce(nullif(p_order->>'created_at', '')::timestamptz, now()),
    coalesce(p_order->>'createdAt', now()::text),
    'Pending Review',
    'Unpaid',
    p_order->>'serviceId',
    p_order->>'serviceTitle',
    coalesce(p_order->>'tierName', ''),
    p_order->'form',
    p_order->'estimate',
    '',
    null,
    ''
  );

  insert into public.order_tracks (
    id, created_at, "createdAt", "serviceTitle", status, payment,
    estimate, custom, "emailHash", client_name, proposal, updates, "finalFiles"
  ) values (
    v_id,
    coalesce(nullif(p_track->>'created_at', '')::timestamptz, now()),
    coalesce(p_track->>'createdAt', now()::text),
    p_order->>'serviceTitle',
    'Pending Review',
    'Unpaid',
    (p_order->'estimate'->>'total')::numeric,
    coalesce((p_order->'estimate'->>'custom')::boolean, false),
    p_track->>'emailHash',
    coalesce(nullif(p_track->>'client_name', ''), 'Client'),
    null,
    '[]'::jsonb,
    '[]'::jsonb
  )
  returning * into v_track;

  insert into public.commission_submit_keys (key_hash, request_hash, commission_id)
  values (p_idempotency_key_hash, p_request_hash, v_id);

  return jsonb_build_object('track', to_jsonb(v_track), 'duplicate', false);
end;
$$;

create or replace function public.delete_commission_atomic(p_commission_id text)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_deleted integer;
begin
  if coalesce(p_commission_id, '') !~ '^COMMISSION-[0-9]{4}-[0-9]{4,}$' then
    raise exception 'Invalid commission ID' using errcode = '22023';
  end if;

  -- Explicitly remove every related row inside this transaction.
  delete from public.client_reviews where commission_id = p_commission_id;
  delete from public.order_tracks where id = p_commission_id;
  delete from public.commission_management where id = p_commission_id;
  delete from public.notifications where order_id = p_commission_id;
  delete from public.commission_requests where id = p_commission_id;
  get diagnostics v_deleted = row_count;

  -- Retain a tombstone so a replayed idempotency key cannot recreate a deleted order.
  update public.commission_submit_keys
     set deleted_at = coalesce(deleted_at, now())
   where commission_id = p_commission_id;

  return v_deleted > 0;
end;
$$;

revoke all on function public.submit_commission_atomic(text, text, jsonb, jsonb) from public, anon, authenticated;
revoke all on function public.delete_commission_atomic(text) from public, anon, authenticated;
grant execute on function public.submit_commission_atomic(text, text, jsonb, jsonb) to service_role;
grant execute on function public.delete_commission_atomic(text) to service_role;

commit;

     or jsonb_typeof(p_order) is distinct from 'object'
     or jsonb_typeof(p_track) is distinct from 'object'
     or coalesce(p_order->>'serviceId', '') = ''
     or coalesce(p_order->>'serviceTitle', '') = ''
     or jsonb_typeof(p_order->'form') is distinct from 'object'
     or jsonb_typeof(p_order->'estimate') is distinct from 'object'
     or coalesce(p_track->>'emailHash', '') !~ '^[0-9a-f]{64}$' then
    raise exception 'Invalid commission submission payload' using errcode = '22023';
  end if;

  v_lock_key := pg_catalog.hashtextextended(p_idempotency_key_hash, 0);
  perform pg_catalog.pg_advisory_xact_lock(v_lock_key);

  select * into v_key
    from public.commission_submit_keys
   where key_hash = p_idempotency_key_hash
   for update;

  if found then
    if v_key.request_hash <> p_request_hash then
      raise exception 'IDEMPOTENCY_KEY_CONFLICT' using errcode = 'P0001';
    end if;
    if v_key.deleted_at is not null then
      raise exception 'IDEMPOTENCY_KEY_RETIRED' using errcode = 'P0001';
    end if;
    select * into v_track
      from public.order_tracks
     where id = v_key.commission_id;
    if not found then
      raise exception 'IDEMPOTENCY_RESULT_MISSING' using errcode = 'P0001';
    end if;
    return jsonb_build_object('track', to_jsonb(v_track), 'duplicate', true);
  end if;

  v_id := public.next_commission_id();

  insert into public.commission_requests (
    id, created_at, "createdAt", status, payment,
    "serviceId", "serviceTitle", "tierName",
    form, estimate, notes, "finalPrice", "extraLines"
  ) values (
    v_id,
    coalesce(nullif(p_order->>'created_at', '')::timestamptz, now()),
    coalesce(p_order->>'createdAt', now()::text),
    'Pending Review',
    'Unpaid',
    p_order->>'serviceId',
    p_order->>'serviceTitle',
    coalesce(p_order->>'tierName', ''),
    p_order->'form',
    p_order->'estimate',
    '',
    null,
    ''
  );

  insert into public.order_tracks (
    id, created_at, "createdAt", "serviceTitle", status, payment,
    estimate, custom, "emailHash", client_name, proposal, updates, "finalFiles"
  ) values (
    v_id,
    coalesce(nullif(p_track->>'created_at', '')::timestamptz, now()),
    coalesce(p_track->>'createdAt', now()::text),
    p_order->>'serviceTitle',
    'Pending Review',
    'Unpaid',
    (p_order->'estimate'->>'total')::numeric,
    coalesce((p_order->'estimate'->>'custom')::boolean, false),
    p_track->>'emailHash',
    coalesce(nullif(p_track->>'client_name', ''), 'Client'),
    null,
    '[]'::jsonb,
    '[]'::jsonb
  )
  returning * into v_track;

  insert into public.commission_submit_keys (key_hash, request_hash, commission_id)
  values (p_idempotency_key_hash, p_request_hash, v_id);

  return jsonb_build_object('track', to_jsonb(v_track), 'duplicate', false);
end;
$$;

create or replace function public.delete_commission_atomic(p_commission_id text)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_deleted integer;
begin
  if coalesce(p_commission_id, '') !~ '^COMMISSION-[0-9]{4}-[0-9]{4,}$' then
    raise exception 'Invalid commission ID' using errcode = '22023';
  end if;

  -- Explicitly remove every related row inside this transaction.
  delete from public.client_reviews where commission_id = p_commission_id;
  delete from public.order_tracks where id = p_commission_id;
  delete from public.commission_management where id = p_commission_id;
  delete from public.notifications where order_id = p_commission_id;
  delete from public.commission_requests where id = p_commission_id;
  get diagnostics v_deleted = row_count;

  -- Retain a tombstone so a replayed idempotency key cannot recreate a deleted order.
  update public.commission_submit_keys
     set deleted_at = coalesce(deleted_at, now())
   where commission_id = p_commission_id;

  return v_deleted > 0;
end;
$$;

revoke all on function public.submit_commission_atomic(text, text, jsonb, jsonb) from public, anon, authenticated;
revoke all on function public.delete_commission_atomic(text) from public, anon, authenticated;
grant execute on function public.submit_commission_atomic(text, text, jsonb, jsonb) to service_role;
grant execute on function public.delete_commission_atomic(text) to service_role;

commit;

     or jsonb_typeof(p_order) is distinct from 'object'
     or jsonb_typeof(p_track) is distinct from 'object'
     or coalesce(p_order->>'serviceId', '') = ''
     or coalesce(p_order->>'serviceTitle', '') = ''
     or jsonb_typeof(p_order->'form') is distinct from 'object'
     or jsonb_typeof(p_order->'estimate') is distinct from 'object' then
    raise exception 'Invalid commission submission payload' using errcode = '22023';
  end if;

  v_lock_key := pg_catalog.hashtextextended(p_idempotency_key_hash, 0);
  perform pg_catalog.pg_advisory_xact_lock(v_lock_key);

  select * into v_key
    from public.commission_submit_keys
   where key_hash = p_idempotency_key_hash
   for update;

  if found then
    if v_key.request_hash <> p_request_hash then
      raise exception 'IDEMPOTENCY_KEY_CONFLICT' using errcode = 'P0001';
    end if;
    if v_key.deleted_at is not null then
      raise exception 'IDEMPOTENCY_KEY_RETIRED' using errcode = 'P0001';
    end if;
    select * into v_track
      from public.order_tracks
     where id = v_key.commission_id;
    if not found then
      raise exception 'IDEMPOTENCY_RESULT_MISSING' using errcode = 'P0001';
    end if;
    return jsonb_build_object('track', to_jsonb(v_track), 'duplicate', true);
  end if;

  v_id := public.next_commission_id();

  insert into public.commission_requests (
    id, created_at, "createdAt", status, payment,
    "serviceId", "serviceTitle", "tierName",
    form, estimate, notes, "finalPrice", "extraLines"
  ) values (
    v_id,
    coalesce(nullif(p_order->>'created_at', '')::timestamptz, now()),
    coalesce(p_order->>'createdAt', now()::text),
    'Pending Review',
    'Unpaid',
    p_order->>'serviceId',
    p_order->>'serviceTitle',
    coalesce(p_order->>'tierName', ''),
    p_order->'form',
    p_order->'estimate',
    '',
    null,
    ''
  );

  insert into public.order_tracks (
    id, created_at, "createdAt", "serviceTitle", status, payment,
    estimate, custom, "emailHash", client_name, proposal, updates, "finalFiles"
  ) values (
    v_id,
    coalesce(nullif(p_track->>'created_at', '')::timestamptz, now()),
    coalesce(p_track->>'createdAt', now()::text),
    p_order->>'serviceTitle',
    'Pending Review',
    'Unpaid',
    (p_order->'estimate'->>'total')::numeric,
    coalesce((p_order->'estimate'->>'custom')::boolean, false),
    pg_catalog.encode(public.digest(lower(trim(p_order->'form'->>'email')) || '|' || v_id, 'sha256'), 'hex'),
    coalesce(nullif(p_track->>'client_name', ''), 'Client'),
    null,
    '[]'::jsonb,
    '[]'::jsonb
  )
  returning * into v_track;

  insert into public.commission_submit_keys (key_hash, request_hash, commission_id)
  values (p_idempotency_key_hash, p_request_hash, v_id);

  return jsonb_build_object('track', to_jsonb(v_track), 'duplicate', false);
end;
$$;

create or replace function public.delete_commission_atomic(p_commission_id text)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_deleted integer;
begin
  if coalesce(p_commission_id, '') !~ '^COMMISSION-[0-9]{4}-[0-9]{4,}$' then
    raise exception 'Invalid commission ID' using errcode = '22023';
  end if;

  -- Explicitly remove every related row inside this transaction.
  delete from public.client_reviews where commission_id = p_commission_id;
  delete from public.order_tracks where id = p_commission_id;
  delete from public.commission_management where id = p_commission_id;
  delete from public.notifications where order_id = p_commission_id;
  delete from public.commission_requests where id = p_commission_id;
  get diagnostics v_deleted = row_count;

  -- Retain a tombstone so a replayed idempotency key cannot recreate a deleted order.
  update public.commission_submit_keys
     set deleted_at = coalesce(deleted_at, now())
   where commission_id = p_commission_id;

  return v_deleted > 0;
end;
$$;

revoke all on function public.submit_commission_atomic(text, text, jsonb, jsonb) from public, anon, authenticated;
revoke all on function public.delete_commission_atomic(text) from public, anon, authenticated;
grant execute on function public.submit_commission_atomic(text, text, jsonb, jsonb) to service_role;
grant execute on function public.delete_commission_atomic(text) to service_role;

commit;

     or coalesce(p_request_hash, '') !~ '^[0-9a-f]{64}
     or jsonb_typeof(p_order) is distinct from 'object'
     or jsonb_typeof(p_track) is distinct from 'object'
     or coalesce(p_order->>'serviceId', '') = ''
     or coalesce(p_order->>'serviceTitle', '') = ''
     or jsonb_typeof(p_order->'form') is distinct from 'object'
     or jsonb_typeof(p_order->'estimate') is distinct from 'object'
     or coalesce(p_track->>'emailHash', '') !~ '^[0-9a-f]{64}$' then
    raise exception 'Invalid commission submission payload' using errcode = '22023';
  end if;

  v_lock_key := pg_catalog.hashtextextended(p_idempotency_key_hash, 0);
  perform pg_catalog.pg_advisory_xact_lock(v_lock_key);

  select * into v_key
    from public.commission_submit_keys
   where key_hash = p_idempotency_key_hash
   for update;

  if found then
    if v_key.request_hash <> p_request_hash then
      raise exception 'IDEMPOTENCY_KEY_CONFLICT' using errcode = 'P0001';
    end if;
    if v_key.deleted_at is not null then
      raise exception 'IDEMPOTENCY_KEY_RETIRED' using errcode = 'P0001';
    end if;
    select * into v_track
      from public.order_tracks
     where id = v_key.commission_id;
    if not found then
      raise exception 'IDEMPOTENCY_RESULT_MISSING' using errcode = 'P0001';
    end if;
    return jsonb_build_object('track', to_jsonb(v_track), 'duplicate', true);
  end if;

  v_id := public.next_commission_id();

  insert into public.commission_requests (
    id, created_at, "createdAt", status, payment,
    "serviceId", "serviceTitle", "tierName",
    form, estimate, notes, "finalPrice", "extraLines"
  ) values (
    v_id,
    coalesce(nullif(p_order->>'created_at', '')::timestamptz, now()),
    coalesce(p_order->>'createdAt', now()::text),
    'Pending Review',
    'Unpaid',
    p_order->>'serviceId',
    p_order->>'serviceTitle',
    coalesce(p_order->>'tierName', ''),
    p_order->'form',
    p_order->'estimate',
    '',
    null,
    ''
  );

  insert into public.order_tracks (
    id, created_at, "createdAt", "serviceTitle", status, payment,
    estimate, custom, "emailHash", client_name, proposal, updates, "finalFiles"
  ) values (
    v_id,
    coalesce(nullif(p_track->>'created_at', '')::timestamptz, now()),
    coalesce(p_track->>'createdAt', now()::text),
    p_order->>'serviceTitle',
    'Pending Review',
    'Unpaid',
    (p_order->'estimate'->>'total')::numeric,
    coalesce((p_order->'estimate'->>'custom')::boolean, false),
    p_track->>'emailHash',
    coalesce(nullif(p_track->>'client_name', ''), 'Client'),
    null,
    '[]'::jsonb,
    '[]'::jsonb
  )
  returning * into v_track;

  insert into public.commission_submit_keys (key_hash, request_hash, commission_id)
  values (p_idempotency_key_hash, p_request_hash, v_id);

  return jsonb_build_object('track', to_jsonb(v_track), 'duplicate', false);
end;
$$;

create or replace function public.delete_commission_atomic(p_commission_id text)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_deleted integer;
begin
  if coalesce(p_commission_id, '') !~ '^COMMISSION-[0-9]{4}-[0-9]{4,}$' then
    raise exception 'Invalid commission ID' using errcode = '22023';
  end if;

  -- Explicitly remove every related row inside this transaction.
  delete from public.client_reviews where commission_id = p_commission_id;
  delete from public.order_tracks where id = p_commission_id;
  delete from public.commission_management where id = p_commission_id;
  delete from public.notifications where order_id = p_commission_id;
  delete from public.commission_requests where id = p_commission_id;
  get diagnostics v_deleted = row_count;

  -- Retain a tombstone so a replayed idempotency key cannot recreate a deleted order.
  update public.commission_submit_keys
     set deleted_at = coalesce(deleted_at, now())
   where commission_id = p_commission_id;

  return v_deleted > 0;
end;
$$;

revoke all on function public.submit_commission_atomic(text, text, jsonb, jsonb) from public, anon, authenticated;
revoke all on function public.delete_commission_atomic(text) from public, anon, authenticated;
grant execute on function public.submit_commission_atomic(text, text, jsonb, jsonb) to service_role;
grant execute on function public.delete_commission_atomic(text) to service_role;

commit;

     or jsonb_typeof(p_order) is distinct from 'object'
     or jsonb_typeof(p_track) is distinct from 'object'
     or coalesce(p_order->>'serviceId', '') = ''
     or coalesce(p_order->>'serviceTitle', '') = ''
     or jsonb_typeof(p_order->'form') is distinct from 'object'
     or jsonb_typeof(p_order->'estimate') is distinct from 'object'
     or coalesce(p_track->>'emailHash', '') !~ '^[0-9a-f]{64}$' then
    raise exception 'Invalid commission submission payload' using errcode = '22023';
  end if;

  v_lock_key := pg_catalog.hashtextextended(p_idempotency_key_hash, 0);
  perform pg_catalog.pg_advisory_xact_lock(v_lock_key);

  select * into v_key
    from public.commission_submit_keys
   where key_hash = p_idempotency_key_hash
   for update;

  if found then
    if v_key.request_hash <> p_request_hash then
      raise exception 'IDEMPOTENCY_KEY_CONFLICT' using errcode = 'P0001';
    end if;
    if v_key.deleted_at is not null then
      raise exception 'IDEMPOTENCY_KEY_RETIRED' using errcode = 'P0001';
    end if;
    select * into v_track
      from public.order_tracks
     where id = v_key.commission_id;
    if not found then
      raise exception 'IDEMPOTENCY_RESULT_MISSING' using errcode = 'P0001';
    end if;
    return jsonb_build_object('track', to_jsonb(v_track), 'duplicate', true);
  end if;

  v_id := public.next_commission_id();

  insert into public.commission_requests (
    id, created_at, "createdAt", status, payment,
    "serviceId", "serviceTitle", "tierName",
    form, estimate, notes, "finalPrice", "extraLines"
  ) values (
    v_id,
    coalesce(nullif(p_order->>'created_at', '')::timestamptz, now()),
    coalesce(p_order->>'createdAt', now()::text),
    'Pending Review',
    'Unpaid',
    p_order->>'serviceId',
    p_order->>'serviceTitle',
    coalesce(p_order->>'tierName', ''),
    p_order->'form',
    p_order->'estimate',
    '',
    null,
    ''
  );

  insert into public.order_tracks (
    id, created_at, "createdAt", "serviceTitle", status, payment,
    estimate, custom, "emailHash", client_name, proposal, updates, "finalFiles"
  ) values (
    v_id,
    coalesce(nullif(p_track->>'created_at', '')::timestamptz, now()),
    coalesce(p_track->>'createdAt', now()::text),
    p_order->>'serviceTitle',
    'Pending Review',
    'Unpaid',
    (p_order->'estimate'->>'total')::numeric,
    coalesce((p_order->'estimate'->>'custom')::boolean, false),
    p_track->>'emailHash',
    coalesce(nullif(p_track->>'client_name', ''), 'Client'),
    null,
    '[]'::jsonb,
    '[]'::jsonb
  )
  returning * into v_track;

  insert into public.commission_submit_keys (key_hash, request_hash, commission_id)
  values (p_idempotency_key_hash, p_request_hash, v_id);

  return jsonb_build_object('track', to_jsonb(v_track), 'duplicate', false);
end;
$$;

create or replace function public.delete_commission_atomic(p_commission_id text)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_deleted integer;
begin
  if coalesce(p_commission_id, '') !~ '^COMMISSION-[0-9]{4}-[0-9]{4,}$' then
    raise exception 'Invalid commission ID' using errcode = '22023';
  end if;

  -- Explicitly remove every related row inside this transaction.
  delete from public.client_reviews where commission_id = p_commission_id;
  delete from public.order_tracks where id = p_commission_id;
  delete from public.commission_management where id = p_commission_id;
  delete from public.notifications where order_id = p_commission_id;
  delete from public.commission_requests where id = p_commission_id;
  get diagnostics v_deleted = row_count;

  -- Retain a tombstone so a replayed idempotency key cannot recreate a deleted order.
  update public.commission_submit_keys
     set deleted_at = coalesce(deleted_at, now())
   where commission_id = p_commission_id;

  return v_deleted > 0;
end;
$$;

revoke all on function public.submit_commission_atomic(text, text, jsonb, jsonb) from public, anon, authenticated;
revoke all on function public.delete_commission_atomic(text) from public, anon, authenticated;
grant execute on function public.submit_commission_atomic(text, text, jsonb, jsonb) to service_role;
grant execute on function public.delete_commission_atomic(text) to service_role;

commit;

     or coalesce(p_track->>'emailHash', '') !~ '^[0-9a-f]{64}
     or coalesce(p_order->>'serviceTitle', '') = ''
     or jsonb_typeof(p_order->'form') is distinct from 'object'
     or jsonb_typeof(p_order->'estimate') is distinct from 'object' then
    raise exception 'Invalid commission submission payload' using errcode = '22023';
  end if;

  v_lock_key := pg_catalog.hashtextextended(p_idempotency_key_hash, 0);
  perform pg_catalog.pg_advisory_xact_lock(v_lock_key);

  select * into v_key
    from public.commission_submit_keys
   where key_hash = p_idempotency_key_hash
   for update;

  if found then
    if v_key.request_hash <> p_request_hash then
      raise exception 'IDEMPOTENCY_KEY_CONFLICT' using errcode = 'P0001';
    end if;
    if v_key.deleted_at is not null then
      raise exception 'IDEMPOTENCY_KEY_RETIRED' using errcode = 'P0001';
    end if;
    select * into v_track
      from public.order_tracks
     where id = v_key.commission_id;
    if not found then
      raise exception 'IDEMPOTENCY_RESULT_MISSING' using errcode = 'P0001';
    end if;
    return jsonb_build_object('track', to_jsonb(v_track), 'duplicate', true);
  end if;

  v_id := public.next_commission_id();

  insert into public.commission_requests (
    id, created_at, "createdAt", status, payment,
    "serviceId", "serviceTitle", "tierName",
    form, estimate, notes, "finalPrice", "extraLines"
  ) values (
    v_id,
    coalesce(nullif(p_order->>'created_at', '')::timestamptz, now()),
    coalesce(p_order->>'createdAt', now()::text),
    'Pending Review',
    'Unpaid',
    p_order->>'serviceId',
    p_order->>'serviceTitle',
    coalesce(p_order->>'tierName', ''),
    p_order->'form',
    p_order->'estimate',
    '',
    null,
    ''
  );

  insert into public.order_tracks (
    id, created_at, "createdAt", "serviceTitle", status, payment,
    estimate, custom, "emailHash", client_name, proposal, updates, "finalFiles"
  ) values (
    v_id,
    coalesce(nullif(p_track->>'created_at', '')::timestamptz, now()),
    coalesce(p_track->>'createdAt', now()::text),
    p_order->>'serviceTitle',
    'Pending Review',
    'Unpaid',
    (p_order->'estimate'->>'total')::numeric,
    coalesce((p_order->'estimate'->>'custom')::boolean, false),
    pg_catalog.encode(public.digest(lower(trim(p_order->'form'->>'email')) || '|' || v_id, 'sha256'), 'hex'),
    coalesce(nullif(p_track->>'client_name', ''), 'Client'),
    null,
    '[]'::jsonb,
    '[]'::jsonb
  )
  returning * into v_track;

  insert into public.commission_submit_keys (key_hash, request_hash, commission_id)
  values (p_idempotency_key_hash, p_request_hash, v_id);

  return jsonb_build_object('track', to_jsonb(v_track), 'duplicate', false);
end;
$$;

create or replace function public.delete_commission_atomic(p_commission_id text)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_deleted integer;
begin
  if coalesce(p_commission_id, '') !~ '^COMMISSION-[0-9]{4}-[0-9]{4,}$' then
    raise exception 'Invalid commission ID' using errcode = '22023';
  end if;

  -- Explicitly remove every related row inside this transaction.
  delete from public.client_reviews where commission_id = p_commission_id;
  delete from public.order_tracks where id = p_commission_id;
  delete from public.commission_management where id = p_commission_id;
  delete from public.notifications where order_id = p_commission_id;
  delete from public.commission_requests where id = p_commission_id;
  get diagnostics v_deleted = row_count;

  -- Retain a tombstone so a replayed idempotency key cannot recreate a deleted order.
  update public.commission_submit_keys
     set deleted_at = coalesce(deleted_at, now())
   where commission_id = p_commission_id;

  return v_deleted > 0;
end;
$$;

revoke all on function public.submit_commission_atomic(text, text, jsonb, jsonb) from public, anon, authenticated;
revoke all on function public.delete_commission_atomic(text) from public, anon, authenticated;
grant execute on function public.submit_commission_atomic(text, text, jsonb, jsonb) to service_role;
grant execute on function public.delete_commission_atomic(text) to service_role;

commit;

     or coalesce(p_request_hash, '') !~ '^[0-9a-f]{64}
     or jsonb_typeof(p_order) is distinct from 'object'
     or jsonb_typeof(p_track) is distinct from 'object'
     or coalesce(p_order->>'serviceId', '') = ''
     or coalesce(p_order->>'serviceTitle', '') = ''
     or jsonb_typeof(p_order->'form') is distinct from 'object'
     or jsonb_typeof(p_order->'estimate') is distinct from 'object'
     or coalesce(p_track->>'emailHash', '') !~ '^[0-9a-f]{64}$' then
    raise exception 'Invalid commission submission payload' using errcode = '22023';
  end if;

  v_lock_key := pg_catalog.hashtextextended(p_idempotency_key_hash, 0);
  perform pg_catalog.pg_advisory_xact_lock(v_lock_key);

  select * into v_key
    from public.commission_submit_keys
   where key_hash = p_idempotency_key_hash
   for update;

  if found then
    if v_key.request_hash <> p_request_hash then
      raise exception 'IDEMPOTENCY_KEY_CONFLICT' using errcode = 'P0001';
    end if;
    if v_key.deleted_at is not null then
      raise exception 'IDEMPOTENCY_KEY_RETIRED' using errcode = 'P0001';
    end if;
    select * into v_track
      from public.order_tracks
     where id = v_key.commission_id;
    if not found then
      raise exception 'IDEMPOTENCY_RESULT_MISSING' using errcode = 'P0001';
    end if;
    return jsonb_build_object('track', to_jsonb(v_track), 'duplicate', true);
  end if;

  v_id := public.next_commission_id();

  insert into public.commission_requests (
    id, created_at, "createdAt", status, payment,
    "serviceId", "serviceTitle", "tierName",
    form, estimate, notes, "finalPrice", "extraLines"
  ) values (
    v_id,
    coalesce(nullif(p_order->>'created_at', '')::timestamptz, now()),
    coalesce(p_order->>'createdAt', now()::text),
    'Pending Review',
    'Unpaid',
    p_order->>'serviceId',
    p_order->>'serviceTitle',
    coalesce(p_order->>'tierName', ''),
    p_order->'form',
    p_order->'estimate',
    '',
    null,
    ''
  );

  insert into public.order_tracks (
    id, created_at, "createdAt", "serviceTitle", status, payment,
    estimate, custom, "emailHash", client_name, proposal, updates, "finalFiles"
  ) values (
    v_id,
    coalesce(nullif(p_track->>'created_at', '')::timestamptz, now()),
    coalesce(p_track->>'createdAt', now()::text),
    p_order->>'serviceTitle',
    'Pending Review',
    'Unpaid',
    (p_order->'estimate'->>'total')::numeric,
    coalesce((p_order->'estimate'->>'custom')::boolean, false),
    p_track->>'emailHash',
    coalesce(nullif(p_track->>'client_name', ''), 'Client'),
    null,
    '[]'::jsonb,
    '[]'::jsonb
  )
  returning * into v_track;

  insert into public.commission_submit_keys (key_hash, request_hash, commission_id)
  values (p_idempotency_key_hash, p_request_hash, v_id);

  return jsonb_build_object('track', to_jsonb(v_track), 'duplicate', false);
end;
$$;

create or replace function public.delete_commission_atomic(p_commission_id text)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_deleted integer;
begin
  if coalesce(p_commission_id, '') !~ '^COMMISSION-[0-9]{4}-[0-9]{4,}$' then
    raise exception 'Invalid commission ID' using errcode = '22023';
  end if;

  -- Explicitly remove every related row inside this transaction.
  delete from public.client_reviews where commission_id = p_commission_id;
  delete from public.order_tracks where id = p_commission_id;
  delete from public.commission_management where id = p_commission_id;
  delete from public.notifications where order_id = p_commission_id;
  delete from public.commission_requests where id = p_commission_id;
  get diagnostics v_deleted = row_count;

  -- Retain a tombstone so a replayed idempotency key cannot recreate a deleted order.
  update public.commission_submit_keys
     set deleted_at = coalesce(deleted_at, now())
   where commission_id = p_commission_id;

  return v_deleted > 0;
end;
$$;

revoke all on function public.submit_commission_atomic(text, text, jsonb, jsonb) from public, anon, authenticated;
revoke all on function public.delete_commission_atomic(text) from public, anon, authenticated;
grant execute on function public.submit_commission_atomic(text, text, jsonb, jsonb) to service_role;
grant execute on function public.delete_commission_atomic(text) to service_role;

commit;

     or jsonb_typeof(p_order) is distinct from 'object'
     or jsonb_typeof(p_track) is distinct from 'object'
     or coalesce(p_order->>'serviceId', '') = ''
     or coalesce(p_order->>'serviceTitle', '') = ''
     or jsonb_typeof(p_order->'form') is distinct from 'object'
     or jsonb_typeof(p_order->'estimate') is distinct from 'object'
     or coalesce(p_track->>'emailHash', '') !~ '^[0-9a-f]{64}$' then
    raise exception 'Invalid commission submission payload' using errcode = '22023';
  end if;

  v_lock_key := pg_catalog.hashtextextended(p_idempotency_key_hash, 0);
  perform pg_catalog.pg_advisory_xact_lock(v_lock_key);

  select * into v_key
    from public.commission_submit_keys
   where key_hash = p_idempotency_key_hash
   for update;

  if found then
    if v_key.request_hash <> p_request_hash then
      raise exception 'IDEMPOTENCY_KEY_CONFLICT' using errcode = 'P0001';
    end if;
    if v_key.deleted_at is not null then
      raise exception 'IDEMPOTENCY_KEY_RETIRED' using errcode = 'P0001';
    end if;
    select * into v_track
      from public.order_tracks
     where id = v_key.commission_id;
    if not found then
      raise exception 'IDEMPOTENCY_RESULT_MISSING' using errcode = 'P0001';
    end if;
    return jsonb_build_object('track', to_jsonb(v_track), 'duplicate', true);
  end if;

  v_id := public.next_commission_id();

  insert into public.commission_requests (
    id, created_at, "createdAt", status, payment,
    "serviceId", "serviceTitle", "tierName",
    form, estimate, notes, "finalPrice", "extraLines"
  ) values (
    v_id,
    coalesce(nullif(p_order->>'created_at', '')::timestamptz, now()),
    coalesce(p_order->>'createdAt', now()::text),
    'Pending Review',
    'Unpaid',
    p_order->>'serviceId',
    p_order->>'serviceTitle',
    coalesce(p_order->>'tierName', ''),
    p_order->'form',
    p_order->'estimate',
    '',
    null,
    ''
  );

  insert into public.order_tracks (
    id, created_at, "createdAt", "serviceTitle", status, payment,
    estimate, custom, "emailHash", client_name, proposal, updates, "finalFiles"
  ) values (
    v_id,
    coalesce(nullif(p_track->>'created_at', '')::timestamptz, now()),
    coalesce(p_track->>'createdAt', now()::text),
    p_order->>'serviceTitle',
    'Pending Review',
    'Unpaid',
    (p_order->'estimate'->>'total')::numeric,
    coalesce((p_order->'estimate'->>'custom')::boolean, false),
    p_track->>'emailHash',
    coalesce(nullif(p_track->>'client_name', ''), 'Client'),
    null,
    '[]'::jsonb,
    '[]'::jsonb
  )
  returning * into v_track;

  insert into public.commission_submit_keys (key_hash, request_hash, commission_id)
  values (p_idempotency_key_hash, p_request_hash, v_id);

  return jsonb_build_object('track', to_jsonb(v_track), 'duplicate', false);
end;
$$;

create or replace function public.delete_commission_atomic(p_commission_id text)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_deleted integer;
begin
  if coalesce(p_commission_id, '') !~ '^COMMISSION-[0-9]{4}-[0-9]{4,}$' then
    raise exception 'Invalid commission ID' using errcode = '22023';
  end if;

  -- Explicitly remove every related row inside this transaction.
  delete from public.client_reviews where commission_id = p_commission_id;
  delete from public.order_tracks where id = p_commission_id;
  delete from public.commission_management where id = p_commission_id;
  delete from public.notifications where order_id = p_commission_id;
  delete from public.commission_requests where id = p_commission_id;
  get diagnostics v_deleted = row_count;

  -- Retain a tombstone so a replayed idempotency key cannot recreate a deleted order.
  update public.commission_submit_keys
     set deleted_at = coalesce(deleted_at, now())
   where commission_id = p_commission_id;

  return v_deleted > 0;
end;
$$;

revoke all on function public.submit_commission_atomic(text, text, jsonb, jsonb) from public, anon, authenticated;
revoke all on function public.delete_commission_atomic(text) from public, anon, authenticated;
grant execute on function public.submit_commission_atomic(text, text, jsonb, jsonb) to service_role;
grant execute on function public.delete_commission_atomic(text) to service_role;

commit;

     or coalesce(p_request_hash, '') !~ '^[0-9a-f]{64}
     or jsonb_typeof(p_track) is distinct from 'object'
     or coalesce(p_order->>'serviceId', '') = ''
     or coalesce(p_order->>'serviceTitle', '') = ''
     or jsonb_typeof(p_order->'form') is distinct from 'object'
     or jsonb_typeof(p_order->'estimate') is distinct from 'object' then
    raise exception 'Invalid commission submission payload' using errcode = '22023';
  end if;

  v_lock_key := pg_catalog.hashtextextended(p_idempotency_key_hash, 0);
  perform pg_catalog.pg_advisory_xact_lock(v_lock_key);

  select * into v_key
    from public.commission_submit_keys
   where key_hash = p_idempotency_key_hash
   for update;

  if found then
    if v_key.request_hash <> p_request_hash then
      raise exception 'IDEMPOTENCY_KEY_CONFLICT' using errcode = 'P0001';
    end if;
    if v_key.deleted_at is not null then
      raise exception 'IDEMPOTENCY_KEY_RETIRED' using errcode = 'P0001';
    end if;
    select * into v_track
      from public.order_tracks
     where id = v_key.commission_id;
    if not found then
      raise exception 'IDEMPOTENCY_RESULT_MISSING' using errcode = 'P0001';
    end if;
    return jsonb_build_object('track', to_jsonb(v_track), 'duplicate', true);
  end if;

  v_id := public.next_commission_id();

  insert into public.commission_requests (
    id, created_at, "createdAt", status, payment,
    "serviceId", "serviceTitle", "tierName",
    form, estimate, notes, "finalPrice", "extraLines"
  ) values (
    v_id,
    coalesce(nullif(p_order->>'created_at', '')::timestamptz, now()),
    coalesce(p_order->>'createdAt', now()::text),
    'Pending Review',
    'Unpaid',
    p_order->>'serviceId',
    p_order->>'serviceTitle',
    coalesce(p_order->>'tierName', ''),
    p_order->'form',
    p_order->'estimate',
    '',
    null,
    ''
  );

  insert into public.order_tracks (
    id, created_at, "createdAt", "serviceTitle", status, payment,
    estimate, custom, "emailHash", client_name, proposal, updates, "finalFiles"
  ) values (
    v_id,
    coalesce(nullif(p_track->>'created_at', '')::timestamptz, now()),
    coalesce(p_track->>'createdAt', now()::text),
    p_order->>'serviceTitle',
    'Pending Review',
    'Unpaid',
    (p_order->'estimate'->>'total')::numeric,
    coalesce((p_order->'estimate'->>'custom')::boolean, false),
    pg_catalog.encode(public.digest(lower(trim(p_order->'form'->>'email')) || '|' || v_id, 'sha256'), 'hex'),
    coalesce(nullif(p_track->>'client_name', ''), 'Client'),
    null,
    '[]'::jsonb,
    '[]'::jsonb
  )
  returning * into v_track;

  insert into public.commission_submit_keys (key_hash, request_hash, commission_id)
  values (p_idempotency_key_hash, p_request_hash, v_id);

  return jsonb_build_object('track', to_jsonb(v_track), 'duplicate', false);
end;
$$;

create or replace function public.delete_commission_atomic(p_commission_id text)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_deleted integer;
begin
  if coalesce(p_commission_id, '') !~ '^COMMISSION-[0-9]{4}-[0-9]{4,}$' then
    raise exception 'Invalid commission ID' using errcode = '22023';
  end if;

  -- Explicitly remove every related row inside this transaction.
  delete from public.client_reviews where commission_id = p_commission_id;
  delete from public.order_tracks where id = p_commission_id;
  delete from public.commission_management where id = p_commission_id;
  delete from public.notifications where order_id = p_commission_id;
  delete from public.commission_requests where id = p_commission_id;
  get diagnostics v_deleted = row_count;

  -- Retain a tombstone so a replayed idempotency key cannot recreate a deleted order.
  update public.commission_submit_keys
     set deleted_at = coalesce(deleted_at, now())
   where commission_id = p_commission_id;

  return v_deleted > 0;
end;
$$;

revoke all on function public.submit_commission_atomic(text, text, jsonb, jsonb) from public, anon, authenticated;
revoke all on function public.delete_commission_atomic(text) from public, anon, authenticated;
grant execute on function public.submit_commission_atomic(text, text, jsonb, jsonb) to service_role;
grant execute on function public.delete_commission_atomic(text) to service_role;

commit;

     or coalesce(p_request_hash, '') !~ '^[0-9a-f]{64}
     or jsonb_typeof(p_order) is distinct from 'object'
     or jsonb_typeof(p_track) is distinct from 'object'
     or coalesce(p_order->>'serviceId', '') = ''
     or coalesce(p_order->>'serviceTitle', '') = ''
     or jsonb_typeof(p_order->'form') is distinct from 'object'
     or jsonb_typeof(p_order->'estimate') is distinct from 'object'
     or coalesce(p_track->>'emailHash', '') !~ '^[0-9a-f]{64}$' then
    raise exception 'Invalid commission submission payload' using errcode = '22023';
  end if;

  v_lock_key := pg_catalog.hashtextextended(p_idempotency_key_hash, 0);
  perform pg_catalog.pg_advisory_xact_lock(v_lock_key);

  select * into v_key
    from public.commission_submit_keys
   where key_hash = p_idempotency_key_hash
   for update;

  if found then
    if v_key.request_hash <> p_request_hash then
      raise exception 'IDEMPOTENCY_KEY_CONFLICT' using errcode = 'P0001';
    end if;
    if v_key.deleted_at is not null then
      raise exception 'IDEMPOTENCY_KEY_RETIRED' using errcode = 'P0001';
    end if;
    select * into v_track
      from public.order_tracks
     where id = v_key.commission_id;
    if not found then
      raise exception 'IDEMPOTENCY_RESULT_MISSING' using errcode = 'P0001';
    end if;
    return jsonb_build_object('track', to_jsonb(v_track), 'duplicate', true);
  end if;

  v_id := public.next_commission_id();

  insert into public.commission_requests (
    id, created_at, "createdAt", status, payment,
    "serviceId", "serviceTitle", "tierName",
    form, estimate, notes, "finalPrice", "extraLines"
  ) values (
    v_id,
    coalesce(nullif(p_order->>'created_at', '')::timestamptz, now()),
    coalesce(p_order->>'createdAt', now()::text),
    'Pending Review',
    'Unpaid',
    p_order->>'serviceId',
    p_order->>'serviceTitle',
    coalesce(p_order->>'tierName', ''),
    p_order->'form',
    p_order->'estimate',
    '',
    null,
    ''
  );

  insert into public.order_tracks (
    id, created_at, "createdAt", "serviceTitle", status, payment,
    estimate, custom, "emailHash", client_name, proposal, updates, "finalFiles"
  ) values (
    v_id,
    coalesce(nullif(p_track->>'created_at', '')::timestamptz, now()),
    coalesce(p_track->>'createdAt', now()::text),
    p_order->>'serviceTitle',
    'Pending Review',
    'Unpaid',
    (p_order->'estimate'->>'total')::numeric,
    coalesce((p_order->'estimate'->>'custom')::boolean, false),
    p_track->>'emailHash',
    coalesce(nullif(p_track->>'client_name', ''), 'Client'),
    null,
    '[]'::jsonb,
    '[]'::jsonb
  )
  returning * into v_track;

  insert into public.commission_submit_keys (key_hash, request_hash, commission_id)
  values (p_idempotency_key_hash, p_request_hash, v_id);

  return jsonb_build_object('track', to_jsonb(v_track), 'duplicate', false);
end;
$$;

create or replace function public.delete_commission_atomic(p_commission_id text)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_deleted integer;
begin
  if coalesce(p_commission_id, '') !~ '^COMMISSION-[0-9]{4}-[0-9]{4,}$' then
    raise exception 'Invalid commission ID' using errcode = '22023';
  end if;

  -- Explicitly remove every related row inside this transaction.
  delete from public.client_reviews where commission_id = p_commission_id;
  delete from public.order_tracks where id = p_commission_id;
  delete from public.commission_management where id = p_commission_id;
  delete from public.notifications where order_id = p_commission_id;
  delete from public.commission_requests where id = p_commission_id;
  get diagnostics v_deleted = row_count;

  -- Retain a tombstone so a replayed idempotency key cannot recreate a deleted order.
  update public.commission_submit_keys
     set deleted_at = coalesce(deleted_at, now())
   where commission_id = p_commission_id;

  return v_deleted > 0;
end;
$$;

revoke all on function public.submit_commission_atomic(text, text, jsonb, jsonb) from public, anon, authenticated;
revoke all on function public.delete_commission_atomic(text) from public, anon, authenticated;
grant execute on function public.submit_commission_atomic(text, text, jsonb, jsonb) to service_role;
grant execute on function public.delete_commission_atomic(text) to service_role;

commit;

     or jsonb_typeof(p_order) is distinct from 'object'
     or jsonb_typeof(p_track) is distinct from 'object'
     or coalesce(p_order->>'serviceId', '') = ''
     or coalesce(p_order->>'serviceTitle', '') = ''
     or jsonb_typeof(p_order->'form') is distinct from 'object'
     or jsonb_typeof(p_order->'estimate') is distinct from 'object'
     or coalesce(p_track->>'emailHash', '') !~ '^[0-9a-f]{64}$' then
    raise exception 'Invalid commission submission payload' using errcode = '22023';
  end if;

  v_lock_key := pg_catalog.hashtextextended(p_idempotency_key_hash, 0);
  perform pg_catalog.pg_advisory_xact_lock(v_lock_key);

  select * into v_key
    from public.commission_submit_keys
   where key_hash = p_idempotency_key_hash
   for update;

  if found then
    if v_key.request_hash <> p_request_hash then
      raise exception 'IDEMPOTENCY_KEY_CONFLICT' using errcode = 'P0001';
    end if;
    if v_key.deleted_at is not null then
      raise exception 'IDEMPOTENCY_KEY_RETIRED' using errcode = 'P0001';
    end if;
    select * into v_track
      from public.order_tracks
     where id = v_key.commission_id;
    if not found then
      raise exception 'IDEMPOTENCY_RESULT_MISSING' using errcode = 'P0001';
    end if;
    return jsonb_build_object('track', to_jsonb(v_track), 'duplicate', true);
  end if;

  v_id := public.next_commission_id();

  insert into public.commission_requests (
    id, created_at, "createdAt", status, payment,
    "serviceId", "serviceTitle", "tierName",
    form, estimate, notes, "finalPrice", "extraLines"
  ) values (
    v_id,
    coalesce(nullif(p_order->>'created_at', '')::timestamptz, now()),
    coalesce(p_order->>'createdAt', now()::text),
    'Pending Review',
    'Unpaid',
    p_order->>'serviceId',
    p_order->>'serviceTitle',
    coalesce(p_order->>'tierName', ''),
    p_order->'form',
    p_order->'estimate',
    '',
    null,
    ''
  );

  insert into public.order_tracks (
    id, created_at, "createdAt", "serviceTitle", status, payment,
    estimate, custom, "emailHash", client_name, proposal, updates, "finalFiles"
  ) values (
    v_id,
    coalesce(nullif(p_track->>'created_at', '')::timestamptz, now()),
    coalesce(p_track->>'createdAt', now()::text),
    p_order->>'serviceTitle',
    'Pending Review',
    'Unpaid',
    (p_order->'estimate'->>'total')::numeric,
    coalesce((p_order->'estimate'->>'custom')::boolean, false),
    p_track->>'emailHash',
    coalesce(nullif(p_track->>'client_name', ''), 'Client'),
    null,
    '[]'::jsonb,
    '[]'::jsonb
  )
  returning * into v_track;

  insert into public.commission_submit_keys (key_hash, request_hash, commission_id)
  values (p_idempotency_key_hash, p_request_hash, v_id);

  return jsonb_build_object('track', to_jsonb(v_track), 'duplicate', false);
end;
$$;

create or replace function public.delete_commission_atomic(p_commission_id text)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_deleted integer;
begin
  if coalesce(p_commission_id, '') !~ '^COMMISSION-[0-9]{4}-[0-9]{4,}$' then
    raise exception 'Invalid commission ID' using errcode = '22023';
  end if;

  -- Explicitly remove every related row inside this transaction.
  delete from public.client_reviews where commission_id = p_commission_id;
  delete from public.order_tracks where id = p_commission_id;
  delete from public.commission_management where id = p_commission_id;
  delete from public.notifications where order_id = p_commission_id;
  delete from public.commission_requests where id = p_commission_id;
  get diagnostics v_deleted = row_count;

  -- Retain a tombstone so a replayed idempotency key cannot recreate a deleted order.
  update public.commission_submit_keys
     set deleted_at = coalesce(deleted_at, now())
   where commission_id = p_commission_id;

  return v_deleted > 0;
end;
$$;

revoke all on function public.submit_commission_atomic(text, text, jsonb, jsonb) from public, anon, authenticated;
revoke all on function public.delete_commission_atomic(text) from public, anon, authenticated;
grant execute on function public.submit_commission_atomic(text, text, jsonb, jsonb) to service_role;
grant execute on function public.delete_commission_atomic(text) to service_role;

commit;

     or jsonb_typeof(p_order) is distinct from 'object'
     or jsonb_typeof(p_track) is distinct from 'object'
     or coalesce(p_order->>'serviceId', '') = ''
     or coalesce(p_order->>'serviceTitle', '') = ''
     or jsonb_typeof(p_order->'form') is distinct from 'object'
     or jsonb_typeof(p_order->'estimate') is distinct from 'object' then
    raise exception 'Invalid commission submission payload' using errcode = '22023';
  end if;

  v_lock_key := pg_catalog.hashtextextended(p_idempotency_key_hash, 0);
  perform pg_catalog.pg_advisory_xact_lock(v_lock_key);

  select * into v_key
    from public.commission_submit_keys
   where key_hash = p_idempotency_key_hash
   for update;

  if found then
    if v_key.request_hash <> p_request_hash then
      raise exception 'IDEMPOTENCY_KEY_CONFLICT' using errcode = 'P0001';
    end if;
    if v_key.deleted_at is not null then
      raise exception 'IDEMPOTENCY_KEY_RETIRED' using errcode = 'P0001';
    end if;
    select * into v_track
      from public.order_tracks
     where id = v_key.commission_id;
    if not found then
      raise exception 'IDEMPOTENCY_RESULT_MISSING' using errcode = 'P0001';
    end if;
    return jsonb_build_object('track', to_jsonb(v_track), 'duplicate', true);
  end if;

  v_id := public.next_commission_id();

  insert into public.commission_requests (
    id, created_at, "createdAt", status, payment,
    "serviceId", "serviceTitle", "tierName",
    form, estimate, notes, "finalPrice", "extraLines"
  ) values (
    v_id,
    coalesce(nullif(p_order->>'created_at', '')::timestamptz, now()),
    coalesce(p_order->>'createdAt', now()::text),
    'Pending Review',
    'Unpaid',
    p_order->>'serviceId',
    p_order->>'serviceTitle',
    coalesce(p_order->>'tierName', ''),
    p_order->'form',
    p_order->'estimate',
    '',
    null,
    ''
  );

  insert into public.order_tracks (
    id, created_at, "createdAt", "serviceTitle", status, payment,
    estimate, custom, "emailHash", client_name, proposal, updates, "finalFiles"
  ) values (
    v_id,
    coalesce(nullif(p_track->>'created_at', '')::timestamptz, now()),
    coalesce(p_track->>'createdAt', now()::text),
    p_order->>'serviceTitle',
    'Pending Review',
    'Unpaid',
    (p_order->'estimate'->>'total')::numeric,
    coalesce((p_order->'estimate'->>'custom')::boolean, false),
    pg_catalog.encode(public.digest(lower(trim(p_order->'form'->>'email')) || '|' || v_id, 'sha256'), 'hex'),
    coalesce(nullif(p_track->>'client_name', ''), 'Client'),
    null,
    '[]'::jsonb,
    '[]'::jsonb
  )
  returning * into v_track;

  insert into public.commission_submit_keys (key_hash, request_hash, commission_id)
  values (p_idempotency_key_hash, p_request_hash, v_id);

  return jsonb_build_object('track', to_jsonb(v_track), 'duplicate', false);
end;
$$;

create or replace function public.delete_commission_atomic(p_commission_id text)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_deleted integer;
begin
  if coalesce(p_commission_id, '') !~ '^COMMISSION-[0-9]{4}-[0-9]{4,}$' then
    raise exception 'Invalid commission ID' using errcode = '22023';
  end if;

  -- Explicitly remove every related row inside this transaction.
  delete from public.client_reviews where commission_id = p_commission_id;
  delete from public.order_tracks where id = p_commission_id;
  delete from public.commission_management where id = p_commission_id;
  delete from public.notifications where order_id = p_commission_id;
  delete from public.commission_requests where id = p_commission_id;
  get diagnostics v_deleted = row_count;

  -- Retain a tombstone so a replayed idempotency key cannot recreate a deleted order.
  update public.commission_submit_keys
     set deleted_at = coalesce(deleted_at, now())
   where commission_id = p_commission_id;

  return v_deleted > 0;
end;
$$;

revoke all on function public.submit_commission_atomic(text, text, jsonb, jsonb) from public, anon, authenticated;
revoke all on function public.delete_commission_atomic(text) from public, anon, authenticated;
grant execute on function public.submit_commission_atomic(text, text, jsonb, jsonb) to service_role;
grant execute on function public.delete_commission_atomic(text) to service_role;

commit;

     or coalesce(p_request_hash, '') !~ '^[0-9a-f]{64}
     or jsonb_typeof(p_order) is distinct from 'object'
     or jsonb_typeof(p_track) is distinct from 'object'
     or coalesce(p_order->>'serviceId', '') = ''
     or coalesce(p_order->>'serviceTitle', '') = ''
     or jsonb_typeof(p_order->'form') is distinct from 'object'
     or jsonb_typeof(p_order->'estimate') is distinct from 'object'
     or coalesce(p_track->>'emailHash', '') !~ '^[0-9a-f]{64}$' then
    raise exception 'Invalid commission submission payload' using errcode = '22023';
  end if;

  v_lock_key := pg_catalog.hashtextextended(p_idempotency_key_hash, 0);
  perform pg_catalog.pg_advisory_xact_lock(v_lock_key);

  select * into v_key
    from public.commission_submit_keys
   where key_hash = p_idempotency_key_hash
   for update;

  if found then
    if v_key.request_hash <> p_request_hash then
      raise exception 'IDEMPOTENCY_KEY_CONFLICT' using errcode = 'P0001';
    end if;
    if v_key.deleted_at is not null then
      raise exception 'IDEMPOTENCY_KEY_RETIRED' using errcode = 'P0001';
    end if;
    select * into v_track
      from public.order_tracks
     where id = v_key.commission_id;
    if not found then
      raise exception 'IDEMPOTENCY_RESULT_MISSING' using errcode = 'P0001';
    end if;
    return jsonb_build_object('track', to_jsonb(v_track), 'duplicate', true);
  end if;

  v_id := public.next_commission_id();

  insert into public.commission_requests (
    id, created_at, "createdAt", status, payment,
    "serviceId", "serviceTitle", "tierName",
    form, estimate, notes, "finalPrice", "extraLines"
  ) values (
    v_id,
    coalesce(nullif(p_order->>'created_at', '')::timestamptz, now()),
    coalesce(p_order->>'createdAt', now()::text),
    'Pending Review',
    'Unpaid',
    p_order->>'serviceId',
    p_order->>'serviceTitle',
    coalesce(p_order->>'tierName', ''),
    p_order->'form',
    p_order->'estimate',
    '',
    null,
    ''
  );

  insert into public.order_tracks (
    id, created_at, "createdAt", "serviceTitle", status, payment,
    estimate, custom, "emailHash", client_name, proposal, updates, "finalFiles"
  ) values (
    v_id,
    coalesce(nullif(p_track->>'created_at', '')::timestamptz, now()),
    coalesce(p_track->>'createdAt', now()::text),
    p_order->>'serviceTitle',
    'Pending Review',
    'Unpaid',
    (p_order->'estimate'->>'total')::numeric,
    coalesce((p_order->'estimate'->>'custom')::boolean, false),
    p_track->>'emailHash',
    coalesce(nullif(p_track->>'client_name', ''), 'Client'),
    null,
    '[]'::jsonb,
    '[]'::jsonb
  )
  returning * into v_track;

  insert into public.commission_submit_keys (key_hash, request_hash, commission_id)
  values (p_idempotency_key_hash, p_request_hash, v_id);

  return jsonb_build_object('track', to_jsonb(v_track), 'duplicate', false);
end;
$$;

create or replace function public.delete_commission_atomic(p_commission_id text)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_deleted integer;
begin
  if coalesce(p_commission_id, '') !~ '^COMMISSION-[0-9]{4}-[0-9]{4,}$' then
    raise exception 'Invalid commission ID' using errcode = '22023';
  end if;

  -- Explicitly remove every related row inside this transaction.
  delete from public.client_reviews where commission_id = p_commission_id;
  delete from public.order_tracks where id = p_commission_id;
  delete from public.commission_management where id = p_commission_id;
  delete from public.notifications where order_id = p_commission_id;
  delete from public.commission_requests where id = p_commission_id;
  get diagnostics v_deleted = row_count;

  -- Retain a tombstone so a replayed idempotency key cannot recreate a deleted order.
  update public.commission_submit_keys
     set deleted_at = coalesce(deleted_at, now())
   where commission_id = p_commission_id;

  return v_deleted > 0;
end;
$$;

revoke all on function public.submit_commission_atomic(text, text, jsonb, jsonb) from public, anon, authenticated;
revoke all on function public.delete_commission_atomic(text) from public, anon, authenticated;
grant execute on function public.submit_commission_atomic(text, text, jsonb, jsonb) to service_role;
grant execute on function public.delete_commission_atomic(text) to service_role;

commit;

     or jsonb_typeof(p_order) is distinct from 'object'
     or jsonb_typeof(p_track) is distinct from 'object'
     or coalesce(p_order->>'serviceId', '') = ''
     or coalesce(p_order->>'serviceTitle', '') = ''
     or jsonb_typeof(p_order->'form') is distinct from 'object'
     or jsonb_typeof(p_order->'estimate') is distinct from 'object'
     or coalesce(p_track->>'emailHash', '') !~ '^[0-9a-f]{64}$' then
    raise exception 'Invalid commission submission payload' using errcode = '22023';
  end if;

  v_lock_key := pg_catalog.hashtextextended(p_idempotency_key_hash, 0);
  perform pg_catalog.pg_advisory_xact_lock(v_lock_key);

  select * into v_key
    from public.commission_submit_keys
   where key_hash = p_idempotency_key_hash
   for update;

  if found then
    if v_key.request_hash <> p_request_hash then
      raise exception 'IDEMPOTENCY_KEY_CONFLICT' using errcode = 'P0001';
    end if;
    if v_key.deleted_at is not null then
      raise exception 'IDEMPOTENCY_KEY_RETIRED' using errcode = 'P0001';
    end if;
    select * into v_track
      from public.order_tracks
     where id = v_key.commission_id;
    if not found then
      raise exception 'IDEMPOTENCY_RESULT_MISSING' using errcode = 'P0001';
    end if;
    return jsonb_build_object('track', to_jsonb(v_track), 'duplicate', true);
  end if;

  v_id := public.next_commission_id();

  insert into public.commission_requests (
    id, created_at, "createdAt", status, payment,
    "serviceId", "serviceTitle", "tierName",
    form, estimate, notes, "finalPrice", "extraLines"
  ) values (
    v_id,
    coalesce(nullif(p_order->>'created_at', '')::timestamptz, now()),
    coalesce(p_order->>'createdAt', now()::text),
    'Pending Review',
    'Unpaid',
    p_order->>'serviceId',
    p_order->>'serviceTitle',
    coalesce(p_order->>'tierName', ''),
    p_order->'form',
    p_order->'estimate',
    '',
    null,
    ''
  );

  insert into public.order_tracks (
    id, created_at, "createdAt", "serviceTitle", status, payment,
    estimate, custom, "emailHash", client_name, proposal, updates, "finalFiles"
  ) values (
    v_id,
    coalesce(nullif(p_track->>'created_at', '')::timestamptz, now()),
    coalesce(p_track->>'createdAt', now()::text),
    p_order->>'serviceTitle',
    'Pending Review',
    'Unpaid',
    (p_order->'estimate'->>'total')::numeric,
    coalesce((p_order->'estimate'->>'custom')::boolean, false),
    p_track->>'emailHash',
    coalesce(nullif(p_track->>'client_name', ''), 'Client'),
    null,
    '[]'::jsonb,
    '[]'::jsonb
  )
  returning * into v_track;

  insert into public.commission_submit_keys (key_hash, request_hash, commission_id)
  values (p_idempotency_key_hash, p_request_hash, v_id);

  return jsonb_build_object('track', to_jsonb(v_track), 'duplicate', false);
end;
$$;

create or replace function public.delete_commission_atomic(p_commission_id text)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_deleted integer;
begin
  if coalesce(p_commission_id, '') !~ '^COMMISSION-[0-9]{4}-[0-9]{4,}$' then
    raise exception 'Invalid commission ID' using errcode = '22023';
  end if;

  -- Explicitly remove every related row inside this transaction.
  delete from public.client_reviews where commission_id = p_commission_id;
  delete from public.order_tracks where id = p_commission_id;
  delete from public.commission_management where id = p_commission_id;
  delete from public.notifications where order_id = p_commission_id;
  delete from public.commission_requests where id = p_commission_id;
  get diagnostics v_deleted = row_count;

  -- Retain a tombstone so a replayed idempotency key cannot recreate a deleted order.
  update public.commission_submit_keys
     set deleted_at = coalesce(deleted_at, now())
   where commission_id = p_commission_id;

  return v_deleted > 0;
end;
$$;

revoke all on function public.submit_commission_atomic(text, text, jsonb, jsonb) from public, anon, authenticated;
revoke all on function public.delete_commission_atomic(text) from public, anon, authenticated;
grant execute on function public.submit_commission_atomic(text, text, jsonb, jsonb) to service_role;
grant execute on function public.delete_commission_atomic(text) to service_role;

commit;

     or coalesce(p_order->>'serviceId', '') = ''
     or coalesce(p_order->>'serviceTitle', '') = ''
     or jsonb_typeof(p_order->'form') is distinct from 'object'
     or jsonb_typeof(p_order->'estimate') is distinct from 'object' then
    raise exception 'Invalid commission submission payload' using errcode = '22023';
  end if;

  v_lock_key := pg_catalog.hashtextextended(p_idempotency_key_hash, 0);
  perform pg_catalog.pg_advisory_xact_lock(v_lock_key);

  select * into v_key
    from public.commission_submit_keys
   where key_hash = p_idempotency_key_hash
   for update;

  if found then
    if v_key.request_hash <> p_request_hash then
      raise exception 'IDEMPOTENCY_KEY_CONFLICT' using errcode = 'P0001';
    end if;
    if v_key.deleted_at is not null then
      raise exception 'IDEMPOTENCY_KEY_RETIRED' using errcode = 'P0001';
    end if;
    select * into v_track
      from public.order_tracks
     where id = v_key.commission_id;
    if not found then
      raise exception 'IDEMPOTENCY_RESULT_MISSING' using errcode = 'P0001';
    end if;
    return jsonb_build_object('track', to_jsonb(v_track), 'duplicate', true);
  end if;

  v_id := public.next_commission_id();

  insert into public.commission_requests (
    id, created_at, "createdAt", status, payment,
    "serviceId", "serviceTitle", "tierName",
    form, estimate, notes, "finalPrice", "extraLines"
  ) values (
    v_id,
    coalesce(nullif(p_order->>'created_at', '')::timestamptz, now()),
    coalesce(p_order->>'createdAt', now()::text),
    'Pending Review',
    'Unpaid',
    p_order->>'serviceId',
    p_order->>'serviceTitle',
    coalesce(p_order->>'tierName', ''),
    p_order->'form',
    p_order->'estimate',
    '',
    null,
    ''
  );

  insert into public.order_tracks (
    id, created_at, "createdAt", "serviceTitle", status, payment,
    estimate, custom, "emailHash", client_name, proposal, updates, "finalFiles"
  ) values (
    v_id,
    coalesce(nullif(p_track->>'created_at', '')::timestamptz, now()),
    coalesce(p_track->>'createdAt', now()::text),
    p_order->>'serviceTitle',
    'Pending Review',
    'Unpaid',
    (p_order->'estimate'->>'total')::numeric,
    coalesce((p_order->'estimate'->>'custom')::boolean, false),
    pg_catalog.encode(public.digest(lower(trim(p_order->'form'->>'email')) || '|' || v_id, 'sha256'), 'hex'),
    coalesce(nullif(p_track->>'client_name', ''), 'Client'),
    null,
    '[]'::jsonb,
    '[]'::jsonb
  )
  returning * into v_track;

  insert into public.commission_submit_keys (key_hash, request_hash, commission_id)
  values (p_idempotency_key_hash, p_request_hash, v_id);

  return jsonb_build_object('track', to_jsonb(v_track), 'duplicate', false);
end;
$$;

create or replace function public.delete_commission_atomic(p_commission_id text)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_deleted integer;
begin
  if coalesce(p_commission_id, '') !~ '^COMMISSION-[0-9]{4}-[0-9]{4,}$' then
    raise exception 'Invalid commission ID' using errcode = '22023';
  end if;

  -- Explicitly remove every related row inside this transaction.
  delete from public.client_reviews where commission_id = p_commission_id;
  delete from public.order_tracks where id = p_commission_id;
  delete from public.commission_management where id = p_commission_id;
  delete from public.notifications where order_id = p_commission_id;
  delete from public.commission_requests where id = p_commission_id;
  get diagnostics v_deleted = row_count;

  -- Retain a tombstone so a replayed idempotency key cannot recreate a deleted order.
  update public.commission_submit_keys
     set deleted_at = coalesce(deleted_at, now())
   where commission_id = p_commission_id;

  return v_deleted > 0;
end;
$$;

revoke all on function public.submit_commission_atomic(text, text, jsonb, jsonb) from public, anon, authenticated;
revoke all on function public.delete_commission_atomic(text) from public, anon, authenticated;
grant execute on function public.submit_commission_atomic(text, text, jsonb, jsonb) to service_role;
grant execute on function public.delete_commission_atomic(text) to service_role;

commit;

     or coalesce(p_request_hash, '') !~ '^[0-9a-f]{64}
     or jsonb_typeof(p_order) is distinct from 'object'
     or jsonb_typeof(p_track) is distinct from 'object'
     or coalesce(p_order->>'serviceId', '') = ''
     or coalesce(p_order->>'serviceTitle', '') = ''
     or jsonb_typeof(p_order->'form') is distinct from 'object'
     or jsonb_typeof(p_order->'estimate') is distinct from 'object'
     or coalesce(p_track->>'emailHash', '') !~ '^[0-9a-f]{64}$' then
    raise exception 'Invalid commission submission payload' using errcode = '22023';
  end if;

  v_lock_key := pg_catalog.hashtextextended(p_idempotency_key_hash, 0);
  perform pg_catalog.pg_advisory_xact_lock(v_lock_key);

  select * into v_key
    from public.commission_submit_keys
   where key_hash = p_idempotency_key_hash
   for update;

  if found then
    if v_key.request_hash <> p_request_hash then
      raise exception 'IDEMPOTENCY_KEY_CONFLICT' using errcode = 'P0001';
    end if;
    if v_key.deleted_at is not null then
      raise exception 'IDEMPOTENCY_KEY_RETIRED' using errcode = 'P0001';
    end if;
    select * into v_track
      from public.order_tracks
     where id = v_key.commission_id;
    if not found then
      raise exception 'IDEMPOTENCY_RESULT_MISSING' using errcode = 'P0001';
    end if;
    return jsonb_build_object('track', to_jsonb(v_track), 'duplicate', true);
  end if;

  v_id := public.next_commission_id();

  insert into public.commission_requests (
    id, created_at, "createdAt", status, payment,
    "serviceId", "serviceTitle", "tierName",
    form, estimate, notes, "finalPrice", "extraLines"
  ) values (
    v_id,
    coalesce(nullif(p_order->>'created_at', '')::timestamptz, now()),
    coalesce(p_order->>'createdAt', now()::text),
    'Pending Review',
    'Unpaid',
    p_order->>'serviceId',
    p_order->>'serviceTitle',
    coalesce(p_order->>'tierName', ''),
    p_order->'form',
    p_order->'estimate',
    '',
    null,
    ''
  );

  insert into public.order_tracks (
    id, created_at, "createdAt", "serviceTitle", status, payment,
    estimate, custom, "emailHash", client_name, proposal, updates, "finalFiles"
  ) values (
    v_id,
    coalesce(nullif(p_track->>'created_at', '')::timestamptz, now()),
    coalesce(p_track->>'createdAt', now()::text),
    p_order->>'serviceTitle',
    'Pending Review',
    'Unpaid',
    (p_order->'estimate'->>'total')::numeric,
    coalesce((p_order->'estimate'->>'custom')::boolean, false),
    p_track->>'emailHash',
    coalesce(nullif(p_track->>'client_name', ''), 'Client'),
    null,
    '[]'::jsonb,
    '[]'::jsonb
  )
  returning * into v_track;

  insert into public.commission_submit_keys (key_hash, request_hash, commission_id)
  values (p_idempotency_key_hash, p_request_hash, v_id);

  return jsonb_build_object('track', to_jsonb(v_track), 'duplicate', false);
end;
$$;

create or replace function public.delete_commission_atomic(p_commission_id text)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_deleted integer;
begin
  if coalesce(p_commission_id, '') !~ '^COMMISSION-[0-9]{4}-[0-9]{4,}$' then
    raise exception 'Invalid commission ID' using errcode = '22023';
  end if;

  -- Explicitly remove every related row inside this transaction.
  delete from public.client_reviews where commission_id = p_commission_id;
  delete from public.order_tracks where id = p_commission_id;
  delete from public.commission_management where id = p_commission_id;
  delete from public.notifications where order_id = p_commission_id;
  delete from public.commission_requests where id = p_commission_id;
  get diagnostics v_deleted = row_count;

  -- Retain a tombstone so a replayed idempotency key cannot recreate a deleted order.
  update public.commission_submit_keys
     set deleted_at = coalesce(deleted_at, now())
   where commission_id = p_commission_id;

  return v_deleted > 0;
end;
$$;

revoke all on function public.submit_commission_atomic(text, text, jsonb, jsonb) from public, anon, authenticated;
revoke all on function public.delete_commission_atomic(text) from public, anon, authenticated;
grant execute on function public.submit_commission_atomic(text, text, jsonb, jsonb) to service_role;
grant execute on function public.delete_commission_atomic(text) to service_role;

commit;

     or jsonb_typeof(p_order) is distinct from 'object'
     or jsonb_typeof(p_track) is distinct from 'object'
     or coalesce(p_order->>'serviceId', '') = ''
     or coalesce(p_order->>'serviceTitle', '') = ''
     or jsonb_typeof(p_order->'form') is distinct from 'object'
     or jsonb_typeof(p_order->'estimate') is distinct from 'object'
     or coalesce(p_track->>'emailHash', '') !~ '^[0-9a-f]{64}$' then
    raise exception 'Invalid commission submission payload' using errcode = '22023';
  end if;

  v_lock_key := pg_catalog.hashtextextended(p_idempotency_key_hash, 0);
  perform pg_catalog.pg_advisory_xact_lock(v_lock_key);

  select * into v_key
    from public.commission_submit_keys
   where key_hash = p_idempotency_key_hash
   for update;

  if found then
    if v_key.request_hash <> p_request_hash then
      raise exception 'IDEMPOTENCY_KEY_CONFLICT' using errcode = 'P0001';
    end if;
    if v_key.deleted_at is not null then
      raise exception 'IDEMPOTENCY_KEY_RETIRED' using errcode = 'P0001';
    end if;
    select * into v_track
      from public.order_tracks
     where id = v_key.commission_id;
    if not found then
      raise exception 'IDEMPOTENCY_RESULT_MISSING' using errcode = 'P0001';
    end if;
    return jsonb_build_object('track', to_jsonb(v_track), 'duplicate', true);
  end if;

  v_id := public.next_commission_id();

  insert into public.commission_requests (
    id, created_at, "createdAt", status, payment,
    "serviceId", "serviceTitle", "tierName",
    form, estimate, notes, "finalPrice", "extraLines"
  ) values (
    v_id,
    coalesce(nullif(p_order->>'created_at', '')::timestamptz, now()),
    coalesce(p_order->>'createdAt', now()::text),
    'Pending Review',
    'Unpaid',
    p_order->>'serviceId',
    p_order->>'serviceTitle',
    coalesce(p_order->>'tierName', ''),
    p_order->'form',
    p_order->'estimate',
    '',
    null,
    ''
  );

  insert into public.order_tracks (
    id, created_at, "createdAt", "serviceTitle", status, payment,
    estimate, custom, "emailHash", client_name, proposal, updates, "finalFiles"
  ) values (
    v_id,
    coalesce(nullif(p_track->>'created_at', '')::timestamptz, now()),
    coalesce(p_track->>'createdAt', now()::text),
    p_order->>'serviceTitle',
    'Pending Review',
    'Unpaid',
    (p_order->'estimate'->>'total')::numeric,
    coalesce((p_order->'estimate'->>'custom')::boolean, false),
    p_track->>'emailHash',
    coalesce(nullif(p_track->>'client_name', ''), 'Client'),
    null,
    '[]'::jsonb,
    '[]'::jsonb
  )
  returning * into v_track;

  insert into public.commission_submit_keys (key_hash, request_hash, commission_id)
  values (p_idempotency_key_hash, p_request_hash, v_id);

  return jsonb_build_object('track', to_jsonb(v_track), 'duplicate', false);
end;
$$;

create or replace function public.delete_commission_atomic(p_commission_id text)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_deleted integer;
begin
  if coalesce(p_commission_id, '') !~ '^COMMISSION-[0-9]{4}-[0-9]{4,}$' then
    raise exception 'Invalid commission ID' using errcode = '22023';
  end if;

  -- Explicitly remove every related row inside this transaction.
  delete from public.client_reviews where commission_id = p_commission_id;
  delete from public.order_tracks where id = p_commission_id;
  delete from public.commission_management where id = p_commission_id;
  delete from public.notifications where order_id = p_commission_id;
  delete from public.commission_requests where id = p_commission_id;
  get diagnostics v_deleted = row_count;

  -- Retain a tombstone so a replayed idempotency key cannot recreate a deleted order.
  update public.commission_submit_keys
     set deleted_at = coalesce(deleted_at, now())
   where commission_id = p_commission_id;

  return v_deleted > 0;
end;
$$;

revoke all on function public.submit_commission_atomic(text, text, jsonb, jsonb) from public, anon, authenticated;
revoke all on function public.delete_commission_atomic(text) from public, anon, authenticated;
grant execute on function public.submit_commission_atomic(text, text, jsonb, jsonb) to service_role;
grant execute on function public.delete_commission_atomic(text) to service_role;

commit;

     or coalesce(p_request_hash, '') !~ '^[0-9a-f]{64}
     or jsonb_typeof(p_track) is distinct from 'object'
     or coalesce(p_order->>'serviceId', '') = ''
     or coalesce(p_order->>'serviceTitle', '') = ''
     or jsonb_typeof(p_order->'form') is distinct from 'object'
     or jsonb_typeof(p_order->'estimate') is distinct from 'object' then
    raise exception 'Invalid commission submission payload' using errcode = '22023';
  end if;

  v_lock_key := pg_catalog.hashtextextended(p_idempotency_key_hash, 0);
  perform pg_catalog.pg_advisory_xact_lock(v_lock_key);

  select * into v_key
    from public.commission_submit_keys
   where key_hash = p_idempotency_key_hash
   for update;

  if found then
    if v_key.request_hash <> p_request_hash then
      raise exception 'IDEMPOTENCY_KEY_CONFLICT' using errcode = 'P0001';
    end if;
    if v_key.deleted_at is not null then
      raise exception 'IDEMPOTENCY_KEY_RETIRED' using errcode = 'P0001';
    end if;
    select * into v_track
      from public.order_tracks
     where id = v_key.commission_id;
    if not found then
      raise exception 'IDEMPOTENCY_RESULT_MISSING' using errcode = 'P0001';
    end if;
    return jsonb_build_object('track', to_jsonb(v_track), 'duplicate', true);
  end if;

  v_id := public.next_commission_id();

  insert into public.commission_requests (
    id, created_at, "createdAt", status, payment,
    "serviceId", "serviceTitle", "tierName",
    form, estimate, notes, "finalPrice", "extraLines"
  ) values (
    v_id,
    coalesce(nullif(p_order->>'created_at', '')::timestamptz, now()),
    coalesce(p_order->>'createdAt', now()::text),
    'Pending Review',
    'Unpaid',
    p_order->>'serviceId',
    p_order->>'serviceTitle',
    coalesce(p_order->>'tierName', ''),
    p_order->'form',
    p_order->'estimate',
    '',
    null,
    ''
  );

  insert into public.order_tracks (
    id, created_at, "createdAt", "serviceTitle", status, payment,
    estimate, custom, "emailHash", client_name, proposal, updates, "finalFiles"
  ) values (
    v_id,
    coalesce(nullif(p_track->>'created_at', '')::timestamptz, now()),
    coalesce(p_track->>'createdAt', now()::text),
    p_order->>'serviceTitle',
    'Pending Review',
    'Unpaid',
    (p_order->'estimate'->>'total')::numeric,
    coalesce((p_order->'estimate'->>'custom')::boolean, false),
    pg_catalog.encode(public.digest(lower(trim(p_order->'form'->>'email')) || '|' || v_id, 'sha256'), 'hex'),
    coalesce(nullif(p_track->>'client_name', ''), 'Client'),
    null,
    '[]'::jsonb,
    '[]'::jsonb
  )
  returning * into v_track;

  insert into public.commission_submit_keys (key_hash, request_hash, commission_id)
  values (p_idempotency_key_hash, p_request_hash, v_id);

  return jsonb_build_object('track', to_jsonb(v_track), 'duplicate', false);
end;
$$;

create or replace function public.delete_commission_atomic(p_commission_id text)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_deleted integer;
begin
  if coalesce(p_commission_id, '') !~ '^COMMISSION-[0-9]{4}-[0-9]{4,}$' then
    raise exception 'Invalid commission ID' using errcode = '22023';
  end if;

  -- Explicitly remove every related row inside this transaction.
  delete from public.client_reviews where commission_id = p_commission_id;
  delete from public.order_tracks where id = p_commission_id;
  delete from public.commission_management where id = p_commission_id;
  delete from public.notifications where order_id = p_commission_id;
  delete from public.commission_requests where id = p_commission_id;
  get diagnostics v_deleted = row_count;

  -- Retain a tombstone so a replayed idempotency key cannot recreate a deleted order.
  update public.commission_submit_keys
     set deleted_at = coalesce(deleted_at, now())
   where commission_id = p_commission_id;

  return v_deleted > 0;
end;
$$;

revoke all on function public.submit_commission_atomic(text, text, jsonb, jsonb) from public, anon, authenticated;
revoke all on function public.delete_commission_atomic(text) from public, anon, authenticated;
grant execute on function public.submit_commission_atomic(text, text, jsonb, jsonb) to service_role;
grant execute on function public.delete_commission_atomic(text) to service_role;

commit;

     or coalesce(p_request_hash, '') !~ '^[0-9a-f]{64}
     or jsonb_typeof(p_order) is distinct from 'object'
     or jsonb_typeof(p_track) is distinct from 'object'
     or coalesce(p_order->>'serviceId', '') = ''
     or coalesce(p_order->>'serviceTitle', '') = ''
     or jsonb_typeof(p_order->'form') is distinct from 'object'
     or jsonb_typeof(p_order->'estimate') is distinct from 'object'
     or coalesce(p_track->>'emailHash', '') !~ '^[0-9a-f]{64}$' then
    raise exception 'Invalid commission submission payload' using errcode = '22023';
  end if;

  v_lock_key := pg_catalog.hashtextextended(p_idempotency_key_hash, 0);
  perform pg_catalog.pg_advisory_xact_lock(v_lock_key);

  select * into v_key
    from public.commission_submit_keys
   where key_hash = p_idempotency_key_hash
   for update;

  if found then
    if v_key.request_hash <> p_request_hash then
      raise exception 'IDEMPOTENCY_KEY_CONFLICT' using errcode = 'P0001';
    end if;
    if v_key.deleted_at is not null then
      raise exception 'IDEMPOTENCY_KEY_RETIRED' using errcode = 'P0001';
    end if;
    select * into v_track
      from public.order_tracks
     where id = v_key.commission_id;
    if not found then
      raise exception 'IDEMPOTENCY_RESULT_MISSING' using errcode = 'P0001';
    end if;
    return jsonb_build_object('track', to_jsonb(v_track), 'duplicate', true);
  end if;

  v_id := public.next_commission_id();

  insert into public.commission_requests (
    id, created_at, "createdAt", status, payment,
    "serviceId", "serviceTitle", "tierName",
    form, estimate, notes, "finalPrice", "extraLines"
  ) values (
    v_id,
    coalesce(nullif(p_order->>'created_at', '')::timestamptz, now()),
    coalesce(p_order->>'createdAt', now()::text),
    'Pending Review',
    'Unpaid',
    p_order->>'serviceId',
    p_order->>'serviceTitle',
    coalesce(p_order->>'tierName', ''),
    p_order->'form',
    p_order->'estimate',
    '',
    null,
    ''
  );

  insert into public.order_tracks (
    id, created_at, "createdAt", "serviceTitle", status, payment,
    estimate, custom, "emailHash", client_name, proposal, updates, "finalFiles"
  ) values (
    v_id,
    coalesce(nullif(p_track->>'created_at', '')::timestamptz, now()),
    coalesce(p_track->>'createdAt', now()::text),
    p_order->>'serviceTitle',
    'Pending Review',
    'Unpaid',
    (p_order->'estimate'->>'total')::numeric,
    coalesce((p_order->'estimate'->>'custom')::boolean, false),
    p_track->>'emailHash',
    coalesce(nullif(p_track->>'client_name', ''), 'Client'),
    null,
    '[]'::jsonb,
    '[]'::jsonb
  )
  returning * into v_track;

  insert into public.commission_submit_keys (key_hash, request_hash, commission_id)
  values (p_idempotency_key_hash, p_request_hash, v_id);

  return jsonb_build_object('track', to_jsonb(v_track), 'duplicate', false);
end;
$$;

create or replace function public.delete_commission_atomic(p_commission_id text)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_deleted integer;
begin
  if coalesce(p_commission_id, '') !~ '^COMMISSION-[0-9]{4}-[0-9]{4,}$' then
    raise exception 'Invalid commission ID' using errcode = '22023';
  end if;

  -- Explicitly remove every related row inside this transaction.
  delete from public.client_reviews where commission_id = p_commission_id;
  delete from public.order_tracks where id = p_commission_id;
  delete from public.commission_management where id = p_commission_id;
  delete from public.notifications where order_id = p_commission_id;
  delete from public.commission_requests where id = p_commission_id;
  get diagnostics v_deleted = row_count;

  -- Retain a tombstone so a replayed idempotency key cannot recreate a deleted order.
  update public.commission_submit_keys
     set deleted_at = coalesce(deleted_at, now())
   where commission_id = p_commission_id;

  return v_deleted > 0;
end;
$$;

revoke all on function public.submit_commission_atomic(text, text, jsonb, jsonb) from public, anon, authenticated;
revoke all on function public.delete_commission_atomic(text) from public, anon, authenticated;
grant execute on function public.submit_commission_atomic(text, text, jsonb, jsonb) to service_role;
grant execute on function public.delete_commission_atomic(text) to service_role;

commit;

     or jsonb_typeof(p_order) is distinct from 'object'
     or jsonb_typeof(p_track) is distinct from 'object'
     or coalesce(p_order->>'serviceId', '') = ''
     or coalesce(p_order->>'serviceTitle', '') = ''
     or jsonb_typeof(p_order->'form') is distinct from 'object'
     or jsonb_typeof(p_order->'estimate') is distinct from 'object'
     or coalesce(p_track->>'emailHash', '') !~ '^[0-9a-f]{64}$' then
    raise exception 'Invalid commission submission payload' using errcode = '22023';
  end if;

  v_lock_key := pg_catalog.hashtextextended(p_idempotency_key_hash, 0);
  perform pg_catalog.pg_advisory_xact_lock(v_lock_key);

  select * into v_key
    from public.commission_submit_keys
   where key_hash = p_idempotency_key_hash
   for update;

  if found then
    if v_key.request_hash <> p_request_hash then
      raise exception 'IDEMPOTENCY_KEY_CONFLICT' using errcode = 'P0001';
    end if;
    if v_key.deleted_at is not null then
      raise exception 'IDEMPOTENCY_KEY_RETIRED' using errcode = 'P0001';
    end if;
    select * into v_track
      from public.order_tracks
     where id = v_key.commission_id;
    if not found then
      raise exception 'IDEMPOTENCY_RESULT_MISSING' using errcode = 'P0001';
    end if;
    return jsonb_build_object('track', to_jsonb(v_track), 'duplicate', true);
  end if;

  v_id := public.next_commission_id();

  insert into public.commission_requests (
    id, created_at, "createdAt", status, payment,
    "serviceId", "serviceTitle", "tierName",
    form, estimate, notes, "finalPrice", "extraLines"
  ) values (
    v_id,
    coalesce(nullif(p_order->>'created_at', '')::timestamptz, now()),
    coalesce(p_order->>'createdAt', now()::text),
    'Pending Review',
    'Unpaid',
    p_order->>'serviceId',
    p_order->>'serviceTitle',
    coalesce(p_order->>'tierName', ''),
    p_order->'form',
    p_order->'estimate',
    '',
    null,
    ''
  );

  insert into public.order_tracks (
    id, created_at, "createdAt", "serviceTitle", status, payment,
    estimate, custom, "emailHash", client_name, proposal, updates, "finalFiles"
  ) values (
    v_id,
    coalesce(nullif(p_track->>'created_at', '')::timestamptz, now()),
    coalesce(p_track->>'createdAt', now()::text),
    p_order->>'serviceTitle',
    'Pending Review',
    'Unpaid',
    (p_order->'estimate'->>'total')::numeric,
    coalesce((p_order->'estimate'->>'custom')::boolean, false),
    p_track->>'emailHash',
    coalesce(nullif(p_track->>'client_name', ''), 'Client'),
    null,
    '[]'::jsonb,
    '[]'::jsonb
  )
  returning * into v_track;

  insert into public.commission_submit_keys (key_hash, request_hash, commission_id)
  values (p_idempotency_key_hash, p_request_hash, v_id);

  return jsonb_build_object('track', to_jsonb(v_track), 'duplicate', false);
end;
$$;

create or replace function public.delete_commission_atomic(p_commission_id text)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_deleted integer;
begin
  if coalesce(p_commission_id, '') !~ '^COMMISSION-[0-9]{4}-[0-9]{4,}$' then
    raise exception 'Invalid commission ID' using errcode = '22023';
  end if;

  -- Explicitly remove every related row inside this transaction.
  delete from public.client_reviews where commission_id = p_commission_id;
  delete from public.order_tracks where id = p_commission_id;
  delete from public.commission_management where id = p_commission_id;
  delete from public.notifications where order_id = p_commission_id;
  delete from public.commission_requests where id = p_commission_id;
  get diagnostics v_deleted = row_count;

  -- Retain a tombstone so a replayed idempotency key cannot recreate a deleted order.
  update public.commission_submit_keys
     set deleted_at = coalesce(deleted_at, now())
   where commission_id = p_commission_id;

  return v_deleted > 0;
end;
$$;

revoke all on function public.submit_commission_atomic(text, text, jsonb, jsonb) from public, anon, authenticated;
revoke all on function public.delete_commission_atomic(text) from public, anon, authenticated;
grant execute on function public.submit_commission_atomic(text, text, jsonb, jsonb) to service_role;
grant execute on function public.delete_commission_atomic(text) to service_role;

commit;

     or jsonb_typeof(p_order) is distinct from 'object'
     or jsonb_typeof(p_track) is distinct from 'object'
     or coalesce(p_order->>'serviceId', '') = ''
     or coalesce(p_order->>'serviceTitle', '') = ''
     or jsonb_typeof(p_order->'form') is distinct from 'object'
     or jsonb_typeof(p_order->'estimate') is distinct from 'object' then
    raise exception 'Invalid commission submission payload' using errcode = '22023';
  end if;

  v_lock_key := pg_catalog.hashtextextended(p_idempotency_key_hash, 0);
  perform pg_catalog.pg_advisory_xact_lock(v_lock_key);

  select * into v_key
    from public.commission_submit_keys
   where key_hash = p_idempotency_key_hash
   for update;

  if found then
    if v_key.request_hash <> p_request_hash then
      raise exception 'IDEMPOTENCY_KEY_CONFLICT' using errcode = 'P0001';
    end if;
    if v_key.deleted_at is not null then
      raise exception 'IDEMPOTENCY_KEY_RETIRED' using errcode = 'P0001';
    end if;
    select * into v_track
      from public.order_tracks
     where id = v_key.commission_id;
    if not found then
      raise exception 'IDEMPOTENCY_RESULT_MISSING' using errcode = 'P0001';
    end if;
    return jsonb_build_object('track', to_jsonb(v_track), 'duplicate', true);
  end if;

  v_id := public.next_commission_id();

  insert into public.commission_requests (
    id, created_at, "createdAt", status, payment,
    "serviceId", "serviceTitle", "tierName",
    form, estimate, notes, "finalPrice", "extraLines"
  ) values (
    v_id,
    coalesce(nullif(p_order->>'created_at', '')::timestamptz, now()),
    coalesce(p_order->>'createdAt', now()::text),
    'Pending Review',
    'Unpaid',
    p_order->>'serviceId',
    p_order->>'serviceTitle',
    coalesce(p_order->>'tierName', ''),
    p_order->'form',
    p_order->'estimate',
    '',
    null,
    ''
  );

  insert into public.order_tracks (
    id, created_at, "createdAt", "serviceTitle", status, payment,
    estimate, custom, "emailHash", client_name, proposal, updates, "finalFiles"
  ) values (
    v_id,
    coalesce(nullif(p_track->>'created_at', '')::timestamptz, now()),
    coalesce(p_track->>'createdAt', now()::text),
    p_order->>'serviceTitle',
    'Pending Review',
    'Unpaid',
    (p_order->'estimate'->>'total')::numeric,
    coalesce((p_order->'estimate'->>'custom')::boolean, false),
    pg_catalog.encode(public.digest(lower(trim(p_order->'form'->>'email')) || '|' || v_id, 'sha256'), 'hex'),
    coalesce(nullif(p_track->>'client_name', ''), 'Client'),
    null,
    '[]'::jsonb,
    '[]'::jsonb
  )
  returning * into v_track;

  insert into public.commission_submit_keys (key_hash, request_hash, commission_id)
  values (p_idempotency_key_hash, p_request_hash, v_id);

  return jsonb_build_object('track', to_jsonb(v_track), 'duplicate', false);
end;
$$;

create or replace function public.delete_commission_atomic(p_commission_id text)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_deleted integer;
begin
  if coalesce(p_commission_id, '') !~ '^COMMISSION-[0-9]{4}-[0-9]{4,}$' then
    raise exception 'Invalid commission ID' using errcode = '22023';
  end if;

  -- Explicitly remove every related row inside this transaction.
  delete from public.client_reviews where commission_id = p_commission_id;
  delete from public.order_tracks where id = p_commission_id;
  delete from public.commission_management where id = p_commission_id;
  delete from public.notifications where order_id = p_commission_id;
  delete from public.commission_requests where id = p_commission_id;
  get diagnostics v_deleted = row_count;

  -- Retain a tombstone so a replayed idempotency key cannot recreate a deleted order.
  update public.commission_submit_keys
     set deleted_at = coalesce(deleted_at, now())
   where commission_id = p_commission_id;

  return v_deleted > 0;
end;
$$;

revoke all on function public.submit_commission_atomic(text, text, jsonb, jsonb) from public, anon, authenticated;
revoke all on function public.delete_commission_atomic(text) from public, anon, authenticated;
grant execute on function public.submit_commission_atomic(text, text, jsonb, jsonb) to service_role;
grant execute on function public.delete_commission_atomic(text) to service_role;

commit;

     or coalesce(p_request_hash, '') !~ '^[0-9a-f]{64}
     or jsonb_typeof(p_order) is distinct from 'object'
     or jsonb_typeof(p_track) is distinct from 'object'
     or coalesce(p_order->>'serviceId', '') = ''
     or coalesce(p_order->>'serviceTitle', '') = ''
     or jsonb_typeof(p_order->'form') is distinct from 'object'
     or jsonb_typeof(p_order->'estimate') is distinct from 'object'
     or coalesce(p_track->>'emailHash', '') !~ '^[0-9a-f]{64}$' then
    raise exception 'Invalid commission submission payload' using errcode = '22023';
  end if;

  v_lock_key := pg_catalog.hashtextextended(p_idempotency_key_hash, 0);
  perform pg_catalog.pg_advisory_xact_lock(v_lock_key);

  select * into v_key
    from public.commission_submit_keys
   where key_hash = p_idempotency_key_hash
   for update;

  if found then
    if v_key.request_hash <> p_request_hash then
      raise exception 'IDEMPOTENCY_KEY_CONFLICT' using errcode = 'P0001';
    end if;
    if v_key.deleted_at is not null then
      raise exception 'IDEMPOTENCY_KEY_RETIRED' using errcode = 'P0001';
    end if;
    select * into v_track
      from public.order_tracks
     where id = v_key.commission_id;
    if not found then
      raise exception 'IDEMPOTENCY_RESULT_MISSING' using errcode = 'P0001';
    end if;
    return jsonb_build_object('track', to_jsonb(v_track), 'duplicate', true);
  end if;

  v_id := public.next_commission_id();

  insert into public.commission_requests (
    id, created_at, "createdAt", status, payment,
    "serviceId", "serviceTitle", "tierName",
    form, estimate, notes, "finalPrice", "extraLines"
  ) values (
    v_id,
    coalesce(nullif(p_order->>'created_at', '')::timestamptz, now()),
    coalesce(p_order->>'createdAt', now()::text),
    'Pending Review',
    'Unpaid',
    p_order->>'serviceId',
    p_order->>'serviceTitle',
    coalesce(p_order->>'tierName', ''),
    p_order->'form',
    p_order->'estimate',
    '',
    null,
    ''
  );

  insert into public.order_tracks (
    id, created_at, "createdAt", "serviceTitle", status, payment,
    estimate, custom, "emailHash", client_name, proposal, updates, "finalFiles"
  ) values (
    v_id,
    coalesce(nullif(p_track->>'created_at', '')::timestamptz, now()),
    coalesce(p_track->>'createdAt', now()::text),
    p_order->>'serviceTitle',
    'Pending Review',
    'Unpaid',
    (p_order->'estimate'->>'total')::numeric,
    coalesce((p_order->'estimate'->>'custom')::boolean, false),
    p_track->>'emailHash',
    coalesce(nullif(p_track->>'client_name', ''), 'Client'),
    null,
    '[]'::jsonb,
    '[]'::jsonb
  )
  returning * into v_track;

  insert into public.commission_submit_keys (key_hash, request_hash, commission_id)
  values (p_idempotency_key_hash, p_request_hash, v_id);

  return jsonb_build_object('track', to_jsonb(v_track), 'duplicate', false);
end;
$$;

create or replace function public.delete_commission_atomic(p_commission_id text)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_deleted integer;
begin
  if coalesce(p_commission_id, '') !~ '^COMMISSION-[0-9]{4}-[0-9]{4,}$' then
    raise exception 'Invalid commission ID' using errcode = '22023';
  end if;

  -- Explicitly remove every related row inside this transaction.
  delete from public.client_reviews where commission_id = p_commission_id;
  delete from public.order_tracks where id = p_commission_id;
  delete from public.commission_management where id = p_commission_id;
  delete from public.notifications where order_id = p_commission_id;
  delete from public.commission_requests where id = p_commission_id;
  get diagnostics v_deleted = row_count;

  -- Retain a tombstone so a replayed idempotency key cannot recreate a deleted order.
  update public.commission_submit_keys
     set deleted_at = coalesce(deleted_at, now())
   where commission_id = p_commission_id;

  return v_deleted > 0;
end;
$$;

revoke all on function public.submit_commission_atomic(text, text, jsonb, jsonb) from public, anon, authenticated;
revoke all on function public.delete_commission_atomic(text) from public, anon, authenticated;
grant execute on function public.submit_commission_atomic(text, text, jsonb, jsonb) to service_role;
grant execute on function public.delete_commission_atomic(text) to service_role;

commit;

     or jsonb_typeof(p_order) is distinct from 'object'
     or jsonb_typeof(p_track) is distinct from 'object'
     or coalesce(p_order->>'serviceId', '') = ''
     or coalesce(p_order->>'serviceTitle', '') = ''
     or jsonb_typeof(p_order->'form') is distinct from 'object'
     or jsonb_typeof(p_order->'estimate') is distinct from 'object'
     or coalesce(p_track->>'emailHash', '') !~ '^[0-9a-f]{64}$' then
    raise exception 'Invalid commission submission payload' using errcode = '22023';
  end if;

  v_lock_key := pg_catalog.hashtextextended(p_idempotency_key_hash, 0);
  perform pg_catalog.pg_advisory_xact_lock(v_lock_key);

  select * into v_key
    from public.commission_submit_keys
   where key_hash = p_idempotency_key_hash
   for update;

  if found then
    if v_key.request_hash <> p_request_hash then
      raise exception 'IDEMPOTENCY_KEY_CONFLICT' using errcode = 'P0001';
    end if;
    if v_key.deleted_at is not null then
      raise exception 'IDEMPOTENCY_KEY_RETIRED' using errcode = 'P0001';
    end if;
    select * into v_track
      from public.order_tracks
     where id = v_key.commission_id;
    if not found then
      raise exception 'IDEMPOTENCY_RESULT_MISSING' using errcode = 'P0001';
    end if;
    return jsonb_build_object('track', to_jsonb(v_track), 'duplicate', true);
  end if;

  v_id := public.next_commission_id();

  insert into public.commission_requests (
    id, created_at, "createdAt", status, payment,
    "serviceId", "serviceTitle", "tierName",
    form, estimate, notes, "finalPrice", "extraLines"
  ) values (
    v_id,
    coalesce(nullif(p_order->>'created_at', '')::timestamptz, now()),
    coalesce(p_order->>'createdAt', now()::text),
    'Pending Review',
    'Unpaid',
    p_order->>'serviceId',
    p_order->>'serviceTitle',
    coalesce(p_order->>'tierName', ''),
    p_order->'form',
    p_order->'estimate',
    '',
    null,
    ''
  );

  insert into public.order_tracks (
    id, created_at, "createdAt", "serviceTitle", status, payment,
    estimate, custom, "emailHash", client_name, proposal, updates, "finalFiles"
  ) values (
    v_id,
    coalesce(nullif(p_track->>'created_at', '')::timestamptz, now()),
    coalesce(p_track->>'createdAt', now()::text),
    p_order->>'serviceTitle',
    'Pending Review',
    'Unpaid',
    (p_order->'estimate'->>'total')::numeric,
    coalesce((p_order->'estimate'->>'custom')::boolean, false),
    p_track->>'emailHash',
    coalesce(nullif(p_track->>'client_name', ''), 'Client'),
    null,
    '[]'::jsonb,
    '[]'::jsonb
  )
  returning * into v_track;

  insert into public.commission_submit_keys (key_hash, request_hash, commission_id)
  values (p_idempotency_key_hash, p_request_hash, v_id);

  return jsonb_build_object('track', to_jsonb(v_track), 'duplicate', false);
end;
$$;

create or replace function public.delete_commission_atomic(p_commission_id text)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_deleted integer;
begin
  if coalesce(p_commission_id, '') !~ '^COMMISSION-[0-9]{4}-[0-9]{4,}$' then
    raise exception 'Invalid commission ID' using errcode = '22023';
  end if;

  -- Explicitly remove every related row inside this transaction.
  delete from public.client_reviews where commission_id = p_commission_id;
  delete from public.order_tracks where id = p_commission_id;
  delete from public.commission_management where id = p_commission_id;
  delete from public.notifications where order_id = p_commission_id;
  delete from public.commission_requests where id = p_commission_id;
  get diagnostics v_deleted = row_count;

  -- Retain a tombstone so a replayed idempotency key cannot recreate a deleted order.
  update public.commission_submit_keys
     set deleted_at = coalesce(deleted_at, now())
   where commission_id = p_commission_id;

  return v_deleted > 0;
end;
$$;

revoke all on function public.submit_commission_atomic(text, text, jsonb, jsonb) from public, anon, authenticated;
revoke all on function public.delete_commission_atomic(text) from public, anon, authenticated;
grant execute on function public.submit_commission_atomic(text, text, jsonb, jsonb) to service_role;
grant execute on function public.delete_commission_atomic(text) to service_role;

commit;

-- Integration test for public.record_track_attempt().
-- Run only AFTER 202611200001_track_attempt_rate_limit.sql has been applied
-- to STAGING. All inserted test rows are rolled back at the end.
begin;

do $$
declare
  v_result jsonb;
  v_attempt integer;
begin
  for v_attempt in 1..5 loop
    v_result := public.record_track_attempt(
      repeat('a', 64),
      repeat('b', 64),
      'RATE-LIMIT-INTEGRATION-TEST'
    );
    if (v_result ->> 'allowed')::boolean is distinct from true then
      raise exception 'Attempt % should have been allowed; result=%', v_attempt, v_result;
    end if;
  end loop;

  v_result := public.record_track_attempt(
    repeat('a', 64),
    repeat('b', 64),
    'RATE-LIMIT-INTEGRATION-TEST'
  );
  if (v_result ->> 'allowed')::boolean is distinct from false then
    raise exception 'Attempt 6 should have been blocked; result=%', v_result;
  end if;

  raise notice 'PASS: attempts 1-5 allowed; attempt 6 blocked. Result=%', v_result;
end;
$$;

rollback;

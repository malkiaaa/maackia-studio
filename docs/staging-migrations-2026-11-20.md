# Staging hardening migrations — 20 Nov 2026

## Scope and safety

These migrations are prepared on `staging/backend-setup` only. They have **not** been applied to any Supabase project. Do not run them against production. They do not alter the payment provider, payment state machine, payment links, or checkout behavior.

The Edge Function now calls the RPCs introduced by these migrations. **Do not deploy the updated Edge Function to a Supabase project until both migrations have been applied to that same staging project.** Until then, tracking and commission submit/delete RPC calls will fail closed.

## Required order

1. Open the **Supabase staging project** (verify its project reference and URL in Project Settings → General).
2. Open **SQL Editor** and create a new query.
3. Copy and run the full contents of `supabase/migrations/202611200001_track_attempt_rate_limit.sql`.
4. Before the atomic-commission migration, check whether `public.client_reviews` exists. If it does not, run the existing `supabase/migrations/202611190001_client_reviews.sql` first (this is a prerequisite for the existing review workflow; it is not part of this new hardening migration).
5. Run `supabase/migrations/202611200002_atomic_commissions.sql`.
6. Confirm the following routines exist under Database → Functions:
   - `record_track_attempt(text, text, text)`
   - `mark_track_attempt_success(uuid)`
   - `cleanup_track_attempts()`
   - `submit_commission_atomic(text, text, jsonb, jsonb)`
   - `delete_commission_atomic(text)`
7. Run the SQL integration tests in the SQL Editor:
   - `tests/track_attempt_rate_limit.sql`
   - `tests/atomic_commission_rpc.sql`
   Each test is wrapped in a transaction and ends with `ROLLBACK`; it should print a `PASS` notice if all assertions succeed.
8. Only after migrations and SQL tests pass, deploy `supabase/functions/commission-api/index.ts` to the staging Edge Function named `commission-api`.
9. Test one valid commission submission, one tracking lookup, and Creator deletion in staging. Check Edge Function logs for RPC errors and verify the email hash matches the generated Request ID.

## Migration behavior

### 202611200001 — tracking rate limit

- Stores SHA-256 hashes of IP and email; it does not store either raw value in `track_attempts`.
- Serializes each IP/email/Request-ID key with a transaction-scoped advisory lock.
- Allows the first five attempts in the rolling 15-minute window; attempt six receives HTTP 429.
- Logs every attempt, including blocked attempts. An attempt is initially pessimistically marked failed; a successful ID/email match is then marked successful.
- Deletes records older than 30 days during lookups and exposes `cleanup_track_attempts()` for manual/scheduled cleanup.
- Public/anon/authenticated roles cannot execute the RPCs; only `service_role` can.

### 202611200002 — atomic commission operations

- `submit_commission_atomic` inserts `commission_requests`, `order_tracks`, and the idempotency record in one PostgreSQL transaction.
- If either commission or tracking insert fails, PostgreSQL rolls back the entire RPC call.
- A replay with the same key and same request hash returns the original tracking record; same key with a different request returns a conflict.
- Deletion removes reviews, tracking, management, notifications, and the commission row in one transaction. The idempotency key is retained as a tombstone so a replay cannot recreate a deleted commission.
- Existing payment fields are initialized to the same values as before (`Unpaid`); no payment action is initiated.

## Rollback

Rollback is manual and staging-only.

1. Revert/redeploy the Edge Function to the pre-RPC version first. Do not drop RPCs while the live Edge Function still calls them.
2. In the staging SQL Editor, run `supabase/migrations/202611200002_atomic_commissions.down.sql`.
3. Then run `supabase/migrations/202611200001_track_attempt_rate_limit.down.sql`.

The atomic-commission down script drops the idempotency table and therefore discards its replay/tombstone history. It leaves commission and payment records untouched. The rate-limit down script drops the added `email_hash` column and rate-limit routines/indexes; existing `track_attempts` rows are preserved.

## Not yet verified

No database migration, RPC, or SQL integration test has been executed because no staging database access was provided. The committed SQL tests are prepared for execution by the staging project owner. Do not mark database integration as PASS until the SQL Editor output and staging Edge Function logs are available.

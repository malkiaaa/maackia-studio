# Malkiaa Studio — Technical Audit & QA Report

**Date:** 2026-11-20  
**Audited branch:** `staging/backend-setup`  
**Pre-audit snapshot:** `backup/pre-audit-2026-11-20`  
**Audit baseline:** `dda36764742844d7d4935ab081f08fb55debb928`  
**Audited source commit:** `b53daa2b664cc97a749a2bda4376509d30c56889`  
**Deployment:** Preview `dpl_5U35qrCeT1KPT8SkJnHc4JasqG1x` — READY

## 1. Changes implemented

1. Fixed a Rules of Hooks violation in `PageBuilderBlocks`: its empty-state conditional return now occurs after all hooks.
2. Fixed Creator draft restoration. The app saves the full site object but previously restored only `builder`; it now merges the complete saved draft over published content after Creator authentication.
3. Preserved partial commission submission details. When `commission_requests` is saved but `order_tracks` initialization fails, the API error now retains `commissionId`; the client sees the ID and is explicitly told not to resubmit.
4. Added dependency-free Node regression tests in `tests/source-audit.test.mjs`.

No Supabase schema, migration, Edge Function, Apps Script, production alias, or production configuration was changed.

## 2. Targeted regression checks

The following nine checks were executed against source retrieved from the current staging branch:

| Check | Result | Scope |
|---|---|---|
| 1–4 character price multipliers: 100%, 180%, 260%, 340% | PASS | Executed `calc()` directly |
| Unrelated fixed add-on remains independent of character count | PASS | Executed `calc()` directly |
| Page Builder hook order | PASS | Source invariant |
| Full Creator draft restoration | PASS | Source invariant |
| Partial commission save retains Request ID | PASS | Source invariant |
| Public reviews are filtered to approved | PASS | Edge Function source |
| Review requires completed commission and unique commission ID | PASS | Edge Function + migration source |
| Creator moderation and commission deletion are owner-gated | PASS | Edge Function source |
| No hard-coded server-secret assignment in frontend | PASS | Static source scan |

The Node test file is committed for repeatable local execution with:

```bash
node --test tests/source-audit.test.mjs
```

## 3. Feature inventory and verification status

| Feature area | Status | Verification performed | Remaining limitation |
|---|---|---|---|
| Homepage / hero / About / Featured / Latest Works | BLOCKED | Source inspection; preview HTML returned HTTP 200 | No interactive browser session |
| Gallery / categories / search / lightbox | BLOCKED | Component and route inventory inspected | Click/navigation and image tests not run |
| Services / pricing / currency / terms / workflow / contact | PARTIAL | Source inspection; pricing function tests passed | UI and currency-switch tests not run |
| Commission form / validation / uploads | BLOCKED | Frontend and Edge Function contracts inspected | No live Supabase submission or storage upload |
| Character pricing | PASS (unit logic) | Exact 1–4 character scenarios and unrelated fixed add-on tested | Live persisted estimate not compared |
| Commission ID / database persistence | PARTIAL | ID generation and two-write flow inspected; partial-save UI fixed | Live DB write and recovery not exercised |
| Tracking / email verification | BLOCKED | Request ID + email hash verification inspected | No live record lookup or brute-force test |
| Proposal / payment / progress / completion | BLOCKED | Existing routes and API actions inspected | No authenticated Creator/client journey |
| Client review submission / moderation | PARTIAL | Eligibility, uniqueness, pending status, approved-only public query, and owner checks inspected | No live database/RLS test |
| Creator sign-in / sign-out / session restoration | BLOCKED | Auth and owner allow-list code inspected | No Creator credentials available |
| Dashboard content tabs / CMS / media | BLOCKED | Components and API references inventoried | No authenticated save/upload/publish test |
| Draft autosave / restoration / discard / publish | PARTIAL | Autosave and publish code inspected; full-draft restoration fixed | No live session persistence test |
| Notion-style Page Builder | PARTIAL | Block operations inspected; hook-order defect fixed | No drag/drop, slash menu, or preview browser test |
| Email notifications / retry / test email | BLOCKED | Edge Function and Apps Script source inspected | GAS secrets, MailApp permission, and inbox unavailable |
| Android / tablet / desktop responsive | BLOCKED | Responsive CSS and viewport breakpoints inspected | Actual 360–1440px browser matrix not run |
| Vercel deployment | PASS | Preview deployment READY; deployed HTML returned HTTP 200 | Does not prove client-side feature behavior |

## 4. Bug report

### BUG-01 — Page Builder hook-order violation
- **Original problem:** Conditional early return could skip hooks when the page had no blocks and Creator editing was off.
- **Root cause:** `useState` calls occurred after `if (!editing && !blocks.length) return null`.
- **Fix:** All hooks now execute before the early return.
- **File:** `index.html`
- **Verification:** Source-order regression check passed.

### BUG-02 — Draft restoration ignored non-builder edits
- **Original problem:** Autosave stored the full site object, but reload restored only `r.site.builder`.
- **Root cause:** Draft restoration merged only the builder property.
- **Fix:** Valid saved draft objects are now merged in full over the published site.
- **File:** `index.html`
- **Verification:** Full-draft restoration source check passed.

### BUG-03 — Partial commission save reported as total failure
- **Original problem:** A saved commission whose tracking row failed initialization was presented as not submitted, encouraging duplicate submissions.
- **Root cause:** `Store.api` discarded the error response payload, including `commissionId`.
- **Fix:** API errors retain status and payload; the form surfaces the saved Request ID and warns the client not to resubmit.
- **File:** `index.html`
- **Verification:** Error-payload and UI-message source checks passed. Live induced database failure was not tested.

## 5. Remaining risks and blocked verification

1. **No live Supabase verification:** database credentials and a safe isolated test project were not available. RLS policies, storage permissions, Edge Function secrets, real records, and rollback behavior remain unverified.
2. **Rate limiting:** `track_attempts` exists in the schema, but the inspected `commission-api` does not currently enforce a lookup-attempt limit. This leaves public ID/email verification exposed to repeated guessing. A safe server-side rate-limit implementation and deployment should be treated as a security task.
3. **Estimate integrity:** the public `submit` action accepts the client-provided `order.estimate`. Creator proposal/final pricing remains separate, but the stored estimate is not independently recalculated by the server. Server-side price validation against the published service configuration remains outstanding.
4. **Non-atomic commission creation:** request and tracking rows are inserted separately. If the second insert fails, the first is intentionally preserved. The UI now exposes the Request ID, but a transactional recovery path is still needed.
5. **Non-atomic deletion:** commission deletion removes tracking, management, and request rows in separate operations. A failure mid-sequence can leave partial state. No destructive database changes were attempted.
6. **Email delivery:** Apps Script source was inspected, but the deployed webhook, secret properties, MailApp quota, and actual inbox delivery could not be tested. A MailApp acceptance response is not proof of inbox delivery.
7. **Browser QA:** the preview was fetched successfully over HTTP, but an interactive browser session with the production React 18 runtime was unavailable in this environment. Therefore the full navigation, forms, modals, dashboard, builder, console, and eight-viewport Android matrix remain untested.
8. **Review migration state:** the existing `202611190001_client_reviews.sql` migration was inspected but not applied or verified against the live staging database.

## 6. Deployment and data safety

- A pre-audit backup branch was created.
- Changes were committed only to `staging/backend-setup`.
- The preview deployment is READY and responds with HTTP 200.
- The primary domain alias and production deployment were not changed.
- No production data, commission records, artwork, Storage objects, or Supabase settings were modified.
- No migration was executed.

## 7. Assessment

**Not certified production-ready.** The three identified frontend defects are fixed and nine targeted source-level regression checks pass. Production readiness remains blocked by the untested live Supabase/Edge Function/Google Apps Script paths, missing backend rate limiting, client-trusted estimate values, non-transactional multi-row operations, and the unperformed interactive browser/responsive QA matrix.

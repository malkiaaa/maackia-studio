# Client Reviews — Staging Setup

This feature adds verified client reviews to Malkiaa Studio.

## Behavior
- A client can submit one review per commission only after the order status is `Completed`.
- The client verifies the order using the existing Request ID + email flow in Track Your Order.
- Reviews contain a 1–5 star rating and a 10–1,200 character message.
- The client can choose anonymous display. Otherwise, the name entered on the commission order is displayed.
- New reviews are private with status `pending`.
- Only approved reviews appear in the public homepage carousel.
- The Creator Dashboard has a Client Reviews tab to approve, hide, or delete submissions.
- Review rows are not directly accessible to anon/authenticated roles; the Edge Function mediates access.

## Staging deployment order

1. In the **staging Supabase project only**, open SQL Editor and run the contents of:
   `supabase/migrations/202611190001_client_reviews.sql`
2. Deploy the latest `supabase/functions/commission-api/index.ts` to the existing `commission-api` Edge Function in staging.
3. Wait for the Vercel deployment from branch `staging/backend-setup`.
4. Test with a staging commission whose status is `Completed`.
5. Open Track Your Order, enter that Request ID and matching email, submit a review, and confirm it appears as Pending in Creator Dashboard → Client Reviews.
6. Approve the review and confirm it appears in the homepage carousel. Hovering pauses the slow scroll; reduced-motion preferences disable the animation.

## Important
- Do not run this migration against Production.
- Do not rerun the original `supabase/schema.sql`.
- Do not expose service-role keys or webhook secrets.
- The email notification system is not used by the review feature.

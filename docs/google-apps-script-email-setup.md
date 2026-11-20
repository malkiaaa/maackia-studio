# Malkiaa Studio — Google Apps Script email setup

This integration sends commission notifications from the studio Gmail account using
`MailApp.sendEmail()`. The Supabase Edge Function calls the Apps Script Web App;
the browser never receives the webhook URL or shared secret.

## 1. Create the Apps Script project

1. Sign in to Google as **mmaackia@gmail.com**.
2. Open [Google Apps Script](https://script.google.com/) and create a new project.
3. Replace the contents of `Code.gs` with the repository file
   `supabase/apps-script/Code.gs`.
4. Save the project.

## 2. Set the Script Property

In Apps Script, open **Project Settings → Script Properties → Add script property**:

| Property | Value |
| --- | --- |
| `GAS_WEBHOOK_SECRET` | A newly generated, random secret with at least 32 bytes of entropy |

Use a password manager or a local secure generator to create the value. Do not commit it,
paste it into the website, or send it in chat. The exact same value is added to Supabase
in the next section.

The script does not need Gmail passwords, OAuth client secrets, or a Gmail API key.
Google will ask the account owner to authorize MailApp when the Web App is deployed/run.

## 3. Deploy as a Web App

1. Click **Deploy → New deployment**.
2. Select type **Web app**.
3. Set **Execute as: Me** (mmaackia@gmail.com).
4. Set **Who has access: Anyone**. The endpoint must accept a server-to-server POST
   without an interactive Google login; the JSON-body shared secret is its application
   authentication.
5. Click **Deploy**, authorize the requested Google permissions, and copy the Web App
   URL ending in `/exec`.

Treat this URL as sensitive operational configuration. Do not put it in frontend code.

If you change the Apps Script code later, create a new version and update the deployment
to that version. The deployed Web App URL normally remains the same for an edited
existing deployment.

## 4. Add Supabase Edge Function secrets

In the Supabase project **ypvksdnyfmikghjprslk**:

1. Open **Edge Functions → Secrets**.
2. Add `GAS_WEBHOOK_URL` with the deployed Apps Script `/exec` URL.
3. Add `GAS_WEBHOOK_SECRET` with the exact same value as the Apps Script Script Property.
4. Keep both values out of GitHub, frontend environment variables, browser storage,
   and client-visible settings.

No SQL migration is required. Do not rerun `supabase/schema.sql` on the existing database.
The legacy `RESEND_API_KEY` can be removed from Supabase only after the Gmail integration
has passed the full staging test plan.

## 5. Notification behavior and duplicate protection

- A new commission is written to `commission_requests` and `order_tracks` first.
- The Edge Function then sends the studio notification to the configured
  `email_config.artistEmail`, falling back to **mmaackia@gmail.com** when blank.
- The client confirmation is always sent; there is no client-notification opt-out toggle in Creator settings.
- Proposal, progress, status, manual email, and finished-art delivery events send an email to both the client and the Creator.
- Finished-art images stay in the private `references` bucket. Tracking requests receive one-hour signed URLs only after the client supplies the matching Request ID and email; Creator preview links require an authenticated Creator session.
- The Edge Function reads `GAS_WEBHOOK_URL` and `GAS_WEBHOOK_SECRET` only from
  Supabase Edge Function secrets.
- The `notifications` table records recipient, status, attempt count, message, and
  successful send time. Failed notifications can be retried from Creator Dashboard.
- The Edge Function checks for an already-sent `order_id + kind` record. Apps Script
  also uses a deterministic idempotency key, `LockService`, and Script Properties.
  A repeated request after a confirmed send returns a duplicate-suppressed result.
- Apps Script retains successful idempotency keys for 180 days, then prunes expired keys.
  This is a practical duplicate guard, not a mathematical exactly-once guarantee: an
  abrupt platform failure between Gmail accepting a message and Apps Script persisting
  its key can still create an ambiguous outcome.

## 6. Staging test plan

Do not consider the migration complete until these tests pass on the staging deployment:

1. **Configuration check:** confirm both Supabase secrets exist and the Apps Script
   Script Property is set. Never share their values in screenshots.
2. **Quota/authorization:** run `checkMailQuota()` from the Apps Script editor and
   confirm Google authorization completes and a remaining quota is reported.
3. **Owner test email:** sign in to Creator Dashboard → Supabase → Email Notifications
   and click **Send Test Email**. Confirm the message arrives at the configured studio
   address (or the fallback mmaackia@gmail.com).
4. **New commission:** submit one controlled test request using an email address you
   can access. Confirm the commission appears in the Creator Dashboard and that the
   studio notification arrives. Confirm the client email arrives when
   `sendClient=true`.
5. **Lifecycle updates:** send a proposal, post a progress update, change status, and deliver Finished Art. Verify each event sends one email to the client and one to the Creator.
6. **Finished Art preview:** upload an image, confirm Creator preview is visible before sending, then deliver it. Verify the client tracking page can view/download the file using a signed URL.
7. **Notification history:** verify notification rows show `sent`, the expected recipient, an incremented attempt count, and a successful timestamp.
8. **Duplicate guard:** resend the same Apps Script payload with the same
   `idempotencyKey` using a controlled test request. It must report
   `duplicate: true` and must not send another email.
9. **Failure and retry:** temporarily use an invalid webhook URL in staging secrets,
   submit a controlled request, and verify the commission remains saved while its
   notification is marked `failed`. Restore the correct URL, then use **Retry failed**
   and confirm the same notification row becomes `sent`.
10. **Security:** confirm no secret appears in `index.html`, browser DevTools requests,
   or repository source. Do not disable RLS or expose the service-role key.

After testing, remove the legacy `RESEND_API_KEY` Supabase secret if no other function
uses it. Do not change Production or the `main` branch during staging validation.


## 7. Local development environment

The website calls the Supabase Edge Function directly. It does not send email from a Vercel API route, and private mail webhook credentials must never be placed in Vercel client-side variables or variables exposed with a `VITE_`/`NEXT_PUBLIC_` prefix.

For local Edge Function testing, create a local-only env file such as `supabase/.env.local` and pass it to the Supabase CLI with `supabase functions serve commission-api --env-file supabase/.env.local`:

```dotenv
SUPABASE_URL=https://<project-ref>.supabase.co
SUPABASE_SERVICE_ROLE_KEY=<local-project-service-role-key>
GAS_WEBHOOK_URL=https://script.google.com/macros/s/<deployment-id>/exec
GAS_WEBHOOK_SECRET=<same-random-secret-as-Apps-Script>
```

Keep that file out of Git. `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` are supplied by the Supabase Edge Function runtime in the hosted project; for local CLI execution, provide the local project values.

## 8. Hosting environment checklist

For each hosted Supabase environment, configure these under **Supabase → Edge Functions → Secrets**:

- `GAS_WEBHOOK_URL` — deployed Google Apps Script Web App URL ending in `/exec`.
- `GAS_WEBHOOK_SECRET` — same secret as the Apps Script Script Properties.

The hosted function runtime also requires `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY`; Supabase provides these automatically for deployed Edge Functions. Do not add the mail webhook URL or secret to Vercel. No Vercel email environment variables are used by this integration. The browser uses only the public Supabase project URL and publishable/anon key embedded in the site.

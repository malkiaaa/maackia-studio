// Malkiaa Studio commission API — staging
// Public actions: submit, public_board, track, respond, upload.
// Owner-only actions: test, retry. Owner access is verified against public.admins.
// Required Supabase secrets: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY.
// Required email secrets: GAS_WEBHOOK_URL and GAS_WEBHOOK_SECRET (server-side only).

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });

const sha256 = async (value: string) => {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
};

const clean = (v: unknown, max = 500) =>
  typeof v === "string" ? v.trim().slice(0, max) : "";

const escapeHtml = (value: unknown) => {
  const entities: Record<string, string> = {
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  };
  return clean(value, 2000).replace(/[&<>"']/g, (ch) => entities[ch] || ch);
};

const allowedTypes = new Set([
  "image/jpeg", "image/png", "image/webp", "image/gif", "application/pdf",
]);

type EmailConfig = {
  artistEmail?: string;
  fromName?: string;
  sendArtist?: boolean;
  sendClient?: boolean;
};

async function getEmailConfig(db: any): Promise<EmailConfig> {
  const { data } = await db.from("app_settings")
    .select("value").eq("key", "email_config").maybeSingle();
  return (data?.value || {}) as EmailConfig;
}

async function recordNotification(
  db: any,
  values: {
    order_id: string | null;
    kind: string;
    recipient: string;
    status: string;
    message: string;
    attempts: number;
    sent_at: string | null;
  },
  existingId?: string,
) {
  if (existingId) {
    const { error } = await db.from("notifications")
      .update(values).eq("id", existingId);
    if (error) console.error("notification log update failed", error);
    return existingId;
  }
  const { data, error } = await db.from("notifications")
    .insert(values).select("id").single();
  if (error) {
    console.error("notification log insert failed", error);
    return null;
  }
  return data?.id || null;
}

async function findSentNotification(db: any, orderId: string, kind: string) {
  const { data, error } = await db.from("notifications")
    .select("*")
    .eq("order_id", orderId)
    .eq("kind", kind)
    .eq("status", "sent")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) console.error("sent notification lookup failed", error);
  return data || null;
}

async function deliverEmail(
  db: any,
  config: EmailConfig,
  input: {
    to: string;
    subject: string;
    html: string;
    orderId: string | null;
    kind: string;
    existingId?: string;
    previousAttempts?: number;
    idempotencyKey?: string;
  },
) {
  const webhookUrl = Deno.env.get("GAS_WEBHOOK_URL");
  const webhookSecret = Deno.env.get("GAS_WEBHOOK_SECRET");
  const fromName = clean(config.fromName, 100) || "Malkiaa Studio";
  const recipient = clean(input.to, 254).toLowerCase();
  const attempts = (input.previousAttempts || 0) + 1;
  let status = "failed";
  let message = "";

  // The database log is the first duplicate guard. Apps Script also enforces
  // the same key under LockService, covering concurrent requests and log races.
  if (input.orderId && input.kind !== "test") {
    const alreadySent = await findSentNotification(db, input.orderId, input.kind);
    if (alreadySent) {
      return {
        id: alreadySent.id,
        status: "sent",
        message: "Already recorded as sent; duplicate delivery suppressed.",
        attempts: Number(alreadySent.attempts) || attempts,
        recipient,
        kind: input.kind,
        duplicate: true,
      };
    }
  }

  if (!webhookUrl || !webhookSecret) {
    message = "GAS_WEBHOOK_URL and GAS_WEBHOOK_SECRET must be configured in Supabase Edge Function secrets.";
  } else if (!recipient || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(recipient)) {
    message = "A valid notification recipient email is required.";
  } else {
    try {
      const idempotencyKey = clean(
        input.idempotencyKey || (input.orderId || "manual") + ":" + input.kind,
        180,
      );
      const response = await fetch(webhookUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          secret: webhookSecret,
          idempotencyKey,
          orderId: input.orderId,
          kind: input.kind,
          to: recipient,
          subject: clean(input.subject, 240),
          html: input.html,
          text: "Malkiaa Studio notification: " + clean(input.subject, 240),
          fromName,
        }),
      });
      const raw = await response.text();
      let result: any = {};
      try { result = JSON.parse(raw); } catch { /* handled as provider response error below */ }

      if (response.ok && result?.ok === true &&
          (result?.status === "sent" || result?.duplicate === true)) {
        status = "sent";
        message = result.duplicate
          ? "Google Apps Script confirmed this notification was already sent; duplicate suppressed."
          : "Accepted by Google Apps Script MailApp. Inbox delivery is not guaranteed.";
      } else {
        message = "Google Apps Script error" +
          (response.status ? " " + response.status : "") + ": " +
          clean(result?.message || result?.error || raw || "Webhook returned an invalid response.", 500);
      }
    } catch (error) {
      message = "Google Apps Script request failed: " + clean((error as Error)?.message, 500);
    }
  }

  const id = await recordNotification(db, {
    order_id: input.orderId,
    kind: input.kind,
    recipient,
    status,
    message,
    attempts,
    sent_at: status === "sent" ? new Date().toISOString() : null,
  }, input.existingId);

  return { id, status, message, attempts, recipient, kind: input.kind };
}

function commissionEmailHtml(order: any, clientName: string, isClient: boolean) {
  const id = escapeHtml(order.id);
  const name = escapeHtml(clientName || "Client");
  const service = escapeHtml(order.serviceTitle || "Commission");
  const tier = escapeHtml(order.tierName || "");
  const estimate = Number(order?.estimate?.total) || 0;
  const price = "IDR " + Math.round(estimate).toLocaleString("id-ID") +
    (order?.estimate?.custom ? " + custom quote" : "");
  const greeting = isClient
    ? "Thank you, " + name + ". Your commission request has been received and is waiting for review."
    : "A new commission request has been submitted.";
  const extra = isClient
    ? "<p>Keep this email. Use your Request ID and email address to track your order on the website. No payment has been taken; you will receive a proposal before payment is requested.</p>"
    : "<p>Open the Creator Dashboard to review the request and prepare a proposal.</p>";
  return "<!doctype html><html><body style='font-family:Arial,sans-serif;max-width:620px;margin:auto;padding:24px;color:#454B55'>" +
    "<h2>Malkiaa Studio</h2><p>" + greeting + "</p>" +
    "<table style='border-collapse:collapse;width:100%'>" +
    "<tr><td style='padding:8px;border-bottom:1px solid #ddd'>Request ID</td><td style='padding:8px;border-bottom:1px solid #ddd'><b>" + id + "</b></td></tr>" +
    "<tr><td style='padding:8px;border-bottom:1px solid #ddd'>Service</td><td style='padding:8px;border-bottom:1px solid #ddd'>" + service + " " + tier + "</td></tr>" +
    "<tr><td style='padding:8px;border-bottom:1px solid #ddd'>Estimate</td><td style='padding:8px;border-bottom:1px solid #ddd'>" + price + "</td></tr>" +
    "</table>" + extra + "</body></html>";
}

async function sendCommissionEmails(db: any, order: any, form: any) {
  const config = await getEmailConfig(db);
  const results: any[] = [];
  const clientName = clean(form?.name, 120) || "Client";
  const clientEmail = clean(form?.email, 254).toLowerCase();

  const artistEmail = clean(config.artistEmail, 254) || "mmaackia@gmail.com";

  if (config.sendArtist !== false) {
    results.push(await deliverEmail(db, config, {
      to: artistEmail,
      subject: "[Malkiaa Studio] New Commission Request " + order.id,
      html: commissionEmailHtml(order, clientName, false),
      orderId: order.id,
      kind: "artist",
    }));
  }
  if (config.sendClient !== false && clientEmail) {
    results.push(await deliverEmail(db, config, {
      to: clientEmail,
      subject: "[Malkiaa Studio] Commission Request Received — " + order.id,
      html: commissionEmailHtml(order, clientName, true),
      orderId: order.id,
      kind: "client",
    }));
  }
  return results;
}

async function requireOwner(
  req: Request,
  db: any,
): Promise<{ ok: true; user: any } | { ok: false; status: number; error: string }> {
  const authorization = req.headers.get("Authorization") || "";
  const token = authorization.replace(/^Bearer\s+/i, "").trim();
  if (!token) return { ok: false, status: 401, error: "Sign in as the Creator before using this action." };
  const { data, error } = await db.auth.getUser(token);
  if (error || !data?.user) {
    return { ok: false, status: 401, error: "Your Creator session is invalid or expired. Please sign in again." };
  }
  const { data: admin, error: adminError } = await db.from("admins")
    .select("user_id").eq("user_id", data.user.id).maybeSingle();
  if (adminError || !admin) {
    return { ok: false, status: 403, error: "This account is not authorized as the Malkiaa Studio Creator." };
  }
  return { ok: true, user: data.user };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Method not allowed." }, 405);

  const url = Deno.env.get("SUPABASE_URL");
  // Support both legacy service_role JWT and the current named secret API key.
  let serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!serviceKey) {
    try {
      const secretKeys = JSON.parse(Deno.env.get("SUPABASE_SECRET_KEYS") || "{}");
      serviceKey = secretKeys.default || "";
    } catch {
      serviceKey = "";
    }
  }
  if (!url || !serviceKey) {
    return json({ error: "Supabase server secret key is not available to this function." }, 503);
  }

  const db = createClient(url, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  try {
    const body = await req.json();
    const action = clean(body?.action, 40);

    if (action === "get_site") {
      const { data, error } = await db.from("app_settings")
        .select("value").eq("key", "site_content").maybeSingle();
      if (error) {
        console.error("published site content lookup failed", error);
        return json({ error: "Could not load the published website content." }, 500);
      }
      return json({ site: data?.value || null });
    }

    if (action === "submit") {
      const order = body?.order;
      const form = order?.form;
      const email = clean(form?.email, 254).toLowerCase();
      if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        return json({ error: "A valid client email is required." }, 400);
      }
      if (!order?.serviceTitle || !form || typeof form !== "object") {
        return json({ error: "Incomplete commission request." }, 400);
      }

      const { data: generatedId, error: idError } = await db.rpc("next_commission_id");
      if (idError || !generatedId) {
        console.error("commission ID generation failed", idError);
        return json({ error: "Could not generate a commission number. Please try again." }, 500);
      }
      const id = clean(generatedId, 40);
      if (!/^COMMISSION-[0-9]{4}-[0-9]{4,}$/.test(id)) {
        return json({ error: "Invalid generated commission number." }, 500);
      }

      const emailHash = await sha256(email + "|" + id);
      const safeOrder = {
        id,
        created_at: new Date().toISOString(),
        createdAt: clean(order.createdAt, 50) || new Date().toISOString(),
        status: "Pending Review",
        payment: "Unpaid",
        serviceId: clean(order.serviceId, 100),
        serviceTitle: clean(order.serviceTitle, 180),
        tierName: clean(order.tierName, 120),
        form,
        estimate: order.estimate && typeof order.estimate === "object" ? order.estimate : {},
        notes: "",
        finalPrice: null,
        extraLines: "",
      };
      const safeTrack = {
        id,
        created_at: new Date().toISOString(),
        createdAt: clean(order.createdAt, 50) || new Date().toISOString(),
        serviceTitle: safeOrder.serviceTitle,
        status: "Pending Review",
        payment: "Unpaid",
        estimate: Number(order?.estimate?.total) || 0,
        custom: Boolean(order?.estimate?.custom),
        emailHash,
        client_name: clean(form?.name, 120) || "Client",
        proposal: null,
        updates: [],
        finalFiles: [],
      };

      const { error: orderError } = await db.from("commission_requests").insert(safeOrder);
      if (orderError) {
        if (orderError.code === "23505") return json({ error: "Request ID collision. Please submit again." }, 409);
        console.error("commission insert failed", orderError);
        return json({ error: "Could not save this commission request." }, 500);
      }
      const { error: trackError } = await db.from("order_tracks").insert(safeTrack);
      if (trackError) {
        // Preserve the saved commission. Never delete a valid request as rollback
        // for a secondary tracking-row failure; log it for owner-side recovery.
        console.error("tracking insert failed; commission request was preserved", { id, error: trackError });
        return json({
          error: "The commission was saved, but order tracking could not be initialized. Please contact the studio and do not submit the form again.",
          commissionId: id,
        }, 503);
      }

      // Email failure never rolls back a saved commission.
      const notifications = await sendCommissionEmails(db, safeOrder, form)
        .catch((error) => {
          console.error("commission notification failed", error);
          return [];
        });
      return json({ track: safeTrack, notifications }, 201);
    }

    if (action === "public_board") {
      const { data, error } = await db.from("order_tracks")
        .select("id,created_at,client_name,serviceTitle,status")
        .order("created_at", { ascending: false })
        .limit(100);
      if (error) {
        console.error("public commission board query failed", error);
        return json({ error: "Could not load the public commission board." }, 500);
      }
      const items = (data || []).map((item: any) => ({
        id: item.id,
        createdAt: item.created_at,
        clientName: item.client_name,
        serviceTitle: item.serviceTitle,
        status: item.status,
      }));
      return json({ items });
    }

    if (action === "track") {
      const id = clean(body?.id, 40).toUpperCase();
      const email = clean(body?.email, 254).toLowerCase();
      if (!id || !email) return json({ error: "No order matches that Request ID and email." }, 404);
      const { data: track } = await db.from("order_tracks")
        .select("*").eq("id", id).maybeSingle();
      const suppliedHash = await sha256(email + "|" + id);
      if (!track || track.emailHash !== suppliedHash) {
        return json({ error: "No order matches that Request ID and email." }, 404);
      }
      const { emailHash: _privateHash, ...publicTrack } = track;
      return json({ track: publicTrack });
    }

    if (action === "respond") {
      const id = clean(body?.id, 40).toUpperCase();
      const email = clean(body?.email, 254).toLowerCase();
      const response = clean(body?.response, 20);
      const note = clean(body?.text, 1000);
      if (!id || !email || !["Accepted", "Declined"].includes(response)) {
        return json({ error: "Invalid proposal response." }, 400);
      }
      const { data: track } = await db.from("order_tracks")
        .select("*").eq("id", id).maybeSingle();
      const suppliedHash = await sha256(email + "|" + id);
      if (!track || track.emailHash !== suppliedHash) {
        return json({ error: "No order matches that Request ID and email." }, 404);
      }
      if (!track.proposal) return json({ error: "A proposal is not available for this order yet." }, 409);

      const proposal = { ...(track.proposal || {}), response };
      const updates = Array.isArray(track.updates) ? track.updates : [];
      updates.push({
        at: new Date().toISOString(),
        from: "client",
        text: note || "Client: " + response,
      });
      const status = response === "Accepted" ? "Awaiting Payment" : "Cancelled";
      const { data: updated, error } = await db.from("order_tracks")
        .update({ proposal, updates, status }).eq("id", id).select("*").single();
      if (error) {
        console.error("client response update failed", error);
        return json({ error: "Could not save your response." }, 500);
      }
      await db.from("commission_requests").update({ status }).eq("id", id);
      const { emailHash: _privateHash, ...publicTrack } = updated;
      return json({ track: publicTrack });
    }

    if (action === "upload") {
      const type = clean(body?.type, 100);
      const size = Number(body?.size);
      if (!allowedTypes.has(type)) return json({ error: "Unsupported reference file type." }, 400);
      if (!Number.isFinite(size) || size <= 0 || size > 10 * 1024 * 1024) {
        return json({ error: "Reference files must be 10 MB or smaller." }, 400);
      }
      const path = "incoming/" + crypto.randomUUID();
      const { data, error } = await db.storage.from("references").createSignedUploadUrl(path);
      if (error || !data) {
        console.error("signed upload URL failed", error);
        return json({ error: "Could not prepare reference upload." }, 500);
      }
      return json({ path, token: data.token });
    }

    if (action === "save_site") {
      const owner = await requireOwner(req, db);
      if (!owner.ok) return json({ error: owner.error }, owner.status);
      const site = body?.site;
      if (!site || typeof site !== "object" || Array.isArray(site)) {
        return json({ error: "Website content is invalid." }, 400);
      }
      const serialized = JSON.stringify(site);
      if (serialized.length > 4_000_000) {
        return json({ error: "Website content is too large to save. Please reduce or replace large embedded images." }, 413);
      }
      const { error } = await db.from("app_settings").upsert({
        key: "site_content",
        value: site,
        updated_at: new Date().toISOString(),
      }, { onConflict: "key" });
      if (error) {
        console.error("published site content save failed", error);
        return json({ error: "Could not save website content." }, 500);
      }
      return json({ ok: true });
    }

    if (action === "test") {
      const owner = await requireOwner(req, db);
      if (!owner.ok) return json({ error: owner.error }, owner.status);
      const config = await getEmailConfig(db);
      const recipient = clean(config.artistEmail, 254) || "mmaackia@gmail.com";
      const result = await deliverEmail(db, config, {
        to: recipient,
        subject: "[Malkiaa Studio] Test notification",
        html: "<p>This is a test email from Malkiaa Studio. If you received it, Google Apps Script MailApp is working.</p>",
        orderId: "TEST",
        kind: "test",
        idempotencyKey: "TEST:" + crypto.randomUUID(),
      });
      return json({ status: result.status, message: result.message, attempts: result.attempts });
    }

    if (action === "retry") {
      const owner = await requireOwner(req, db);
      if (!owner.ok) return json({ error: owner.error }, owner.status);
      const id = clean(body?.id, 80);
      if (!id) return json({ error: "A commission ID is required." }, 400);
      const { data: failed, error: failedError } = await db.from("notifications")
        .select("*").eq("order_id", id).eq("status", "failed");
      if (failedError) {
        console.error("failed notification lookup failed", failedError);
        return json({ error: "Could not load failed notifications." }, 500);
      }
      const { data: order, error: orderError } = await db.from("commission_requests")
        .select("*").eq("id", id).maybeSingle();
      if (orderError || !order) return json({ error: "Commission request was not found." }, 404);
      const results = [];
      const config = await getEmailConfig(db);
      for (const item of failed || []) {
        const isClient = item.kind === "client";
        const html = commissionEmailHtml(order, clean(order.form?.name, 120), isClient);
        results.push(await deliverEmail(db, config, {
          to: clean(item.recipient, 254),
          subject: isClient
            ? "[Malkiaa Studio] Commission Request Received — " + id
            : "[Malkiaa Studio] New Commission Request " + id,
          html,
          orderId: id,
          kind: item.kind,
          existingId: item.id,
          previousAttempts: Number(item.attempts) || 0,
        }));
      }
      return json({ notifications: results });
    }

    return json({ error: "Unknown API action." }, 400);
  } catch (error) {
    console.error("commission-api error", error);
    return json({ error: "Unexpected server error." }, 500);
  }
});

// Malkiaa Studio commission API — staging
// Public actions: submit, public_board, track, respond, upload, submit_review, public_reviews, get_site.
// Owner-only actions: save_site, get_draft_site, save_draft_site, test, retry, reviews_admin_list, reviews_admin_update, reviews_admin_delete.
// Owner-only actions: test, retry, reviews_admin_list, reviews_admin_update, reviews_admin_delete.
// Owner access is verified against public.admins.
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


const DEFAULT_SERVER_TIERS = [
  { id: "t1", name: "Headshot / Icon", price: 150000 },
  { id: "t2", name: "Bust Up", price: 200000 },
  { id: "t3", name: "Half Body", price: 250000 },
  { id: "t4", name: "Full Body", price: 0 },
];
const DEFAULT_SERVER_ADDONS = [
  { id: "ad1", name: "Rendered Background", type: "fixed", price: 100000, select: "single" },
  { id: "ad2", name: "Additional Character", type: "percent", price: 80, select: "multiple" },
  { id: "ad3", name: "Additional Details", type: "fixed", price: 30000, select: "multiple" },
  { id: "ad4", name: "Animation", type: "custom", price: 0, select: "single" },
];

function calculateServerEstimate(site, order) {
  const form = order?.form;
  if (!site || !Array.isArray(site.services) || !form || typeof form !== "object" || Array.isArray(form)) {
    return { ok: false, error: "Commission pricing configuration is unavailable or invalid." };
  }
  const service = site.services.find((item) => item?.id === order?.serviceId);
  if (!service) return { ok: false, error: "Unknown commission service." };
  const tiers = Array.isArray(service.tiers) ? service.tiers : DEFAULT_SERVER_TIERS;
  const addons = Array.isArray(service.addons) ? service.addons : DEFAULT_SERVER_ADDONS;
  const licenses = Array.isArray(site.licenses) ? site.licenses : [];
  const validPrice = (value) => Number.isFinite(Number(value)) && Number(value) >= 0;
  if (tiers.some((item) => !item?.id || !validPrice(item.price)) ||
      addons.some((item) => !item?.id || !validPrice(item.price) ||
        !["fixed", "percent", "custom"].includes(item.type)) ||
      licenses.some((item) => !item?.id || !validPrice(item.value) ||
        !["fixed", "percent", "custom"].includes(item.type))) {
    return { ok: false, error: "Invalid server pricing configuration." };
  }
  const tier = tiers.find((item) => item?.id === form.tier);
  if (!tier) return { ok: false, error: "Unknown commission tier." };
  const base = Number(tier.price);

  const rawChars = form.chars === undefined || form.chars === null || form.chars === "" ? 1 : Number(form.chars);
  if (!Number.isInteger(rawChars) || rawChars < 1 || rawChars > 4) {
    return { ok: false, error: "Character count must be between 1 and 4." };
  }
  const selectedAddons = form.addons === undefined ? {} : form.addons;
  if (!selectedAddons || typeof selectedAddons !== "object" || Array.isArray(selectedAddons)) {
    return { ok: false, error: "Invalid add-on selection." };
  }
  const knownAddonIds = new Set(addons.map((item) => item?.id));
  for (const [id, quantityValue] of Object.entries(selectedAddons)) {
    if (!knownAddonIds.has(id)) return { ok: false, error: "Unknown add-on." };
    const addon = addons.find((item) => item?.id === id);
    if (/additional character/i.test(String(addon?.name || ""))) {
      if (Number(quantityValue) !== 0 && Number(quantityValue) !== 1) return { ok: false, error: "Character add-on is controlled by character count." };
      continue;
    }
    const quantity = Number(quantityValue);
    const max = addon?.select === "single" ? 1 : 10;
    if (!Number.isInteger(quantity) || quantity < 0 || quantity > max) {
      return { ok: false, error: "Invalid add-on quantity." };
    }
  }

  const lines = [];
  let custom = false;
  if (base > 0) lines.push([String(tier.name || "Commission"), base, ""]);
  else { custom = true; lines.push([String(tier.name || "Commission"), 0, "Custom quote"]); }
  let subtotal = base;
  const extraCharacters = rawChars - 1;
  if (extraCharacters > 0) {
    const amount = base * 0.8 * extraCharacters;
    subtotal += amount;
    lines.push(["Additional Character × " + extraCharacters + " (80% each)", amount, ""]);
  }

  for (const addon of addons) {
    if (!addon?.id || /additional character/i.test(String(addon.name || ""))) continue;
    const quantity = Number(selectedAddons[addon.id] || 0);
    if (!quantity) continue;
    const price = Number(addon.price);
    if (!Number.isFinite(price) || price < 0) return { ok: false, error: "Invalid server pricing configuration." };
    const label = String(addon.name || addon.id) + (quantity > 1 ? " x" + quantity : "");
    if (addon.type === "custom") {
      custom = true;
      lines.push([label, 0, "Custom quote"]);
      continue;
    }
    if (addon.type !== "fixed" && addon.type !== "percent") return { ok: false, error: "Invalid server pricing configuration." };
    const amount = addon.type === "percent" ? base * price / 100 * quantity : price * quantity;
    subtotal += amount;
    lines.push([label, amount, ""]);
  }

  const licenseId = form.license || "personal";
  const license = licenses.find((item) => item?.id === licenseId);
  if (!license) return { ok: false, error: "Unknown license selection." };
  const licenseValue = Number(license.value);
  if (!Number.isFinite(licenseValue) || licenseValue < 0) return { ok: false, error: "Invalid server pricing configuration." };
  let licenseAmount = 0;
  let licenseCustom = false;
  if (license.type === "custom") licenseCustom = true;
  else if (license.type === "percent") licenseAmount = subtotal * licenseValue / 100;
  else if (license.type === "fixed") licenseAmount = licenseValue;
  else return { ok: false, error: "Invalid server pricing configuration." };

  const estimate = {
    lines,
    licenseLabel: String(license.label || ""),
    licenseAmount,
    licenseCustom,
    total: subtotal + licenseAmount,
    custom: custom || licenseCustom,
  };
  if (!Number.isFinite(estimate.total) || estimate.total < 0) {
    return { ok: false, error: "Invalid calculated commission price." };
  }
  return {
    ok: true,
    estimate,
    serviceTitle: String(service.title || ""),
    tierName: String(tier.name || ""),
    clientEstimateMismatch: Number(order?.estimate?.total) !== estimate.total,
  };
}

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
      const contentType = response.headers.get("content-type") || "";
      let finalHost = "unknown";
      try { finalHost = new URL(response.url).host; } catch { /* keep sanitized default */ }
      let result: any = {};
      try { result = JSON.parse(raw); } catch { /* handled as provider response error below */ }

      if (!result || typeof result !== "object" || Array.isArray(result) || !contentType.toLowerCase().includes("application/json")) {
        console.error("Google Apps Script returned a non-JSON response", {
          status: response.status,
          redirected: response.redirected,
          finalHost,
          contentType,
          preview: clean(raw.replace(/\\s+/g, " "), 180),
        });
      }

      if (response.ok && result?.ok === true &&
          (result?.status === "sent" || result?.duplicate === true)) {
        status = "sent";
        message = result.duplicate
          ? "Google Apps Script confirmed this notification was already sent; duplicate suppressed."
          : "Accepted by Google Apps Script MailApp. Inbox delivery is not guaranteed.";
      } else {
        message = "Google Apps Script error" +
          (response.status ? " " + response.status : "") + ": " +
          clean(result?.message || result?.error ||
            (!contentType.toLowerCase().includes("application/json")
              ? "Google returned HTML instead of the expected JSON response. Check commission-api logs for redirect and response details."
              : raw) ||
            "Webhook returned an invalid response.", 500);
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

    if (action === "get_draft_site") {
      const owner = await requireOwner(req, db);
      if (!owner.ok) return json({ error: owner.error }, owner.status);
      const { data, error } = await db.from("app_settings")
        .select("value").eq("key", "site_draft").maybeSingle();
      if (error) return json({ error: "Could not load the website draft." }, 500);
      return json({ site: data?.value || null });
    }

    if (action === "save_draft_site") {
      const owner = await requireOwner(req, db);
      if (!owner.ok) return json({ error: owner.error }, owner.status);
      const site = body?.site;
      if (!site || typeof site !== "object" || Array.isArray(site)) return json({ error: "Website draft is invalid." }, 400);
      if (JSON.stringify(site).length > 4_000_000) return json({ error: "Website draft is too large." }, 413);
      const { error } = await db.from("app_settings").upsert({
        key: "site_draft", value: site, updated_at: new Date().toISOString(),
      }, { onConflict: "key" });
      if (error) {
        console.error("website draft save failed", error);
        return json({ error: "Could not save website draft." }, 500);
      }
      return json({ ok: true });
    }

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
      if (!email || !/^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$/.test(email)) {
        return json({ error: "A valid client email is required." }, 400);
      }
      if (!order?.serviceId || !form || typeof form !== "object" || Array.isArray(form)) {
        return json({ error: "Incomplete commission request." }, 400);
      }

      const { data: siteRow, error: siteError } = await db.from("app_settings")
        .select("value").eq("key", "site_content").maybeSingle();
      if (siteError || !siteRow?.value) {
        console.error("server pricing configuration lookup failed", siteError);
        return json({ error: "Commission pricing is temporarily unavailable. Please contact the studio." }, 503);
      }
      const pricing = calculateServerEstimate(siteRow.value, order);
      if (!pricing.ok) return json({ error: pricing.error }, 400);
      if (pricing.clientEstimateMismatch) {
        console.warn("client estimate differed from server calculation; server estimate applied", {
          serviceId: order.serviceId,
          submittedEstimate: Number(order?.estimate?.total),
          serverEstimate: pricing.estimate.total,
        });
      }


      const idempotencyKey = clean(body?.idempotencyKey, 180);
      if (!/^[A-Za-z0-9._:-]{16,180}$/.test(idempotencyKey)) {
        return json({ error: "A valid submission idempotency key is required. Please refresh the form and try again." }, 400);
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

      const safeForm = { ...form, email };
      const safeOrder = {
        id,
        created_at: new Date().toISOString(),
        createdAt: clean(order.createdAt, 50) || new Date().toISOString(),
        status: "Pending Review",
        payment: "Unpaid",
        serviceId: clean(order.serviceId, 100),
        serviceTitle: pricing.serviceTitle,
        tierName: pricing.tierName,
        form: safeForm,
        estimate: pricing.estimate,
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
        estimate: pricing.estimate.total,
        custom: pricing.estimate.custom,
        emailHash: await sha256(email + "|" + id),
        client_name: clean(form?.name, 120) || "Client",
        proposal: null,
        updates: [],
        finalFiles: [],
      };
      const idempotencyHash = await sha256("commission-submit|" + idempotencyKey);
      const requestHash = await sha256(JSON.stringify({
        serviceId: safeOrder.serviceId,
        serviceTitle: safeOrder.serviceTitle,
        tierName: safeOrder.tierName,
        form: safeOrder.form,
        estimate: safeOrder.estimate,
      }));
      const { data: submission, error: submitError } = await db.rpc("submit_commission_atomic", {
        p_idempotency_key_hash: idempotencyHash,
        p_request_hash: requestHash,
        p_order: safeOrder,
        p_track: safeTrack,
      });
      if (submitError || !submission?.track?.id) {
        const message = String(submitError?.message || "");
        if (message.includes("IDEMPOTENCY_KEY_CONFLICT") || message.includes("IDEMPOTENCY_KEY_RETIRED")) {
          return json({ error: "This submission key was already used. Please refresh the form before submitting a different request." }, 409);
        }
        console.error("atomic commission submission failed", submitError);
        return json({ error: "Could not save this commission request. Please try again." }, 500);
      }

      const savedTrack = submission.track;
      const savedOrder = { ...safeOrder, id: savedTrack.id };
      const notifications = submission.duplicate === true ? [] : await sendCommissionEmails(db, savedOrder, safeForm)
        .catch((error) => {
          console.error("commission notification failed", error);
          return [];
        });
      return json({ track: savedTrack, notifications, duplicate: submission.duplicate === true }, submission.duplicate === true ? 200 : 201);
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
      const forwardedFor = req.headers.get("x-forwarded-for") || "";
      const ipAddress = clean(
        req.headers.get("cf-connecting-ip") ||
        req.headers.get("x-real-ip") ||
        forwardedFor.split(",")[0] ||
        "unknown",
        100,
      );
      const ipHash = await sha256("track-ip|" + ipAddress);
      const rateEmailHash = await sha256("track-email|" + email);
      const { data: rateResult, error: rateError } = await db.rpc("record_track_attempt", {
        p_ip_hash: ipHash,
        p_email_hash: rateEmailHash,
        p_request_id: id,
      });
      if (rateError || !rateResult) {
        console.error("tracking rate-limit check failed", rateError);
        return json({ error: "No order matches that Request ID and email." }, 503);
      }
      if (rateResult.allowed !== true) {
        return json({ error: "No order matches that Request ID and email." }, 429);
      }

      if (!id || !email) return json({ error: "No order matches that Request ID and email." }, 404);
      const { data: track } = await db.from("order_tracks")
        .select("*").eq("id", id).maybeSingle();
      const suppliedHash = await sha256(email + "|" + id);
      if (!track || track.emailHash !== suppliedHash) {
        return json({ error: "No order matches that Request ID and email." }, 404);
      }

      const { error: markError } = await db.rpc("mark_track_attempt_success", {
        p_attempt_id: rateResult.attempt_id,
      });
      if (markError) {
        // Fail closed for subsequent attempts: this lookup remains counted as
        // failed rather than silently weakening the rate limit.
        console.error("could not mark tracking attempt successful", markError);
      }

      const { emailHash: _privateHash, ...publicTrack } = track;
      const { data: existingReview } = await db.from("client_reviews")
        .select("id").eq("commission_id", id).maybeSingle();
      return json({ track: publicTrack, reviewSubmitted: Boolean(existingReview) });
    }

    if (action === "submit_review") {
      const id = clean(body?.id, 40).toUpperCase();
      const email = clean(body?.email, 254).toLowerCase();
      const rating = Number(body?.rating);
      const message = clean(body?.message, 1200);
      const isAnonymous = body?.isAnonymous === true;
      if (!id || !email || !Number.isInteger(rating) || rating < 1 || rating > 5 ||
          message.length < 10) {
        return json({ error: "Please provide a valid rating and a review of at least 10 characters." }, 400);
      }

      const { data: track } = await db.from("order_tracks")
        .select("id,status,emailHash,client_name").eq("id", id).maybeSingle();
      const suppliedHash = await sha256(email + "|" + id);
      if (!track || track.emailHash !== suppliedHash) {
        return json({ error: "No order matches that Request ID and email." }, 404);
      }
      if (track.status !== "Completed") {
        return json({ error: "Reviews can only be submitted after a commission is completed." }, 409);
      }

      const { data: existingReview } = await db.from("client_reviews")
        .select("id").eq("commission_id", id).maybeSingle();
      if (existingReview) {
        return json({ error: "A review has already been submitted for this commission." }, 409);
      }

      const { data: review, error } = await db.from("client_reviews").insert({
        commission_id: id,
        rating,
        message,
        display_name: isAnonymous ? "Anonymous" : (clean(track.client_name, 120) || "Client"),
        is_anonymous: isAnonymous,
        status: "pending",
      }).select("id,status").single();
      if (error) {
        if (error.code === "23505") {
          return json({ error: "A review has already been submitted for this commission." }, 409);
        }
        console.error("client review submission failed", error);
        return json({ error: "Could not submit your review. Please try again." }, 500);
      }
      return json({ ok: true, status: review.status, message: "Thank you. Your review has been sent for approval." }, 201);
    }

    if (action === "public_reviews") {
      const { data, error } = await db.from("client_reviews")
        .select("id,rating,message,display_name,is_anonymous,created_at")
        .eq("status", "approved")
        .order("created_at", { ascending: false })
        .limit(30);
      if (error) {
        console.error("public reviews lookup failed", error);
        return json({ error: "Could not load client reviews." }, 500);
      }
      return json({ reviews: data || [] });
    }

    if (action === "reviews_admin_list") {
      const owner = await requireOwner(req, db);
      if (!owner.ok) return json({ error: owner.error }, owner.status);
      const { data, error } = await db.from("client_reviews")
        .select("*").order("created_at", { ascending: false }).limit(200);
      if (error) {
        console.error("creator reviews lookup failed", error);
        return json({ error: "Could not load client reviews." }, 500);
      }
      return json({ reviews: data || [] });
    }

    if (action === "reviews_admin_update") {
      const owner = await requireOwner(req, db);
      if (!owner.ok) return json({ error: owner.error }, owner.status);
      const id = clean(body?.id, 80);
      const status = clean(body?.status, 20);
      if (!id || !["approved", "hidden"].includes(status)) {
        return json({ error: "Invalid review moderation request." }, 400);
      }
      const { error } = await db.from("client_reviews")
        .update({ status, moderated_at: new Date().toISOString() }).eq("id", id);
      if (error) {
        console.error("review moderation failed", error);
        return json({ error: "Could not update this review." }, 500);
      }
      return json({ ok: true });
    }

    if (action === "reviews_admin_delete") {
      const owner = await requireOwner(req, db);
      if (!owner.ok) return json({ error: owner.error }, owner.status);
      const id = clean(body?.id, 80);
      if (!id) return json({ error: "A review ID is required." }, 400);
      const { error } = await db.from("client_reviews").delete().eq("id", id);
      if (error) {
        console.error("review deletion failed", error);
        return json({ error: "Could not delete this review." }, 500);
      }
      return json({ ok: true });
    }


    if (action === "delete_commission") {
      const owner = await requireOwner(req, db);
      if (!owner.ok) return json({ error: owner.error }, owner.status);
      const id = clean(body?.id, 40).toUpperCase();
      if (!/^COMMISSION-[0-9]{4}-[0-9]{4,}$/.test(id)) return json({ error: "Invalid commission ID." }, 400);
      const { data: deleted, error } = await db.rpc("delete_commission_atomic", {
        p_commission_id: id,
      });
      if (error) {
        console.error("atomic commission deletion failed", error);
        return json({ error: "Could not delete this commission." }, 500);
      }
      if (deleted !== true) return json({ error: "Commission request was not found." }, 404);
      return json({ ok: true, id });
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
      // Once a draft is published, remove the old private draft so it cannot
      // overwrite the newly published version when the owner opens the editor.
      const { error: draftError } = await db.from("app_settings").delete().eq("key", "site_draft");
      if (draftError) console.error("published draft cleanup failed", draftError);
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

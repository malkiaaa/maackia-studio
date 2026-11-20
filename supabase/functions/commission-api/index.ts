// Malkiaa Studio commission API — staging
// Public actions: submit, public_board, track, respond, upload, submit_review, public_reviews, get_site.
// Owner-only actions: portfolio_upload, save_site, get_draft_site, save_draft_site, test, retry, reviews_admin_list, reviews_admin_update, reviews_admin_delete.
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
  fromName?: string;
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
  if (!Number.isInteger(rawChars) || rawChars < 1 || rawChars > 20) {
    return { ok: false, error: "Character count must be between 1 and 20." };
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

  for (const addon of addons) {
    if (addon.required && !(Number(selectedAddons[addon.id]) > 0)) {
      return { ok: false, error: "A required add-on is missing." };
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
    text: string;
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
          text: clean(input.text, 20000),
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

function commissionEmailText(order: any, clientName: string) {
  const estimate = Number(order?.estimate?.total) || 0;
  const price = "IDR " + Math.round(estimate).toLocaleString("id-ID") +
    (order?.estimate?.custom ? " + custom quote" : "");
  return [
    "Malkiaa Studio",
    "",
    "Hello " + (clean(clientName, 120) || "there") + ",",
    "Thank you for contacting Malkiaa Studio. Your commission request has been received.",
    "",
    "Request details",
    "Request ID: " + clean(order.id, 40),
    "Service: " + clean(order.serviceTitle, 160),
    "Option: " + clean(order.tierName, 120),
    "Current estimate: " + price,
    "",
    "No payment has been taken. We will review your request and contact you with the next steps before payment is due.",
    "Please keep this message for your records. You can reply directly to this email if you have a question.",
    "",
    "Malkiaa Studio",
    "Commission support · mmaackia@gmail.com"
  ].filter((line) => line !== undefined).join("\n");
}

function commissionEmailHtml(order: any, clientName: string) {
  const id = escapeHtml(order.id);
  const name = escapeHtml(clientName || "Client");
  const service = escapeHtml(order.serviceTitle || "Commission");
  const tier = escapeHtml(order.tierName || "");
  const estimate = Number(order?.estimate?.total) || 0;
  const price = "IDR " + Math.round(estimate).toLocaleString("id-ID") +
    (order?.estimate?.custom ? " + custom quote" : "");
  const greeting = "Thank you, " + name + ". We have received your commission request.";
  const extra = "<p>No payment has been taken. We will review your request and contact you with the next steps before payment is due.</p><p>Please keep this message for your records. If you have a question, you can reply directly to this email.</p>";
  return "<!doctype html><html><body style='margin:0;padding:24px;background:#ffffff;color:#303943;font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.6'>" +
    "<div style='max-width:600px;margin:0 auto'>" +
    "<p style='margin:0 0 20px;font-size:20px;font-weight:700;color:#263f50'>Malkiaa Studio</p>" +
    "<p>" + greeting + "</p>" +
    "<p style='margin:24px 0 8px;font-weight:700'>Request details</p>" +
    "<table role='presentation' style='border-collapse:collapse;width:100%'>" +
    "<tr><td style='padding:8px 0;border-bottom:1px solid #e5e7eb;color:#667085'>Request ID</td><td style='padding:8px 0;border-bottom:1px solid #e5e7eb;text-align:right'><b>" + id + "</b></td></tr>" +
    "<tr><td style='padding:8px 0;border-bottom:1px solid #e5e7eb;color:#667085'>Service</td><td style='padding:8px 0;border-bottom:1px solid #e5e7eb;text-align:right'>" + service + " " + tier + "</td></tr>" +
    "<tr><td style='padding:8px 0;border-bottom:1px solid #e5e7eb;color:#667085'>Estimate</td><td style='padding:8px 0;border-bottom:1px solid #e5e7eb;text-align:right'>" + price + "</td></tr>" +
    "</table>" + extra +
    "<p style='margin-top:28px;padding-top:16px;border-top:1px solid #e5e7eb;color:#667085;font-size:13px'>Malkiaa Studio · Commission support<br>mmaackia@gmail.com</p>" +
    "</div></body></html>";
}

async function sendCommissionEmails(db: any, order: any, form: any) {
  const config = await getEmailConfig(db);
  const results: any[] = [];
  const clientName = clean(form?.name, 120) || "Client";
  const clientEmail = clean(form?.email, 254).toLowerCase();

  // Commission confirmation is sent only to the client.
  if (clientEmail) {
    results.push(await deliverEmail(db, config, {
      to: clientEmail,
      subject: "We received your commission request | " + order.id,
      html: commissionEmailHtml(order, clientName),
      text: commissionEmailText(order, clientName),
      orderId: order.id,
      kind: "client",
    }));
  }
  return results;
}



function orderUpdateEmailText(order: any, track: any, eventType: string, message: string) {
  const labels: Record<string, string> = {
    finished_art: "Your finished artwork has been delivered.",
    proposal: "Your commission proposal is ready to review.",
    progress: "There is a new progress update for your commission.",
    status: "Your commission status has changed.",
    manual: "There is a new update to your commission.",
  };
  const update = clean(message, 1200) || labels[eventType] || "There is an update to your commission.";
  return [
    "Malkiaa Studio",
    "",
    "Hello " + (clean(order?.form?.name, 120) || "there") + ",",
    update,
    "",
    "Request details",
    "Request ID: " + clean(order.id, 40),
    "Service: " + clean(order.serviceTitle, 160),
    "Current status: " + clean(track?.status || order.status || "Updated", 80),
    "",
    "View your latest commission details in Track Order on the Malkiaa Studio website.",
    "If you have a question, reply directly to this email.",
    "",
    "Malkiaa Studio",
    "Commission support · mmaackia@gmail.com"
  ].join("\n");
}

function orderUpdateEmailHtml(order: any, track: any, eventType: string, message: string) {
  const id = escapeHtml(order.id);
  const name = escapeHtml(clean(order.form?.name, 120) || "Client");
  const service = escapeHtml(order.serviceTitle || "Commission");
  const status = escapeHtml(track?.status || order.status || "Updated");
  const labels: Record<string, string> = {
    finished_art: "Your finished artwork has been delivered.",
    proposal: "Your commission proposal is ready to review.",
    progress: "There is a new progress update for your commission.",
    status: "Your commission status has changed.",
    manual: "There is a new update to your commission.",
  };
  const update = escapeHtml(clean(message, 1200) || labels[eventType] || "There is an update to your commission.").replace(/\n/g, "<br>");
  const body = "<p>Hello " + name + ",</p><p>" + update + "</p>" +
    "<p style='margin:24px 0 8px;font-weight:700'>Request details</p>" +
    "<p><b>Request ID:</b> " + id + "<br><b>Service:</b> " + service + "<br><b>Current status:</b> " + status + "</p>" +
    "<p>View your latest commission details in Track Order on the Malkiaa Studio website.</p>" +
    "<p>If you have a question, reply directly to this email.</p>";
  return "<!doctype html><html><body style='margin:0;padding:24px;background:#ffffff;color:#303943;font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.6'><div style='max-width:600px;margin:0 auto'>" +
    "<p style='margin:0 0 20px;font-size:20px;font-weight:700;color:#263f50'>Malkiaa Studio</p>" + body +
    "<p style='margin-top:28px;padding-top:16px;border-top:1px solid #e5e7eb;color:#667085;font-size:13px'>Malkiaa Studio · Commission support<br>mmaackia@gmail.com</p>" +
    "</div></body></html>";
}

async function sendOrderUpdateEmails(db: any, order: any, track: any, eventType: string, eventId: string, message: string) {
  const config = await getEmailConfig(db);
  const clientEmail = clean(order?.form?.email, 254).toLowerCase();
  const results: any[] = [];
  if (clientEmail) {
    results.push(await deliverEmail(db, config, {
      to: clientEmail,
      subject: "[Malkiaa Studio] Commission Update — " + order.id,
      html: orderUpdateEmailHtml(order, track, eventType, message),
      text: orderUpdateEmailText(order, track, eventType, message),
      orderId: order.id,
      kind: "client_evt_" + eventType + "_" + eventId,
      idempotencyKey: order.id + ":client:" + eventId,
    }));
  }
  return results;
}

async function addSignedFinalFileUrls(db: any, track: any) {
  const files = Array.isArray(track?.finalFiles) ? track.finalFiles : [];
  const signedFiles = await Promise.all(files.map(async (file: any) => {
    if (!file?.path || !(file.path.startsWith("incoming/") && /^[A-Za-z0-9-]{20,80}$/.test(file.path.slice(9)))) {
      return { name: file?.name, type: file?.type, unavailable: true };
    }
    const { data, error } = await db.storage.from("references").createSignedUrl(file.path, 60 * 60);
    if (error || !data?.signedUrl) {
      console.error("final artwork signed URL failed", { orderId: track.id, path: file.path, error });
      return { name: file.name, type: file.type, unavailable: true };
    }
    return { name: file.name, type: file.type, path: file.path, url: data.signedUrl };
  }));
  return { ...track, finalFiles: signedFiles };
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
      if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
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
      const { emailHash: _privateEmailHash, ...publicTrack } = savedTrack;
      return json({ track: publicTrack, notifications, duplicate: submission.duplicate === true }, submission.duplicate === true ? 200 : 201);
    }

    if (action === "creator_track") {
      const owner = await requireOwner(req, db);
      if (!owner.ok) return json({ error: owner.error }, owner.status);
      const id = clean(body?.id, 40).toUpperCase();
      const { data: track, error } = await db.from("order_tracks").select("*").eq("id", id).maybeSingle();
      if (error || !track) return json({ error: "Tracking record was not found." }, 404);
      const { emailHash: _privateHash, ...safeTrack } = await addSignedFinalFileUrls(db, track);
      return json({ track: safeTrack });
    }

    if (action === "creator_save_commission") {
      const owner = await requireOwner(req, db);
      if (!owner.ok) return json({ error: owner.error }, owner.status);
      const id = clean(body?.id, 40).toUpperCase();
      const orderPatch = body?.order;
      const trackPatch = body?.track;
      if (!/^COMMISSION-[0-9]{4}-[0-9]{4,}$/.test(id) ||
          !orderPatch || typeof orderPatch !== "object" || Array.isArray(orderPatch) ||
          !trackPatch || typeof trackPatch !== "object" || Array.isArray(trackPatch)) {
        return json({ error: "Invalid commission save payload." }, 400);
      }
      const requestedStatus = clean(orderPatch.status, 40);
      const payment = clean(orderPatch.payment, 30);
      const status = payment === "Paid" && requestedStatus === "Awaiting Payment" ? "Paid" : requestedStatus;
      const allowedStatuses = ["Pending Review", "Reviewing", "Proposal Sent", "Awaiting Client Approval", "Awaiting Payment", "Paid", "In Progress", "Waiting for Feedback", "Revision", "Completed", "Cancelled", "Rejected"];
      const allowedPayments = ["Unpaid", "Invoice sent", "Paid", "Refunded"];
      if (!allowedStatuses.includes(status) || !allowedPayments.includes(payment)) {
        return json({ error: "Invalid commission or payment status." }, 400);
      }
      const finalPrice = orderPatch.finalPrice == null || orderPatch.finalPrice === "" ? null : Number(orderPatch.finalPrice);
      if (finalPrice !== null && (!Number.isFinite(finalPrice) || finalPrice < 0)) {
        return json({ error: "Final price must be a valid non-negative amount." }, 400);
      }
      const patch: Record<string, unknown> = {};
      for (const key of ["proposal", "updates", "finalFiles", "estimate", "custom"]) {
        if (Object.prototype.hasOwnProperty.call(trackPatch, key)) patch[key] = trackPatch[key];
      }
      if (patch.updates !== undefined && !Array.isArray(patch.updates)) return json({ error: "Tracking updates must be an array." }, 400);
      if (patch.finalFiles !== undefined && !Array.isArray(patch.finalFiles)) return json({ error: "Final artwork files must be an array." }, 400);
      if (patch.finalFiles !== undefined && patch.finalFiles.some((file: any) =>
        !file || typeof file !== "object" || Array.isArray(file) ||
        typeof file.name !== "string" || !file.name.trim() ||
        typeof file.path !== "string" || !(file.path.startsWith("incoming/") && /^[A-Za-z0-9-]{20,80}$/.test(file.path.slice(9))) ||
        (file.url && String(file.url).startsWith("blob:"))
      )) return json({ error: "Every Finished Art file must be uploaded to permanent Storage before saving." }, 422);
      if (patch.proposal !== undefined && patch.proposal !== null && (typeof patch.proposal !== "object" || Array.isArray(patch.proposal))) {
        return json({ error: "Proposal data is invalid." }, 400);
      }
      if (patch.estimate !== undefined && (!Number.isFinite(Number(patch.estimate)) || Number(patch.estimate) < 0)) {
        return json({ error: "Tracking estimate is invalid." }, 400);
      }
      const { data: savedTrack, error: saveError } = await db.rpc("sync_commission_state", {
        p_commission_id: id,
        p_status: status,
        p_payment: payment,
        p_notes: clean(orderPatch.notes, 5000),
        p_final_price: finalPrice,
        p_extra_lines: String(orderPatch.extraLines || "").slice(0, 5000),
        p_track_patch: patch,
      });
      if (saveError || !savedTrack?.id) {
        console.error("atomic commission state save failed", { id, error: saveError });
        return json({ error: "Could not synchronize commission, payment, and tracking data." }, 500);
      }
      const { emailHash: _privateHash, ...publicTrack } = savedTrack;
      return json({ ok: true, track: publicTrack });
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

      const { emailHash: _privateHash, ...publicTrack } = await addSignedFinalFileUrls(db, track);
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
      const { data: order, error: orderError } = await db.from("commission_requests")
        .select("notes,finalPrice,extraLines").eq("id", id).maybeSingle();
      if (orderError || !order) {
        console.error("client response commission lookup failed", orderError);
        return json({ error: "Could not load the commission record." }, 500);
      }
      const { data: updated, error } = await db.rpc("sync_commission_state", {
        p_commission_id: id,
        p_status: status,
        p_payment: track.payment || "Unpaid",
        p_notes: order.notes || "",
        p_final_price: order.finalPrice,
        p_extra_lines: order.extraLines || "",
        p_track_patch: { proposal, updates },
      });
      if (error || !updated?.id) {
        console.error("client response synchronization failed", error);
        return json({ error: "Could not synchronize your proposal response." }, 500);
      }
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

    if (action === "portfolio_upload") {
      const owner = await requireOwner(req, db);
      if (!owner.ok) return json({ error: owner.error }, owner.status);

      const base64 = typeof body?.base64 === "string" ? body.base64 : "";
      const contentType = clean(body?.contentType, 80).toLowerCase();
      if (contentType !== "image/webp" || !base64 || base64.length > 5_600_000 ||
          !/^[A-Za-z0-9+/]+={0,2}$/.test(base64)) {
        return json({ error: "Invalid image upload. Please choose a supported image and try again." }, 400);
      }

      let bytes: Uint8Array;
      try {
        const binary = atob(base64);
        if (!binary.length || binary.length > 4 * 1024 * 1024) {
          return json({ error: "Image is too large. The compressed image must be 4 MB or smaller." }, 413);
        }
        bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
      } catch {
        return json({ error: "The image data could not be decoded." }, 400);
      }

      const bucketName = "site-media";
      const { data: bucket, error: bucketLookupError } = await db.storage.getBucket(bucketName);
      if (!bucket) {
        const { error: createBucketError } = await db.storage.createBucket(bucketName, {
          public: true,
          fileSizeLimit: 4 * 1024 * 1024,
          allowedMimeTypes: ["image/webp"],
        });
        if (createBucketError && !/already exists|duplicate/i.test(createBucketError.message || "")) {
          console.error("site media bucket creation failed", createBucketError, bucketLookupError);
          return json({ error: "Could not initialise permanent image storage." }, 503);
        }
      }

      const path = owner.user.id + "/" + crypto.randomUUID() + ".webp";
      const { error: uploadError } = await db.storage.from(bucketName).upload(path, bytes, {
        contentType,
        cacheControl: "31536000",
        upsert: false,
      });
      if (uploadError) {
        console.error("site media upload failed", uploadError);
        return json({ error: "Could not save the image to permanent storage." }, 500);
      }
      const { data: publicData } = db.storage.from(bucketName).getPublicUrl(path);
      return json({ ok: true, bucket: bucketName, path, url: publicData.publicUrl });
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

    if (action === "notify_update") {
      const owner = await requireOwner(req, db);
      if (!owner.ok) return json({ error: owner.error }, owner.status);
      const id = clean(body?.id, 40).toUpperCase();
      const eventId = clean(body?.eventId, 80);
      const eventType = clean(body?.eventType, 30);
      const allowedEvents = ["proposal", "progress", "status", "finished_art", "manual"];
      if (!/^ev_[A-Za-z0-9]{16,70}$/.test(eventId) || !allowedEvents.includes(eventType)) {
        return json({ error: "Invalid order notification event." }, 400);
      }
      const [{ data: order, error: orderError }, { data: track, error: trackError }] = await Promise.all([
        db.from("commission_requests").select("*").eq("id", id).maybeSingle(),
        db.from("order_tracks").select("*").eq("id", id).maybeSingle(),
      ]);
      if (orderError || trackError || !order || !track) return json({ error: "Commission or tracking record was not found." }, 404);
      if (eventType === "finished_art" && (!Array.isArray(track.finalFiles) || track.finalFiles.length === 0 ||
          track.finalFiles.some((file: any) => !file?.path || !(file.path.startsWith("incoming/") && /^[A-Za-z0-9-]{20,80}$/.test(file.path.slice(9)))))) {
        return json({ error: "Upload every Finished Art file to permanent Storage before sending the delivery email." }, 409);
      }
      const defaults: Record<string, string> = {
        proposal: "Your commission proposal is ready. Open Track Order to review the details.",
        progress: "There is a new progress update for your commission. Open Track Order to view it.",
        status: "Your commission status has changed. Open Track Order to view the latest status.",
        finished_art: "Your Finished Art has been delivered. Open Track Order using your Request ID and email address to view and download the final files.",
        manual: "A new update is available for your commission. Open Track Order to view the latest details.",
      };
      const message = clean(body?.message, 1200) || defaults[eventType];
      const clientEmail = clean(order?.form?.email, 254).toLowerCase();
      if (!clientEmail || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(clientEmail)) {
        return json({ error: "This commission has no valid client email address. Update the order client email before sending." }, 422);
      }
      const notifications = await sendOrderUpdateEmails(db, order, track, eventType, eventId, message);
      const clientNotification = notifications.find((item: any) => String(item.kind || "").startsWith("client_evt_" + eventType + "_"));
      if (!clientNotification) {
        return json({ error: "The client notification was not created. Check the client email and commission record.", notifications }, 502);
      }
      return json({ ok: true, notifications });
    }

    if (action === "test") {
      const owner = await requireOwner(req, db);
      if (!owner.ok) return json({ error: owner.error }, owner.status);
      return json({
        status: "disabled",
        message: "Standalone test emails are disabled. Verify email delivery with a test commission addressed to a client test inbox.",
      }, 409);
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
      const { data: track } = await db.from("order_tracks").select("*").eq("id", id).maybeSingle();
      // Only failed client notifications are eligible for retry.
      const failedClientNotifications = (failed || []).filter((item: any) =>
        item.kind === "client" || String(item.kind || "").startsWith("client_evt_")
      );
      for (const item of failedClientNotifications) {
        const eventMatch = item.kind.match(/^client_evt_(proposal|progress|status|finished_art|manual)_/);
        const eventType = eventMatch?.[1];
        const latestUpdate = Array.isArray(track?.updates) ? [...track.updates].reverse().find((u: any) => u.from === "artist") : null;
        const message = clean(latestUpdate?.text, 1200) || "A new update is available for your commission. Open Track Order to view the latest details.";
        const html = eventType
          ? orderUpdateEmailHtml(order, track, eventType, message)
          : commissionEmailHtml(order, clean(order.form?.name, 120));
        const plainText = eventType
          ? orderUpdateEmailText(order, track, eventType, message)
          : commissionEmailText(order, clean(order.form?.name, 120));
        results.push(await deliverEmail(db, config, {
          to: clean(item.recipient, 254),
          subject: "[Malkiaa Studio] Commission Update — " + id,
          html,
          text: plainText,
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

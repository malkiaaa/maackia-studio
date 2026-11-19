// Malkiaa Studio commission API — staging
// Deploy: supabase functions deploy commission-api
// Required secrets: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
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
const clean = (v: unknown, max = 500) => typeof v === "string" ? v.trim().slice(0, max) : "";
const allowedTypes = new Set(["image/jpeg", "image/png", "image/webp", "image/gif", "application/pdf"]);

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Method not allowed." }, 405);

  const url = Deno.env.get("SUPABASE_URL");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !serviceKey) return json({ error: "Server database secrets are not configured." }, 503);

  const db = createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });
  try {
    const body = await req.json();
    const action = clean(body?.action, 40);

    if (action === "submit") {
      const order = body?.order;
      const form = order?.form;
      const email = clean(form?.email, 254).toLowerCase();
      const { data: generatedId, error: idError } = await db.rpc("next_commission_id");
      if (idError || !generatedId) {
        console.error("commission ID generation failed", idError);
        return json({ error: "Could not generate a commission number. Please try again." }, 500);
      }
      const id = clean(generatedId, 40);
      if (!id || !/^[A-Z0-9-]{8,40}$/.test(id)) return json({ error: "Invalid request ID." }, 400);
      if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return json({ error: "A valid client email is required." }, 400);
      if (!order?.serviceTitle || !form || typeof form !== "object") return json({ error: "Incomplete commission request." }, 400);

      const emailHash = await sha256(email + "|" + id);
      const safeOrder = {
        id,
        created_at: new Date().toISOString(),
        "createdAt": clean(order.createdAt, 50) || new Date().toISOString(),
        status: "Pending Review",
        payment: "Unpaid",
        "serviceId": clean(order.serviceId, 100),
        "serviceTitle": clean(order.serviceTitle, 180),
        "tierName": clean(order.tierName, 120),
        form,
        estimate: order.estimate && typeof order.estimate === "object" ? order.estimate : {},
        notes: "",
        "finalPrice": null,
        "extraLines": "",
      };
      const safeTrack = {
        id,
        created_at: new Date().toISOString(),
        "createdAt": clean(order.createdAt, 50) || new Date().toISOString(),
        "serviceTitle": safeOrder["serviceTitle"],
        status: "Pending Review",
        payment: "Unpaid",
        estimate: Number(order?.estimate?.total) || 0,
        custom: Boolean(order?.estimate?.custom),
        "emailHash": emailHash,
        client_name: clean(form?.name, 120) || "Client",
        proposal: null,
        updates: [],
        "finalFiles": [],
      };

      const { error: orderError } = await db.from("commission_requests").insert(safeOrder);
      if (orderError) {
        if (orderError.code === "23505") return json({ error: "Request ID collision. Please submit again." }, 409);
        console.error("commission insert failed", orderError);
        return json({ error: "Could not save this commission request." }, 500);
      }
      const { error: trackError } = await db.from("order_tracks").insert(safeTrack);
      if (trackError) {
        await db.from("commission_requests").delete().eq("id", id);
        console.error("tracking insert failed", trackError);
        return json({ error: "Could not initialize order tracking." }, 500);
      }
      return json({ track: safeTrack }, 201);
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
      const items = (data || []).map((item) => ({
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
      const { data: track } = await db.from("order_tracks").select("*").eq("id", id).maybeSingle();
      const suppliedHash = await sha256(email + "|" + id);
      if (!track || track.emailHash !== suppliedHash) return json({ error: "No order matches that Request ID and email." }, 404);
      return json({ track });
    }

    if (action === "respond") {
      const id = clean(body?.id, 40).toUpperCase();
      const email = clean(body?.email, 254).toLowerCase();
      const response = clean(body?.response, 20);
      const note = clean(body?.text, 1000);
      if (!["Accepted", "Declined"].includes(response)) return json({ error: "Invalid proposal response." }, 400);
      const { data: track } = await db.from("order_tracks").select("*").eq("id", id).maybeSingle();
      const suppliedHash = await sha256(email + "|" + id);
      if (!track || track.emailHash !== suppliedHash || !email) return json({ error: "No order matches that Request ID and email." }, 404);
      if (!track.proposal) return json({ error: "A proposal is not available for this order yet." }, 409);
      const proposal = { ...(track.proposal || {}), response };
      const updates = Array.isArray(track.updates) ? track.updates : [];
      updates.push({ at: new Date().toISOString(), from: "client", text: note || "Client: " + response });
      const status = response === "Accepted" ? "Awaiting Payment" : "Cancelled";
      const { data: updated, error } = await db.from("order_tracks")
        .update({ proposal, updates, status }).eq("id", id).select("*").single();
      if (error) {
        console.error("client response update failed", error);
        return json({ error: "Could not save your response." }, 500);
      }
      await db.from("commission_requests").update({ status }).eq("id", id);
      return json({ track: updated });
    }

    if (action === "upload") {
      const type = clean(body?.type, 100);
      const size = Number(body?.size);
      if (!allowedTypes.has(type)) return json({ error: "Unsupported reference file type." }, 400);
      if (!Number.isFinite(size) || size <= 0 || size > 10 * 1024 * 1024) return json({ error: "Reference files must be 10 MB or smaller." }, 400);
      const path = "incoming/" + crypto.randomUUID();
      const { data, error } = await db.storage.from("references").createSignedUploadUrl(path);
      if (error || !data) {
        console.error("signed upload URL failed", error);
        return json({ error: "Could not prepare reference upload." }, 500);
      }
      return json({ path, token: data.token });
    }

    return json({ error: "Unknown API action." }, 400);
  } catch (error) {
    console.error("commission-api error", error);
    return json({ error: "Unexpected server error." }, 500);
  }
});

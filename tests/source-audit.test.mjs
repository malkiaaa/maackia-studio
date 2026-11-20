import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
const backend = readFileSync(new URL("../supabase/functions/commission-api/index.ts", import.meta.url), "utf8");
const reviewMigration = readFileSync(new URL("../supabase/migrations/202611190001_client_reviews.sql", import.meta.url), "utf8");
const rateMigration = readFileSync(new URL("../supabase/migrations/202611200001_track_attempt_rate_limit.sql", import.meta.url), "utf8");

function getServerEstimate() {
  const start = backend.indexOf("function calculateServerEstimate(");
  const end = backend.indexOf("\nasync function getEmailConfig", start);
  assert.ok(start >= 0 && end > start, "server estimate calculator must be extractable");
  return new Function(backend.slice(start, end) + "; return calculateServerEstimate;")();
}

const pricingSite = {
  services: [{ id: "svc", title: "Illustration", tiers: [{ id: "base", name: "Base", price: 1000 }], addons: [
    { id: "chars", name: "Additional Character", type: "percent", price: 80, select: "multiple" },
    { id: "background", name: "Background", type: "fixed", price: 500, select: "single" },
    { id: "detail", name: "Detail", type: "fixed", price: 100, select: "multiple" },
  ] }],
  licenses: [{ id: "personal", label: "Personal", type: "fixed", value: 0 }],
};

function orderFor(overrides = {}) {
  return { serviceId: "svc", form: { tier: "base", chars: 1, addons: {}, license: "personal" }, estimate: { total: 1000 }, ...overrides };
}

function extractCalc(source) {
  const start = source.indexOf("function calc(");
  const end = source.indexOf("\nconst sha", start);
  assert.ok(start >= 0 && end > start, "calc() must remain present and extractable");
  return source.slice(start, end);
}

function getCalc() {
  const config = { licenses: [] };
  const X = (service) => ({ tiers: [], addons: [], ...service });
  const licList = () => config.licenses;
  return new Function("X", "licList", "CONFIG", extractCalc(html) + "; return calc;")(X, licList, config);
}

const service = {
  tiers: [{ id: "base", name: "Base", price: 1000 }],
  addons: [{ id: "characters", name: "Additional Character", type: "percent", price: 80 }],
};

test("additional-character pricing follows 100%, 180%, 260%, 340%", () => {
  const calc = getCalc();
  [1, 2, 3, 4].forEach((count) => {
    const result = calc(service, { tier: "base", chars: count, addons: {}, license: "" });
    assert.ok(Math.abs(result.total - 1000 * (1 + 0.8 * (count - 1))) < 1e-8, count + " character(s)");
  });
});

test("unrelated fixed add-ons are not multiplied by character count", () => {
  const calc = getCalc();
  const withRush = {
    ...service,
    addons: [...service.addons, { id: "rush", name: "Rush Delivery", type: "fixed", price: 500 }],
  };
  const result = calc(withRush, { tier: "base", chars: 4, addons: { rush: 1 }, license: "" });
  assert.ok(Math.abs(result.total - 3900) < 1e-8);
  assert.equal(result.lines.find((line) => line[0].startsWith("Rush Delivery"))[1], 500);
});

test("PageBuilderBlocks calls hooks before its conditional early return", () => {
  const start = html.indexOf("function PageBuilderBlocks(");
  const end = html.indexOf("\nfunction App(", start);
  assert.ok(start >= 0 && end > start);
  const component = html.slice(start, end);
  const hooks = component.indexOf("useState(");
  const earlyReturn = component.indexOf("if(!editing&&!blocks.length)return null");
  assert.ok(hooks >= 0 && earlyReturn > hooks, "all hooks must run before the empty non-editing return");
});

test("Creator draft restoration merges the full saved draft, not only builder blocks", () => {
  assert.match(html, /if\(r\.site && typeof r\.site === "object" && !Array\.isArray\(r\.site\)\)/);
  assert.match(html, /setSite\(p=>mergeDeep\(p,r\.site\)\)/);
  assert.match(html, /save_draft_site/);
});

test("partial commission-save errors retain the generated Request ID for the client", () => {
  assert.match(html, /if \(j\.commissionId\) error\.commissionId = j\.commissionId/);
  assert.match(html, /Your commission was saved, but order tracking could not be initialized/);
  assert.match(html, /Do not submit again/);
});

test("public reviews query only exposes approved reviews", () => {
  const start = backend.indexOf('if (action === "public_reviews")');
  const end = backend.indexOf('if (action === "reviews_admin_list")', start);
  const action = backend.slice(start, end);
  assert.match(action, /\.eq\("status",\s*"approved"\)/);
});

test("review submissions are unique per commission and require completion", () => {
  assert.match(reviewMigration, /commission_id text not null unique/i);
  assert.match(reviewMigration, /status text not null default 'pending'/i);
  const start = backend.indexOf('if (action === "submit_review")');
  const end = backend.indexOf('if (action === "public_reviews")', start);
  const action = backend.slice(start, end);
  assert.match(action, /track\.status !== "Completed"/);
  assert.match(action, /status:\s*"pending"/);
});

test("creator review moderation and destructive commission actions are owner-gated", () => {
  for (const actionName of ["reviews_admin_list", "reviews_admin_update", "reviews_admin_delete", "delete_commission"]) {
    const start = backend.indexOf('if (action === "' + actionName + '")');
    assert.ok(start >= 0, actionName + " endpoint exists");
    const snippet = backend.slice(start, start + 300);
    assert.match(snippet, /requireOwner\(req, db\)/, actionName + " must require Creator authorization");
  }
});

test("frontend source does not contain server-side secrets", () => {
  assert.doesNotMatch(html, /(?:SUPABASE_SERVICE_ROLE_KEY|GAS_WEBHOOK_SECRET)\s*[:=]\s*["'][^"']+["']/);
});


test("server estimate applies 100%, 180%, 260%, 340% character pricing", () => {
  const calculate = getServerEstimate();
  [1000, 1800, 2600, 3400].forEach((expected, index) => {
    const result = calculate(pricingSite, orderFor({ form: { tier: "base", chars: index + 1, addons: {}, license: "personal" } }));
    assert.equal(result.ok, true);
    assert.equal(result.estimate.total, expected);
  });
});

test("fixed add-ons are charged once per selected quantity, not per character", () => {
  const calculate = getServerEstimate();
  const result = calculate(pricingSite, orderFor({ form: { tier: "base", chars: 4, addons: { background: 1 }, license: "personal" } }));
  assert.equal(result.estimate.total, 3900);
  assert.equal(result.estimate.lines.find((line) => line[0] === "Background")[1], 500);
});

test("client price manipulation is ignored and server total is authoritative", () => {
  const calculate = getServerEstimate();
  const result = calculate(pricingSite, orderFor({ estimate: { total: -999999999, lines: [["fake", -1]] } }));
  assert.equal(result.ok, true);
  assert.equal(result.clientEstimateMismatch, true);
  assert.equal(result.estimate.total, 1000);
  assert.equal(result.estimate.lines.some((line) => line[0] === "fake"), false);
});

test("server rejects unknown services and tiers", () => {
  const calculate = getServerEstimate();
  assert.equal(calculate(pricingSite, orderFor({ serviceId: "not-real" })).ok, false);
  assert.equal(calculate(pricingSite, orderFor({ form: { tier: "not-real", chars: 1, addons: {}, license: "personal" } })).ok, false);
});

test("server rejects character counts outside the existing 1 through 20 form range", () => {
  const calculate = getServerEstimate();
  for (const chars of [0, 21, -1, 1.5, "many"]) {
    assert.equal(calculate(pricingSite, orderFor({ form: { tier: "base", chars, addons: {}, license: "personal" } })).ok, false);
  }
});

test("server rejects negative prices in its trusted pricing configuration", () => {
  const calculate = getServerEstimate();
  const negativeTier = structuredClone(pricingSite);
  negativeTier.services[0].tiers[0].price = -1;
  assert.equal(calculate(negativeTier, orderFor()).ok, false);
  const negativeAddon = structuredClone(pricingSite);
  negativeAddon.services[0].addons[1].price = -10;
  assert.equal(calculate(negativeAddon, orderFor({ form: { tier: "base", chars: 1, addons: { background: 1 }, license: "personal" } })).ok, false);
});

test("server rejects unknown add-ons, invalid quantities and unknown licenses", () => {
  const calculate = getServerEstimate();
  assert.equal(calculate(pricingSite, orderFor({ form: { tier: "base", chars: 1, addons: { injected: 1 }, license: "personal" } })).ok, false);
  assert.equal(calculate(pricingSite, orderFor({ form: { tier: "base", chars: 1, addons: { background: 2 }, license: "personal" } })).ok, false);
  assert.equal(calculate(pricingSite, orderFor({ form: { tier: "base", chars: 1, addons: {}, license: "injected" } })).ok, false);
});

test("commission submit accepts normal email addresses and rejects malformed ones", () => {
  const start = backend.indexOf('if (action === "submit") {');
  const end = backend.indexOf('if (action === "public_board") {', start);
  const action = backend.slice(start, end);
  assert.ok(action.includes(String.raw`if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {`));
  assert.doesNotMatch(action, String.raw`/^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$/`);
  const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  assert.equal(emailPattern.test("client@example.com"), true);
  assert.equal(emailPattern.test("client.name+art@example.co.id"), true);
  assert.equal(emailPattern.test("client example.com"), false);
});

test("commission form allows direct step navigation and validates all required fields before submit", () => {
  assert.match(html, /className="step-scrubber"/);
  assert.match(html, /onChange=\{\(e\) => setStep\(Number\(e\.target\.value\)\)\}/);
  assert.match(html, /const validateAll = \(\) =>/);
  assert.match(html, /if \(!validateAll\(\)\) return/);
  assert.doesNotMatch(html, /disabled=\{i > step\}/);
});

test("submit persists only the server-calculated estimate", () => {
  const start = backend.indexOf('if (action === "submit") {');
  const end = backend.indexOf('if (action === "public_board") {', start);
  const action = backend.slice(start, end);
  assert.match(action, /calculateServerEstimate\(siteRow\.value, order\)/);
  assert.match(action, /estimate: pricing\.estimate/);
  assert.match(action, /estimate: pricing\.estimate\.total/);
  assert.doesNotMatch(action, /estimate: order\.estimate/);
});


test("tracking endpoint calls the atomic rate-limit RPC before lookup and returns neutral 429", () => {
  const start = backend.indexOf('if (action === "track")');
  const end = backend.indexOf('if (action === "submit_review")', start);
  const action = backend.slice(start, end);
  assert.ok(action.indexOf('db.rpc("record_track_attempt"') < action.indexOf('db.from("order_tracks")'));
  assert.match(action, /rateResult\.allowed !== true/);
  assert.match(action, /json\(\{ error: "No order matches that Request ID and email\." \}, 429\)/);
  assert.match(action, /db\.rpc\("mark_track_attempt_success"/);
  assert.match(action, /sha256\("track-ip\|"/);
  assert.match(action, /sha256\("track-email\|"/);
});

test("tracking rate-limit SQL serializes each key and blocks after five failures", () => {
  assert.match(rateMigration, /pg_advisory_xact_lock/);
  assert.match(rateMigration, /created_at >= now\(\) - interval '15 minutes'/);
  assert.match(rateMigration, /v_allowed := v_failed_count < 5/);
  assert.match(rateMigration, /insert into public\.track_attempts \(ip_hash, email_hash, request_id, succeeded\)/i);
  assert.match(rateMigration, /created_at < now\(\) - interval '30 days'/);
  assert.match(rateMigration, /grant execute on function public\.record_track_attempt.*service_role/i);
});


test("commission submit requires idempotency key and uses one atomic RPC", () => {
  const start = backend.indexOf('if (action === "submit") {');
  const end = backend.indexOf('if (action === "public_board") {', start);
  const action = backend.slice(start, end);
  assert.match(action, /body\?\.idempotencyKey/);
  assert.match(action, /db\.rpc\("submit_commission_atomic"/);
  assert.doesNotMatch(action, /from\("commission_requests"\)\.insert/);
  assert.doesNotMatch(action, /from\("order_tracks"\)\.insert/);
  assert.match(action, /submission\.duplicate === true/);
});

test("commission deletion uses one atomic RPC after Creator authorization", () => {
  const start = backend.indexOf('if (action === "delete_commission") {');
  const end = backend.indexOf('if (action === "respond") {', start);
  const action = backend.slice(start, end);
  assert.match(action, /requireOwner\(req, db\)/);
  assert.match(action, /db\.rpc\("delete_commission_atomic"/);
  assert.doesNotMatch(action, /\.from\("(order_tracks|commission_management|commission_requests)"\)\.delete/);
});

test("atomic commission migration retains payment behavior and includes idempotency tombstones", () => {
  const migration = readFileSync(new URL("../supabase/migrations/202611200002_atomic_commissions.sql", import.meta.url), "utf8");
  assert.match(migration, /create table if not exists public\.commission_submit_keys/i);
  assert.match(migration, /pg_advisory_xact_lock/);
  assert.match(migration, /IDEMPOTENCY_KEY_CONFLICT/);
  assert.match(migration, /IDEMPOTENCY_KEY_RETIRED/);
  assert.match(migration, /delete from public\.client_reviews/);
  assert.match(migration, /delete from public\.notifications/);
  assert.match(migration, /update public\.commission_submit_keys[\s\S]*deleted_at/);
  assert.doesNotMatch(migration, /stripe|paypal|payment_intent|checkout/i);
});

test("browser keeps the idempotency key on retry and clears it only after successful submit", () => {
  assert.match(html, /mk-submit-idem-/);
  assert.match(html, /ss\.set\(storageKey, idempotencyKey\)/);
  assert.match(html, /const result = await Store\.submit\(order, track, idempotencyKey\)/);
  assert.match(html, /ss\.del\(storageKey\)/);
});


test("server pricing rejects negative add-on and license configuration even when unselected", () => {
  const calculate = getServerEstimate();
  const negativeAddon = structuredClone(pricingSite);
  negativeAddon.services[0].addons[0].price = -1;
  assert.equal(calculate(negativeAddon, orderFor()).ok, false);
  const negativeLicense = structuredClone(pricingSite);
  negativeLicense.licenses[0].value = -1;
  assert.equal(calculate(negativeLicense, orderFor()).ok, false);
});

test("submit response does not expose the tracking email hash", () => {
  const start = backend.indexOf('if (action === "submit") {');
  const end = backend.indexOf('if (action === "public_board") {', start);
  const action = backend.slice(start, end);
  assert.match(action, /const \{ emailHash: _privateEmailHash, \.\.\.publicTrack \} = savedTrack/);
  assert.match(action, /json\(\{ track: publicTrack/);
});


test("server character limit matches the commission form maximum", () => {
  assert.match(html, /max="20"/);
  assert.match(backend, /rawChars > 20/);
});


test("commission and order-update emails are sent only to clients", () => {
  const updateStart = backend.indexOf("async function sendOrderUpdateEmails");
  const updateEnd = backend.indexOf("async function addSignedFinalFileUrls", updateStart);
  const updateAction = backend.slice(updateStart, updateEnd);
  assert.match(updateAction, /kind: "client_evt_" \+ eventType/);
  assert.doesNotMatch(updateAction, /artistEmail|artist_evt_|forClient/);

  const notifyStart = html.indexOf("const notify = async (eventType, message) =>");
  const notifyEnd = html.indexOf("const save = async", notifyStart);
  const notify = html.slice(notifyStart, notifyEnd);
  assert.match(notify, /client_evt_/);
  assert.doesNotMatch(notify, /artistResult|artist_evt_|Creator notification result is missing/);

  const start = backend.indexOf("async function sendCommissionEmails");
  const end = backend.indexOf("async function addSignedFinalFileUrls", start);
  const action = backend.slice(start, end);
  assert.match(action, /to: clientEmail/);
  assert.doesNotMatch(action, /artistEmail|kind: "artist"|isClient/);
  assert.doesNotMatch(html, /Send confirmation email to client after submission|artistEmail|client and Creator|Creator and client are notified|copied to the Creator/);
});

test("standalone test email is disabled and failed retries are client-only", () => {
  assert.match(backend, /Standalone test emails are disabled/);
  assert.match(backend, /failedClientNotifications/);
  assert.doesNotMatch(backend, /artistEmail|sendArtist|artist_evt_|isClient|forClient/);
  assert.match(backend, /startsWith\("client_evt_"\)/);
});

test("Finished Art is previewed before delivery and private files are signed for tracking", () => {
  assert.match(html, /Finished Art pre-review/);
  assert.match(html, /Send Finished Art to Client/);
  assert.match(backend, /async function addSignedFinalFileUrls/);
  assert.match(backend, /createSignedUrl\(file\.path, 60 \* 60\)/);
  assert.match(backend, /if \(action === "creator_track"\)/);
});

test("manual client email and lifecycle update actions are owner-authorized", () => {
  assert.match(html, /Send Email to Client/);
  assert.match(html, /Store\.api\("notify_update"/);
  assert.match(backend, /const allowedEvents = \["proposal", "progress", "status", "finished_art", "manual"\]/);
});


test("payment status changes trigger client-only email notifications", () => {
  assert.match(html, /n\.payment !== \(t\?\.payment \|\| d\.payment\)/);
});


test("Creator request list exposes per-client email and delete actions", () => {
  const start = html.indexOf("function OrdersPanel()");
  const end = html.indexOf("function ReviewsPanel()", start);
  const panel = html.slice(start, end);
  assert.match(panel, /emailClient\(o\)/);
  assert.match(panel, /"Send email"/);
  assert.match(panel, /deleteClientOrder\(o\)/);
  assert.match(panel, /"Delete"/);
  assert.match(panel, /notify_update/);
  assert.match(panel, /window\.confirm/);
});

test("client tracking separates proposal, payment, messages, and final delivery", () => {
  const start = html.indexOf("function Track()");
  const end = html.indexOf("/* ---- creator:", start);
  const track = html.slice(start, end);
  for (const section of ["01 · PRICE & PROPOSAL", "02 · PAYMENT", "03 · COMMUNICATION", "04 · DELIVERY"]) {
    assert.ok(track.includes(section), "missing tracking section: " + section);
  }
  assert.match(track, /updates\.slice\(\)\.sort/);
  assert.match(track, /Final artwork and download links will appear here/);
});


test("Track Order overview uses responsive non-overlapping status layout", () => {
  const start = html.indexOf("ORDER OVERVIEW");
  const end = html.indexOf("01 · PRICE & PROPOSAL", start);
  const overview = html.slice(start, end);
  assert.match(overview, /track-overview-head/);
  assert.match(overview, /track-overview-badges/);
  assert.match(overview, /track-overview-stages/);
  assert.match(html, /\.track-overview-stages\{display:grid;grid-template-columns:repeat\(4,minmax\(0,1fr\)\)/);
  assert.match(html, /@media\(max-width:1023px\)[\s\S]*?\.track-overview-stages\{grid-template-columns:repeat\(3,minmax\(0,1fr\)\)/);
  assert.match(html, /@media\(max-width:767px\)[\s\S]*?\.track-overview-stages\{grid-template-columns:repeat\(2,minmax\(0,1fr\)\)/);
  assert.match(html, /\.track-overview-badges \.tag\{display:inline-flex/);
  assert.match(html, /\.track-overview-stages \.stage:last-child\{grid-column:1\/-1;width:calc/);
});


test("Track Order highlights only the active commission step in gold", () => {
  const start = html.indexOf("ORDER OVERVIEW");
  const end = html.indexOf("01 · PRICE & PROPOSAL", start);
  const overview = html.slice(start, end);
  assert.match(overview, /i === idx \? " is-active" : ""/);
  assert.match(html, /\.track-overview-stages \.stage\.is-active[\s\S]*?background:var\(--gold\)/);
  assert.match(html, /\.track-overview-stages \.stage,[\s\S]*?background:var\(--cyan\)/);
  assert.doesNotMatch(overview, /i\s*<=\s*idx/);
});

test("manual email validates client delivery result and reports mail-service acceptance accurately", () => {
  assert.match(html, /clientResult = result\.notifications\.find/);
  assert.match(html, /if \(!clientResult\) throw new Error/);
  assert.match(html, /Inbox delivery is not guaranteed/);
  assert.match(backend, /no valid client email address/);
  assert.match(backend, /clientNotification/);
});


test("commission state writes use a server-side atomic path and never upsert private order_tracks from the browser", () => {
  assert.match(html, /saveCommissionState\(order, track\)/);
  assert.match(html, /Direct browser writes to order_tracks are disabled/);
  assert.match(html, /this\.api\("creator_save_commission"/);
  assert.doesNotMatch(html, /from\("order_tracks"\)\.upsert/);
  assert.match(backend, /action === "creator_save_commission"/);
  assert.match(backend, /db\.rpc\("sync_commission_state"/);
  assert.match(backend, /p_track_patch: patch/);
});

test("commission sync migration preserves emailHash and synchronizes request, management, and tracking", () => {
  const migration = readFileSync(new URL("../supabase/migrations/202611200002_commission_state_sync.sql", import.meta.url), "utf8");
  assert.match(migration, /p_track_patch \? 'emailHash'/);
  assert.match(migration, /update public\.commission_requests/);
  assert.match(migration, /insert into public\.commission_management/);
  assert.match(migration, /update public\.order_tracks/);
  assert.match(migration, /revoke all on function public\.sync_commission_state/);
  assert.match(migration, /grant execute on function public\.sync_commission_state[\s\S]*to service_role/);
});

test("commission payment/status save completes before email and email failures do not undo saved tracking", () => {
  const saveStart = html.indexOf("const save = async (extra, eventType, eventMessage)");
  const saveEnd = html.indexOf("const sendProposal", saveStart);
  const saveBlock = html.slice(saveStart, saveEnd);
  assert.ok(saveBlock.indexOf("Store.saveCommissionState") < saveBlock.indexOf("await notify"));
  assert.match(saveBlock, /Changes saved and tracking updated, but the email notification failed/);
  assert.match(backend, /p_payment: payment/);
});

test("client proposal response synchronizes all commission state tables", () => {
  const start = backend.indexOf('if (action === "respond")');
  const end = backend.indexOf('if (action === "upload")', start);
  const block = backend.slice(start, end);
  assert.match(block, /sync_commission_state/);
  assert.doesNotMatch(block, /from\("order_tracks"\)\s*\.update/);
});

test("completed commission review is linked to the same tracked commission", () => {
  const start = html.indexOf("function Track()");
  const end = html.indexOf("/* ---- creator:", start);
  const track = html.slice(start, end);
  assert.match(track, /t\.status==="Completed"/);
  assert.match(track, /Store\.api\("submit_review"/);
  assert.match(backend, /track\.status !== "Completed"/);
  assert.match(backend, /commission_id: id/);
});


test("marking payment Paid advances an Awaiting Payment commission to Paid for client tracking", () => {
  assert.match(html, /n\.payment === "Paid" && n\.status === "Awaiting Payment"\) n\.status = "Paid"/);
  assert.match(backend, /payment === "Paid" && requestedStatus === "Awaiting Payment" \? "Paid"/);
  assert.match(migration, /p_payment = 'Paid' and p_status = 'Awaiting Payment' then 'Paid'/);
});


test("finished art cannot persist browser blob URLs and must use permanent Storage paths", () => {
  assert.match(html, /legacy local previews/);
  assert.match(html, /persistentFiles = \(tr\.finalFiles \|\| \[\]\)\.filter/);
  assert.match(html, /Re-upload every artwork file before delivery/);
  assert.match(backend, /Every Finished Art file must be uploaded to permanent Storage/);
  assert.match(backend, /file\.url && String\(file\.url\)\.startsWith\("blob:"\)/);
  assert.match(backend, /eventType === "finished_art"[\s\S]*?permanent Storage/);
});

test("legacy local preview URLs are never exposed as client delivery URLs", () => {
  assert.match(backend, /file\.path\.startsWith\("incoming\/"\)/);
  assert.match(backend, /unavailable: true/);
});

test("Creator image uploads use authenticated permanent Supabase Storage, not Artifact blobs or base64", () => {
  assert.match(html, /Store\.api\("portfolio_upload"/);
  assert.match(html, /return result\.url/);
  assert.doesNotMatch(html, /async function storeImage\(file, maxDim = 1800\)[\s\S]{0,700}assets\.upload/);
  assert.match(backend, /if \(action === "portfolio_upload"\)/);
  assert.match(backend, /await requireOwner\(req, db\)/);
  assert.match(backend, /createBucket\(bucketName,[\s\S]*?public: true/);
  assert.match(backend, /getPublicUrl\(path\)/);
  assert.match(backend, /owner\.user\.id \+ "\/" \+ crypto\.randomUUID\(\)/);
});


test("commission services support independent add/delete and persist through the existing site publisher", () => {
  const start = html.indexOf("function ServicesPanel()");
  const end = html.indexOf("function ListEditor(", start);
  const panel = html.slice(start, end);
  assert.match(panel, /n\.services\.push/);
  assert.match(panel, /ConfirmDelete onYes=\{\(\) => upd\(\(n\) => \{ n\.services\.splice\(i, 1\)/);
  assert.match(panel, /Cover image \(shown on service card\)/);
  assert.match(panel, /Detail gallery/);
  assert.match(panel, /n\.services\[i\]\.gallery/);
  assert.match(panel, /External booking URL/);
  assert.match(html, /return Store\.api\("save_site", \{ site \}, true\)/);
});

test("service detail uses a swipeable gallery while service cards retain one cover image", () => {
  const start = html.indexOf("function Services({ go })");
  const end = html.indexOf("/* ---- visitor: request form */", start);
  const publicServices = html.slice(start, end);
  assert.match(publicServices, /className="service-gallery-track"/);
  assert.match(publicServices, /scroll-snap-type:x mandatory/);
  assert.match(publicServices, /service-gallery-thumbs/);
  assert.match(publicServices, /service-gallery-dots/);
  assert.match(publicServices, /images=\{gallery\}/);
  assert.match(publicServices, /safeImg\(s\.image\)/);
  assert.match(publicServices, /go\("service-" \+ s\.id\)/);
  assert.match(publicServices, /go\("order-" \+ s\.id\)/);
});

test("service detail exposes deliverables, turnaround, usage terms and service-specific booking", () => {
  const start = html.indexOf("function ServiceDetail({ id, go })");
  const end = html.indexOf("/* ---- visitor: request form */", start);
  const detail = html.slice(start, end);
  for (const field of ["Deliverables", "Estimated turnaround", "Usage / license", "x.usageTerms", "x.serviceTerms", "bookingUrl"]) {
    assert.ok(detail.includes(field), "missing service detail field: " + field);
  }
  assert.match(detail, /href=\{bookingUrl\}/);
  assert.match(detail, /go\("order-" \+ s\.id\)/);
});


test("commission email includes meaningful plain text alongside HTML", () => {
  assert.match(backend, /function commissionEmailText\\(/);
  assert.match(backend, /function orderUpdateEmailText\\(/);
  assert.match(backend, /text: commissionEmailText\\(order, clientName\\)/);
  assert.match(backend, /text: orderUpdateEmailText\\(order, track, eventType, message\\)/);
  assert.match(backend, /text: clean\\(input\\.text, 20000\\)/);
});

test("Apps Script validates plain text, checks quota and logs privacy-safe send diagnostics", () => {
  const gas = readFileSync(new URL("../supabase/apps-script/Code.gs", import.meta.url), "utf8");
  assert.match(gas, /const text = String\\(payload\\.text \\|\\| ""\\)\\.trim\\(\\)/);
  assert.match(gas, /MailApp\\.getRemainingDailyQuota\\(\\)/);
  assert.match(gas, /recipientMasked: maskEmail\\(to\\)/);
  assert.match(gas, /recipientDomain: to\\.split\\("@">\\)\\[1\\]/);
  assert.match(gas, /function maskEmail\\(/);
});

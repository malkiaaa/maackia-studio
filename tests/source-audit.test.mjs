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

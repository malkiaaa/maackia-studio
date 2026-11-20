import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
const backend = readFileSync(new URL("../supabase/functions/commission-api/index.ts", import.meta.url), "utf8");
const reviewMigration = readFileSync(new URL("../supabase/migrations/202611190001_client_reviews.sql", import.meta.url), "utf8");

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
  assert.equal(result.total, 3900);
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

import assert from "node:assert/strict";
import { test } from "node:test";
import { normalizeSite } from "../dist/client.js";
import { comparisonRange, formatDate, resolveRange, todayPT } from "../dist/dates.js";
import { parseFilter, parseFilters } from "../dist/filter.js";
import { buildQueryOptions } from "../dist/query.js";

// 2026-06-15 03:00 UTC is still 2026-06-14 in Pacific Time.
const NOW = new Date("2026-06-15T03:00:00Z");
const range = (spec) => {
  const r = resolveRange(spec, NOW);
  return [formatDate(r.start), formatDate(r.end)];
};

test("todayPT uses Pacific Time, not UTC", () => {
  assert.equal(formatDate(todayPT(NOW)), "2026-06-14");
});

test("resolveRange", () => {
  assert.deepEqual(range({}), ["2026-05-15", "2026-06-11"]); // last_28d, lag 3
  assert.deepEqual(range({ lagDays: 0, preset: "last_7d" }), ["2026-06-08", "2026-06-14"]);
  assert.deepEqual(range({ preset: "last_month" }), ["2026-05-01", "2026-05-31"]);
  assert.deepEqual(range({ preset: "this_month" }), ["2026-06-01", "2026-06-11"]);
  assert.deepEqual(range({ preset: "last_3m" }), ["2026-03-12", "2026-06-11"]);
  assert.deepEqual(range({ preset: "today" }), ["2026-06-14", "2026-06-14"]);
  assert.deepEqual(range({ days: 7 }), ["2026-06-05", "2026-06-11"]);
  assert.deepEqual(range({ days: 7, end: "2026-06-30" }), ["2026-06-24", "2026-06-30"]);
  // explicit start wins over days and preset
  assert.deepEqual(range({ start: "2026-06-01", end: "2026-06-30", days: 3, preset: "today" }), [
    "2026-06-01",
    "2026-06-30",
  ]);
  assert.throws(() => range({ start: "2026-06-12" }), /より後/);
  assert.throws(() => range({ start: "2026-02-31" }), /YYYY-MM-DD/);
  assert.throws(() => range({ preset: "nope" }), /不明な preset/);
});

test("comparisonRange", () => {
  const r = resolveRange({ start: "2026-06-01", end: "2026-06-07" }, NOW);
  const prev = comparisonRange(r, "previous");
  assert.deepEqual([formatDate(prev.start), formatDate(prev.end)], ["2026-05-25", "2026-05-31"]);
  const year = comparisonRange(r, "year");
  assert.deepEqual([formatDate(year.start), formatDate(year.end)], ["2025-06-02", "2025-06-08"]);
});

test("normalizeSite", () => {
  assert.equal(normalizeSite("example.com"), "sc-domain:example.com");
  assert.equal(normalizeSite("example.com/"), "sc-domain:example.com");
  assert.equal(normalizeSite("sc-domain:example.com"), "sc-domain:example.com");
  assert.equal(normalizeSite("https://example.com"), "https://example.com/");
  assert.equal(normalizeSite(" https://example.com/ "), "https://example.com/");
});

test("parseFilter", () => {
  assert.deepEqual(parseFilter("page~~/blog/"), { dimension: "PAGE", operator: "CONTAINS", expression: "/blog/" });
  assert.deepEqual(parseFilter("query!~ブランド名"), {
    dimension: "QUERY",
    operator: "NOT_CONTAINS",
    expression: "ブランド名",
  });
  assert.deepEqual(parseFilter("device == MOBILE"), { dimension: "DEVICE", operator: "EQUALS", expression: "MOBILE" });
  // operator-like characters inside the value belong to the value
  assert.deepEqual(parseFilter("page~*^https://a\\.jp/(x|y)==1"), {
    dimension: "PAGE",
    operator: "INCLUDING_REGEX",
    expression: "^https://a\\.jp/(x|y)==1",
  });
  assert.throws(() => parseFilter("page"), /演算子がありません/);
  assert.throws(() => parseFilter("date==2026-01-01"), /フィルタできません/);
  assert.throws(() => parseFilter("page~~"), /値がありません/);
  assert.equal(parseFilters([]), undefined);
  assert.equal(parseFilters(["page~~a", "page~~b"], "or")[0].groupType, "OR");
});

test("buildQueryOptions requires hourly_all for hour", () => {
  const base = { site: "sc-domain:example.com", range: {}, limit: 10 };
  assert.throws(() => buildQueryOptions({ ...base, dimensions: ["hour"] }), /hourly_all/);
  const o = buildQueryOptions({ ...base, dimensions: ["hour"], dataState: "hourly_all" }, NOW);
  assert.deepEqual(o.dimensions, ["HOUR"]);
  assert.equal(o.dataState, "HOURLY_ALL");
});

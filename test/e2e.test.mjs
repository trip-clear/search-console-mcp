// Drives the MCP server through an in-memory transport against a stub HTTP
// server, so nothing here touches the real API.
import assert from "node:assert/strict";
import { createServer as createHttpServer } from "node:http";
import { after, before, test } from "node:test";
import { Client as McpClient } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Client } from "../dist/client.js";
import { createServer } from "../dist/server.js";

const SITE = "sc-domain:example.com";
const requests = [];
let http;
let endpoint;

// 5 rows per query; the stub serves them page by page.
const ROWS = ["a", "b", "c", "d", "e"].map((q, i) => ({
  keys: [q],
  clicks: 50 - i * 10,
  impressions: 1000,
  ctr: (50 - i * 10) / 1000,
  position: i + 1,
}));

function handle(req, body) {
  const path = decodeURIComponent(req.url);
  if (req.headers.authorization !== "Bearer test-token") return [401, { error: { message: "bad token" } }];
  if (req.method === "GET" && path === "/webmasters/v3/sites") {
    return [200, { siteEntry: [{ siteUrl: SITE, permissionLevel: "siteOwner" }] }];
  }
  if (path === `/webmasters/v3/sites/${SITE}/searchAnalytics/query`) {
    if (!body.dimensions?.length) {
      return [200, { rows: [{ clicks: 150, impressions: 5000, ctr: 0.03, position: 3 }] }];
    }
    if (body.startDate < "2026-06-01") {
      // previous period: "a" halved, "e" missing, "z" only here
      const prev = [
        { keys: ["a"], clicks: 25, impressions: 500, ctr: 0.05, position: 4 },
        { keys: ["z"], clicks: 5, impressions: 100, ctr: 0.05, position: 9 },
      ];
      return [200, { rows: prev.slice(body.startRow, body.startRow + body.rowLimit) }];
    }
    return [200, { rows: ROWS.slice(body.startRow, body.startRow + body.rowLimit) }];
  }
  if (req.method === "POST" && path === "/v1/urlInspection/index:inspect") {
    if (body.inspectionUrl.endsWith("/forbidden")) return [403, { error: { message: "no access" } }];
    return [200, { inspectionResult: { indexStatusResult: { verdict: "PASS", coverageState: "Indexed" } } }];
  }
  if (path === `/webmasters/v3/sites/${SITE}/sitemaps`) {
    return [
      200,
      { sitemap: [{ path: "https://example.com/sitemap.xml", errors: "0", warnings: "2", contents: [{ type: "web", submitted: "10", indexed: "7" }] }] },
    ];
  }
  if (req.method === "PUT" && path === `/webmasters/v3/sites/${SITE}/sitemaps/https://example.com/sitemap.xml`) {
    return [204, undefined];
  }
  return [404, { error: { message: `not found: ${req.method} ${path}` } }];
}

before(async () => {
  http = createHttpServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const body = raw ? JSON.parse(raw) : undefined;
      requests.push({ method: req.method, url: req.url, body });
      const [status, payload] = handle(req, body);
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(payload === undefined ? "" : JSON.stringify(payload));
    });
  });
  await new Promise((r) => http.listen(0, "127.0.0.1", r));
  endpoint = `http://127.0.0.1:${http.address().port}`;
});

after(() => http.close());

async function connect({ readOnly = false, pageSize, defaultSite = "example.com" } = {}) {
  const server = createServer({
    version: "test",
    getClient: async () =>
      new Client({
        headers: async () => ({ Authorization: "Bearer test-token" }),
        userAgent: "test",
        endpoint,
        pageSize,
      }),
    authStatus: async () => ({ kind: "oauth", detail: "stub", token: "ok" }),
    defaultSite,
    readOnly,
  });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new McpClient({ name: "test", version: "0" });
  await Promise.all([server.connect(a), client.connect(b)]);
  return client;
}

async function call(client, name, args = {}) {
  const res = await client.callTool({ name, arguments: args });
  const text = res.content[0].text;
  return res.isError ? { error: text } : JSON.parse(text);
}

test("tool list honours read-only mode", async () => {
  const names = async (c) => (await c.listTools()).tools.map((t) => t.name).sort();
  const all = await names(await connect());
  assert.deepEqual(all, [
    "auth_status",
    "inspect",
    "query",
    "sitemaps_delete",
    "sitemaps_get",
    "sitemaps_list",
    "sitemaps_submit",
    "sites_add",
    "sites_delete",
    "sites_get",
    "sites_list",
  ]);
  const ro = await names(await connect({ readOnly: true }));
  assert.ok(!ro.some((n) => /submit|delete|add/.test(n)));
  assert.ok(ro.includes("query"));
});

test("sites_list", async () => {
  const out = await call(await connect(), "sites_list");
  assert.deepEqual(out, { sites: [{ site_url: SITE, permission_level: "siteOwner" }] });
});

test("query without dimensions returns the aggregate row", async () => {
  const out = await call(await connect(), "query", { start_date: "2026-06-01", end_date: "2026-06-07" });
  assert.equal(out.site, SITE);
  assert.deepEqual(out.range, { start: "2026-06-01", end: "2026-06-07", days: 7 });
  assert.deepEqual(out.rows, [{ clicks: 150, impressions: 5000, ctr: 0.03, position: 3 }]);
});

test("query paginates and stops at limit", async () => {
  const c = await connect({ pageSize: 2 });
  const args = { dimensions: ["query"], start_date: "2026-06-01", end_date: "2026-06-07" };

  requests.length = 0;
  const all = await call(c, "query", { ...args, limit: 0 });
  assert.deepEqual(all.rows.map((r) => r.query), ["a", "b", "c", "d", "e"]);
  assert.deepEqual(requests.map((r) => [r.body.startRow, r.body.rowLimit]), [[0, 2], [2, 2], [4, 2]]);
  assert.equal(all.totals.clicks, 150);
  assert.equal(all.totals.position, 3); // impression-weighted
  assert.equal(all.notes, undefined);

  requests.length = 0;
  const some = await call(c, "query", { ...args, limit: 3, filters: ["page~~/blog/"] });
  assert.equal(some.rows.length, 3);
  assert.deepEqual(requests.map((r) => [r.body.startRow, r.body.rowLimit]), [[0, 2], [2, 1]]);
  assert.deepEqual(requests[0].body.dimensionFilterGroups, [
    { groupType: "AND", filters: [{ dimension: "PAGE", operator: "CONTAINS", expression: "/blog/" }] },
  ]);
  assert.match(some.notes[0], /limit=3/);
});

test("query compare joins both periods", async () => {
  const out = await call(await connect(), "query", {
    dimensions: ["query"],
    start_date: "2026-06-01",
    end_date: "2026-06-07",
    compare: "previous",
  });
  assert.deepEqual(out.compare_range, { start: "2026-05-25", end: "2026-05-31" });
  const byQuery = Object.fromEntries(out.rows.map((r) => [r.query, r]));
  assert.equal(byQuery.a.clicks_delta, 25);
  assert.equal(byQuery.a.position_gain, 3); // 4 -> 1
  assert.equal(byQuery.e.clicks_prev, 0);
  assert.equal(byQuery.e.position_gain, undefined); // new this period
  assert.equal(byQuery.z.clicks, 0); // lost all traffic, still listed
  assert.equal(out.rows.at(-1).query, "z");
  assert.equal(out.totals_previous.clicks, 30);
});

test("query rejects bad input as a tool error", async () => {
  const c = await connect();
  assert.match((await call(c, "query", { dimensions: ["date"], compare: "previous" })).error, /併用できません/);
  assert.match((await call(c, "query", { filters: ["page"] })).error, /演算子/);
  const noSite = await connect({ defaultSite: "" });
  assert.match((await call(noSite, "query")).error, /対象プロパティが未指定/);
});

test("inspect keeps going when one URL fails", async () => {
  const out = await call(await connect(), "inspect", {
    urls: ["https://example.com/ok", "https://example.com/forbidden"],
  });
  assert.equal(out.results[0].index_status.verdict, "PASS");
  assert.match(out.results[1].error, /no access \(HTTP 403\)/);
  assert.match(out.results[1].error, /ユーザーと権限/);
});

test("sitemaps", async () => {
  const c = await connect();
  const list = await call(c, "sitemaps_list");
  assert.equal(list.sitemaps[0].warnings, 2);
  assert.deepEqual(list.sitemaps[0].contents, [{ type: "web", submitted: 10, indexed: 7 }]);
  const sub = await call(c, "sitemaps_submit", { sitemap_url: "https://example.com/sitemap.xml" });
  assert.equal(sub.submitted, "https://example.com/sitemap.xml");
});

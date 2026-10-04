import { DataRow, QueryOptions } from "./client.js";
import { DateRange, RangeSpec, formatDate, rangeDays, resolveRange } from "./dates.js";
import { parseAggregation, parseDataState, parseDimensions, parseFilters, parseType } from "./filter.js";

export interface QueryInput {
  site: string;
  dimensions?: string[];
  filters?: string[];
  filterGroupType?: string;
  type?: string;
  dataState?: string;
  aggregation?: string;
  range: RangeSpec;
  limit: number;
}

export function buildQueryOptions(i: QueryInput, now: Date = new Date()): QueryOptions {
  if (i.limit < 0) throw new Error("limit は 0 以上にしてください（0 = 全件）");

  const dimensions = parseDimensions(i.dimensions ?? []);
  const filterGroups = parseFilters(i.filters ?? [], i.filterGroupType);
  const type = parseType(i.type ?? "web");
  const dataState = parseDataState(i.dataState ?? "final");
  const aggregation = parseAggregation(i.aggregation ?? "auto");
  const range = resolveRange(i.range, now);

  // The API rejects HOUR unless the data state asks for hourly data; catching
  // it here gives a better message than a bare 400.
  if (dimensions.includes("HOUR") && dataState !== "HOURLY_ALL") {
    throw new Error(
      "dimensions の hour は data_state=hourly_all と一緒に使ってください（時間別データは直近10日分のみ）",
    );
  }

  return { site: i.site, range, dimensions, filterGroups, type, dataState, aggregation, limit: i.limit };
}

// assertComparable rejects comparisons that cannot be joined. Two periods
// never share a date key, so every row would show up twice with a zero on one
// side.
export function assertComparable(o: QueryOptions): void {
  if (o.dimensions.includes("DATE") || o.dimensions.includes("HOUR")) {
    throw new Error(
      "compare は date / hour ディメンションと併用できません（期間合計の比較は dimensions なし、内訳の比較は query/page/country/device で）",
    );
  }
}

// ---- single-period output ----

export function plainResult(o: QueryOptions, rows: DataRow[]): Record<string, unknown> {
  return {
    ...header(o),
    rows: rows.map((r) => ({ ...keysOf(o, r.keys), ...metrics(r) })),
    totals: totalsJSON(totalOf(rows), rows.length),
    ...notes(o, rows.length),
  };
}

// ---- comparison output ----

const EMPTY: DataRow = { clicks: 0, impressions: 0, ctr: 0, position: 0 };

export function compareResult(
  o: QueryOptions,
  prevRange: DateRange,
  current: DataRow[],
  previous: DataRow[],
): Record<string, unknown> {
  const byKey = new Map<string, { keys?: string[]; cur: DataRow; prev: DataRow }>();
  const get = (r: DataRow) => {
    const k = (r.keys ?? []).join("\x00");
    let p = byKey.get(k);
    if (!p) byKey.set(k, (p = { keys: r.keys, cur: EMPTY, prev: EMPTY }));
    return p;
  };
  for (const r of current) get(r).cur = r;
  // Rows that exist only in the previous period are kept on purpose: a query
  // that lost all its traffic is exactly what a report needs to surface.
  for (const r of previous) get(r).prev = r;

  const pairs = [...byKey.values()].sort(
    (a, b) =>
      b.cur.clicks - a.cur.clicks || b.cur.impressions - a.cur.impressions || b.prev.clicks - a.prev.clicks,
  );

  return {
    ...header(o),
    compare_range: rangeJSON(prevRange),
    rows: pairs.map((p) => ({
      ...keysOf(o, p.keys),
      clicks: p.cur.clicks,
      clicks_prev: p.prev.clicks,
      clicks_delta: p.cur.clicks - p.prev.clicks,
      impressions: p.cur.impressions,
      impressions_prev: p.prev.impressions,
      impressions_delta: p.cur.impressions - p.prev.impressions,
      ctr: round(p.cur.ctr, 4),
      ctr_prev: round(p.prev.ctr, 4),
      position: round(p.cur.position, 2),
      position_prev: round(p.prev.position, 2),
      ...positionGain(p.cur, p.prev),
    })),
    totals: totalsJSON(totalOf(current), current.length),
    totals_previous: totalsJSON(totalOf(previous), previous.length),
    ...notes(o, Math.max(current.length, previous.length)),
  };
}

// positionGain is how many ranks the row climbed (+3 = moved up 3 places). It
// is only reported when the row was actually shown in both periods: a query
// that is new this month has no previous position, and subtracting from a zero
// would report it as a catastrophic drop from rank 0 rather than as new.
function positionGain(cur: DataRow, prev: DataRow): { position_gain?: number } {
  if (cur.impressions === 0 || prev.impressions === 0) return {};
  return { position_gain: round(prev.position - cur.position, 2) };
}

// ---- helpers ----

function header(o: QueryOptions): Record<string, unknown> {
  return {
    site: o.site,
    range: { ...rangeJSON(o.range), days: rangeDays(o.range) },
    dimensions: o.dimensions.map(dimLabel),
    type: o.type.toLowerCase(),
  };
}

function notes(o: QueryOptions, fetched: number): { notes?: string[] } {
  const out: string[] = [];
  if (o.dataState === "ALL" || o.dataState === "HOURLY_ALL") out.push("未確定データを含む");
  if (o.limit > 0 && fetched >= o.limit) {
    out.push(`limit=${o.limit} で打ち切り。続きがある可能性あり（totals は取得した行の合計。limit を増やすか 0 で全件）`);
  }
  return out.length ? { notes: out } : {};
}

function rangeJSON(r: DateRange): { start: string; end: string } {
  return { start: formatDate(r.start), end: formatDate(r.end) };
}

function keysOf(o: QueryOptions, keys?: string[]): Record<string, string> {
  return Object.fromEntries(o.dimensions.map((d, i) => [dimLabel(d), keys?.[i] ?? ""]));
}

function metrics(r: DataRow) {
  return { clicks: r.clicks, impressions: r.impressions, ctr: round(r.ctr, 4), position: round(r.position, 2) };
}

// totalOf sums the returned rows. CTR and position are recomputed rather than
// averaged: position is weighted by impressions, which is how Search Console
// aggregates it.
function totalOf(rows: DataRow[]): DataRow {
  const t: DataRow = { clicks: 0, impressions: 0, ctr: 0, position: 0 };
  let weighted = 0;
  for (const r of rows) {
    t.clicks += r.clicks;
    t.impressions += r.impressions;
    weighted += r.position * r.impressions;
  }
  if (t.impressions > 0) {
    t.ctr = t.clicks / t.impressions;
    t.position = weighted / t.impressions;
  }
  return t;
}

function totalsJSON(t: DataRow, rowCount: number) {
  return { ...metrics(t), row_count: rowCount };
}

function dimLabel(d: string): string {
  return d === "SEARCH_APPEARANCE" ? "searchAppearance" : d.toLowerCase();
}

// round trims float noise (0.07619047619047619) that would only cost tokens.
function round(v: number, digits: number): number {
  const f = 10 ** digits;
  return Math.round(v * f) / f;
}

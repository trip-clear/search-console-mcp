export interface DimensionFilter {
  dimension: string;
  operator: string;
  expression: string;
}

export interface FilterGroup {
  groupType: string;
  filters: DimensionFilter[];
}

// Dimension names accepted from the caller, mapped to the API enum.
const dimensions: Record<string, string> = {
  query: "QUERY",
  page: "PAGE",
  country: "COUNTRY",
  device: "DEVICE",
  date: "DATE",
  hour: "HOUR",
  searchappearance: "SEARCH_APPEARANCE",
  search_appearance: "SEARCH_APPEARANCE",
  appearance: "SEARCH_APPEARANCE",
};

export function parseDimension(s: string): string {
  const d = dimensions[s.trim().toLowerCase()];
  if (!d) {
    throw new Error(
      `不明なディメンション "${s}"（有効: query, page, country, device, date, hour, searchAppearance）`,
    );
  }
  return d;
}

// parseDimensions preserves order (the order decides the grouping order of the
// result rows).
export function parseDimensions(names: string[]): string[] {
  return names.filter((n) => n !== "").map(parseDimension);
}

// Operators of the filter mini-language.
const filterOps: { token: string; op: string }[] = [
  { token: "==", op: "EQUALS" },
  { token: "!=", op: "NOT_EQUALS" },
  { token: "~~", op: "CONTAINS" },
  { token: "!~", op: "NOT_CONTAINS" },
  { token: "~*", op: "INCLUDING_REGEX" },
  { token: "!*", op: "EXCLUDING_REGEX" },
];

// parseFilter parses one filter expression: <dimension><op><value>.
//
//   page~~/blog/          page contains "/blog/"
//   query!~ブランド名       query does not contain "ブランド名"
//   device==MOBILE        device equals MOBILE
//   page~*^https://a\.jp  page matches the RE2 regex
export function parseFilter(expr: string): DimensionFilter {
  // Find the operator that appears earliest; a value may itself contain
  // operator-like characters (e.g. a regex), so only the first one counts.
  let best: (typeof filterOps)[number] | undefined;
  let bestIdx = expr.length;
  for (const o of filterOps) {
    const idx = expr.indexOf(o.token);
    if (idx >= 0 && idx < bestIdx) {
      best = o;
      bestIdx = idx;
    }
  }
  if (!best) {
    throw new Error(
      `フィルタ "${expr}" に演算子がありません（== 一致 / != 不一致 / ~~ 含む / !~ 含まない / ~* 正規表現 / !* 正規表現で除外）`,
    );
  }

  const dimName = expr.slice(0, bestIdx).trim();
  const value = expr.slice(bestIdx + best.token.length).trim();
  if (!dimName) throw new Error(`フィルタ "${expr}" の "${best.token}" の前にディメンションがありません`);
  if (!value) throw new Error(`フィルタ "${expr}" の "${best.token}" の後に値がありません`);

  let dim: string;
  try {
    dim = parseDimension(dimName);
  } catch (e) {
    throw new Error(`フィルタ "${expr}": ${(e as Error).message}`);
  }
  // The API only filters on these five; date/hour are narrowed with the date
  // range parameters instead.
  if (!["QUERY", "PAGE", "COUNTRY", "DEVICE", "SEARCH_APPEARANCE"].includes(dim)) {
    throw new Error(
      `フィルタ "${expr}": ${dimName} ではフィルタできません（日付の絞り込みは start_date/end_date を使う）`,
    );
  }

  return { dimension: dim, operator: best.op, expression: value };
}

// parseFilters parses every filter into a single filter group. groupType is
// "and" (all filters must match) or "or" (any).
export function parseFilters(exprs: string[], groupType = "and"): FilterGroup[] | undefined {
  if (exprs.length === 0) return undefined;
  let gt: string;
  switch (groupType.toLowerCase()) {
    case "":
    case "and":
      gt = "AND";
      break;
    case "or":
      gt = "OR";
      break;
    default:
      throw new Error(`不明な filter_group_type "${groupType}"（有効: and, or）`);
  }
  return [{ groupType: gt, filters: exprs.map(parseFilter) }];
}

const searchTypes: Record<string, string> = {
  web: "WEB",
  image: "IMAGE",
  video: "VIDEO",
  news: "NEWS",
  discover: "DISCOVER",
  googlenews: "GOOGLE_NEWS",
  google_news: "GOOGLE_NEWS",
};

export function parseType(s: string): string {
  const t = searchTypes[s.trim().toLowerCase()];
  if (!t) throw new Error(`不明な type "${s}"（有効: web, image, video, news, discover, googleNews）`);
  return t;
}

// "all" includes the most recent, still-partial days; "final" (the default)
// excludes them.
export function parseDataState(s: string): string {
  switch (s.trim().toLowerCase()) {
    case "":
    case "final":
    case "full":
      return "FINAL";
    case "all":
      return "ALL";
    case "hourly_all":
    case "hourly":
      return "HOURLY_ALL";
    default:
      throw new Error(`不明な data_state "${s}"（有効: final, all, hourly_all）`);
  }
}

export function parseAggregation(s: string): string {
  switch (s.trim().toLowerCase()) {
    case "":
    case "auto":
      return "AUTO";
    case "byproperty":
    case "by_property":
    case "property":
      return "BY_PROPERTY";
    case "bypage":
    case "by_page":
    case "page":
      return "BY_PAGE";
    default:
      throw new Error(`不明な aggregation "${s}"（有効: auto, byProperty, byPage）`);
  }
}

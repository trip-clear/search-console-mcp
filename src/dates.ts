// Days are represented as UTC-midnight timestamps of a calendar date. Only the
// calendar date matters to the API, so doing the arithmetic in UTC sidesteps
// DST entirely.

// DEFAULT_LAG_DAYS is how far back the most recent day of settled data is.
// Search Console finalises data with a 2-3 day delay; 3 keeps the last row of a
// report from being a partial day.
export const DEFAULT_LAG_DAYS = 3;

export interface DateRange {
  start: number;
  end: number;
}

export interface RangeSpec {
  start?: string; // YYYY-MM-DD; wins over preset
  end?: string; // YYYY-MM-DD
  days?: number; // last N days ending at end; wins over preset
  preset?: string; // see PRESET_NAMES
  lagDays?: number; // days of data-settling lag; DEFAULT_LAG_DAYS if undefined
}

const DAY_MS = 24 * 60 * 60 * 1000;

// Search Console reports in Pacific Time, so "today" must be computed there --
// using local time in Japan would ask for a day that does not exist yet and
// silently return an empty last row.
export function todayPT(now: Date = new Date()): number {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Los_Angeles",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const get = (type: string) => Number(parts.find((p) => p.type === type)!.value);
  return Date.UTC(get("year"), get("month") - 1, get("day"));
}

// addDate mirrors Go's time.AddDate: overflowing days roll into the next month.
function addDate(t: number, years: number, months: number, days: number): number {
  const d = new Date(t);
  return Date.UTC(d.getUTCFullYear() + years, d.getUTCMonth() + months, d.getUTCDate() + days);
}

function monthStart(t: number): number {
  const d = new Date(t);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
}

export function formatDate(t: number): string {
  return new Date(t).toISOString().slice(0, 10);
}

function parseDate(s: string): number | undefined {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return undefined;
  const t = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  // Reject dates that only parse because Date.UTC normalises them (2026-02-31).
  return formatDate(t) === s ? t : undefined;
}

export function rangeDays(r: DateRange): number {
  return Math.round((r.end - r.start) / DAY_MS) + 1;
}

export function rangeString(r: DateRange): string {
  return `${formatDate(r.start)} 〜 ${formatDate(r.end)}`;
}

type Preset = (latest: number, today: number) => [number, number];

// Each preset is resolved relative to the latest settled day (today in PT minus
// lag), except today/yesterday which are literal.
const presets: Record<string, Preset> = {
  today: (_l, t) => [t, t],
  yesterday: (_l, t) => [addDate(t, 0, 0, -1), addDate(t, 0, 0, -1)],
  latest: (l) => [l, l],
  last_7d: (l) => [addDate(l, 0, 0, -6), l],
  last_28d: (l) => [addDate(l, 0, 0, -27), l],
  last_30d: (l) => [addDate(l, 0, 0, -29), l],
  last_90d: (l) => [addDate(l, 0, 0, -89), l],
  last_3m: (l) => [addDate(l, 0, -3, 1), l],
  last_6m: (l) => [addDate(l, 0, -6, 1), l],
  last_12m: (l) => [addDate(l, 0, -12, 1), l],
  last_16m: (l) => [addDate(l, 0, -16, 1), l],
  this_month: (l) => [monthStart(l), l],
  last_month: (l) => {
    const start = addDate(monthStart(l), 0, -1, 0);
    return [start, addDate(start, 0, 1, -1)];
  },
};

export const PRESET_NAMES = Object.keys(presets);

// resolveRange turns a RangeSpec into concrete dates.
//
// Precedence: explicit start/end, then days, then preset, defaulting to
// last_28d (which is what the Search Console UI opens on).
export function resolveRange(s: RangeSpec, now: Date = new Date()): DateRange {
  const lag = s.lagDays ?? DEFAULT_LAG_DAYS;
  if (lag < 0) throw new Error("lag_days は0以上にしてください");
  const today = todayPT(now);
  const latest = addDate(today, 0, 0, -lag);

  let end = latest;
  if (s.end) {
    const t = parseDate(s.end);
    if (t === undefined) throw new Error(`end_date "${s.end}": YYYY-MM-DD 形式で指定してください`);
    end = t;
  }

  let start: number;
  if (s.start) {
    const t = parseDate(s.start);
    if (t === undefined) throw new Error(`start_date "${s.start}": YYYY-MM-DD 形式で指定してください`);
    start = t;
  } else if (s.days && s.days > 0) {
    start = addDate(end, 0, 0, -(s.days - 1));
  } else {
    const fn = presets[(s.preset || "last_28d").toLowerCase()];
    if (!fn) throw new Error(`不明な preset "${s.preset}"（有効: ${PRESET_NAMES.join(", ")}）`);
    const [ps, pe] = fn(latest, today);
    start = ps;
    if (!s.end) end = pe;
  }

  if (start > end) {
    throw new Error(`開始日 ${formatDate(start)} が終了日 ${formatDate(end)} より後です`);
  }
  return { start, end };
}

// comparisonRange returns the range to compare r against.
//
//   "previous" — the equally long window immediately before r.
//   "year"     — the same window 364 days earlier, which keeps weekdays aligned
//                (a Tuesday stays a Tuesday); search traffic is weekly-seasonal,
//                so this compares better than a literal calendar year.
export function comparisonRange(r: DateRange, mode: string): DateRange {
  switch (mode.toLowerCase()) {
    case "previous":
    case "prev": {
      const end = addDate(r.start, 0, 0, -1);
      return { start: addDate(end, 0, 0, -(rangeDays(r) - 1)), end };
    }
    case "year":
    case "yoy":
      return { start: addDate(r.start, 0, 0, -364), end: addDate(r.end, 0, 0, -364) };
    default:
      throw new Error(`不明な compare "${mode}"（有効: previous, year）`);
  }
}

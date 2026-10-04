// Wraps the Google Search Console API with the bits the MCP server needs:
// site-URL normalisation, transparent pagination, and actionable errors.

import { DateRange, formatDate } from "./dates.js";
import { FilterGroup } from "./filter.js";

// The API's hard cap on rowLimit for a single searchanalytics.query call.
const MAX_ROWS_PER_REQUEST = 25000;

const DEFAULT_ENDPOINT = "https://searchconsole.googleapis.com";

export type HeaderSource = () => Promise<Record<string, string>>;

export interface DataRow {
  keys?: string[];
  clicks: number;
  impressions: number;
  ctr: number;
  position: number;
}

export interface QueryOptions {
  site: string;
  range: DateRange;
  dimensions: string[];
  filterGroups?: FilterGroup[];
  type: string;
  dataState: string;
  aggregation: string;
  // limit caps the total number of rows. 0 means "every row the API will give
  // us", fetched page by page.
  limit: number;
}

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

// normalizeSite accepts the three ways people write a property and returns the
// exact string the API expects:
//
//   example.com           -> sc-domain:example.com   (Domain property)
//   sc-domain:example.com -> unchanged
//   https://example.com   -> https://example.com/    (URL-prefix property; the
//                                                     trailing slash is required)
export function normalizeSite(s: string): string {
  s = s.trim();
  if (s === "" || s.startsWith("sc-domain:")) return s;
  if (s.startsWith("http://") || s.startsWith("https://")) {
    return s.endsWith("/") ? s : s + "/";
  }
  return "sc-domain:" + s.replace(/\/$/, "");
}

export interface ClientOptions {
  headers: HeaderSource;
  userAgent: string;
  // endpoint points the client at a different API host (tests and debugging).
  endpoint?: string;
  // pageSize is overridable so tests can exercise the pagination loop without
  // generating 25,000 rows.
  pageSize?: number;
}

export class Client {
  private readonly endpoint: string;
  private readonly pageSize: number;

  constructor(private readonly opts: ClientOptions) {
    this.endpoint = (opts.endpoint || DEFAULT_ENDPOINT).replace(/\/+$/, "");
    this.pageSize = opts.pageSize ?? MAX_ROWS_PER_REQUEST;
  }

  // query runs a Search Analytics query, paginating until limit rows are
  // collected or the API runs out of rows.
  async query(o: QueryOptions): Promise<DataRow[]> {
    const rows: DataRow[] = [];
    for (let startRow = 0; ; ) {
      let pageSize = this.pageSize;
      if (o.limit > 0) pageSize = Math.min(pageSize, o.limit - rows.length);
      if (pageSize <= 0) break;

      const resp = await this.request<{ rows?: DataRow[] }>(
        "POST",
        `${sitePath(o.site)}/searchAnalytics/query`,
        o.site,
        {
          startDate: formatDate(o.range.start),
          endDate: formatDate(o.range.end),
          dimensions: o.dimensions,
          dimensionFilterGroups: o.filterGroups,
          type: o.type,
          dataState: o.dataState,
          aggregationType: o.aggregation,
          rowLimit: pageSize,
          startRow,
        },
      );
      const page = resp.rows ?? [];
      for (const r of page) {
        rows.push({
          keys: r.keys,
          clicks: r.clicks ?? 0,
          impressions: r.impressions ?? 0,
          ctr: r.ctr ?? 0,
          position: r.position ?? 0,
        });
      }

      // A short page means there is nothing left to fetch. Without any
      // dimensions the API returns a single aggregate row, which also stops
      // here.
      if (page.length < pageSize) break;
      startRow += page.length;
    }
    return rows;
  }

  // sites lists the properties the authenticated identity can see.
  async sites(): Promise<any[]> {
    const resp = await this.request<{ siteEntry?: any[] }>("GET", "/webmasters/v3/sites", "");
    return resp.siteEntry ?? [];
  }

  site(site: string): Promise<any> {
    return this.request("GET", sitePath(site), site);
  }

  // addSite claims a property for the authenticated identity. Verification
  // still has to happen in the Search Console UI.
  async addSite(site: string): Promise<void> {
    await this.request("PUT", sitePath(site), site);
  }

  async deleteSite(site: string): Promise<void> {
    await this.request("DELETE", sitePath(site), site);
  }

  async sitemaps(site: string): Promise<any[]> {
    const resp = await this.request<{ sitemap?: any[] }>("GET", `${sitePath(site)}/sitemaps`, site);
    return resp.sitemap ?? [];
  }

  // sitemap fetches one sitemap by its full URL (feedpath).
  sitemap(site: string, feedpath: string): Promise<any> {
    return this.request("GET", sitemapPath(site, feedpath), site);
  }

  // submitSitemap (re)submits a sitemap. Google fetches it asynchronously, so
  // a successful call only means it was accepted for processing.
  async submitSitemap(site: string, feedpath: string): Promise<void> {
    await this.request("PUT", sitemapPath(site, feedpath), site);
  }

  async deleteSitemap(site: string, feedpath: string): Promise<void> {
    await this.request("DELETE", sitemapPath(site, feedpath), site);
  }

  // inspect runs the URL Inspection API for one URL. The URL must belong to
  // the property. languageCode is a BCP-47 tag used for the human-readable
  // strings.
  async inspect(site: string, url: string, languageCode: string): Promise<any> {
    const resp = await this.request<{ inspectionResult?: any }>(
      "POST",
      "/v1/urlInspection/index:inspect",
      site,
      { siteUrl: site, inspectionUrl: url, languageCode },
    );
    return resp.inspectionResult ?? {};
  }

  private async request<T>(method: string, path: string, site: string, body?: unknown): Promise<T> {
    const headers: Record<string, string> = {
      ...(await this.opts.headers()),
      "User-Agent": this.opts.userAgent,
    };
    if (body !== undefined) headers["Content-Type"] = "application/json";

    const res = await fetch(this.endpoint + path, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    if (!res.ok) throw explain(res.status, errorMessage(text, res.statusText), site);
    return (text ? JSON.parse(text) : {}) as T;
  }
}

function sitePath(site: string): string {
  return `/webmasters/v3/sites/${encodeURIComponent(site)}`;
}

function sitemapPath(site: string, feedpath: string): string {
  return `${sitePath(site)}/sitemaps/${encodeURIComponent(feedpath)}`;
}

function errorMessage(body: string, fallback: string): string {
  try {
    const msg = JSON.parse(body)?.error?.message;
    if (typeof msg === "string" && msg) return msg;
  } catch {
    // not JSON; fall through to the raw body
  }
  return body.trim() || fallback;
}

// explain wraps an API error with the cause that actually applies to Search
// Console, so a 403 does not send the reader off to check IAM roles.
function explain(status: number, message: string, site: string): ApiError {
  let hint = "";
  switch (status) {
    case 401:
      hint = "認証情報が無効か失効しています。`npx @trip-clear/search-console-mcp login` をやり直してください。";
      break;
    case 403:
      hint = `このアカウントに "${site}" への権限がないか、Search Console API が有効化されていません。

  - プロパティ文字列が正確か確認する: sites_list ツール
    （ドメインプロパティは "sc-domain:example.com"、URLプレフィックスは
      "https://example.com/" と末尾スラッシュまで含めて別物）
  - サービスアカウントの場合: Search Console の「設定 > ユーザーと権限」で
    そのサービスアカウントのメールアドレスをユーザー追加する
  - API の有効化: https://console.cloud.google.com/apis/library/searchconsole.googleapis.com`;
      break;
    case 429:
      hint =
        "クォータ超過です。Search Console の上限は 1プロパティあたり約1,200クエリ/分、URL検査は2,000件/日。間隔を空けるか対象を絞ってください。";
      break;
    case 400:
      hint =
        "リクエストが拒否されました。ディメンション/フィルタ/期間の組み合わせを確認してください（例: dimensions の hour は data_state=hourly_all が必須、aggregation=byProperty は page ディメンション/フィルタと併用不可）。";
      break;
  }
  const text = `${message} (HTTP ${status})`;
  return new ApiError(hint ? `${text}\n\n${hint}` : text, status);
}

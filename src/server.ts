import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { Client, normalizeSite } from "./client.js";
import { PRESET_NAMES, comparisonRange } from "./dates.js";
import { assertComparable, buildQueryOptions, compareResult, plainResult } from "./query.js";

// inspectConcurrency stays low on purpose: the URL Inspection API allows only
// 2,000 calls per day and 600 per minute per property, and burning that quota
// is far more expensive than waiting a moment.
const INSPECT_CONCURRENCY = 3;

export interface ServerOptions {
  version: string;
  // getClient is called per tool invocation, so credentials are resolved
  // lazily and a login done while the server is running is picked up.
  getClient: () => Promise<Client>;
  // authStatus describes the active credential source.
  authStatus: () => Promise<Record<string, unknown>>;
  defaultSite?: string;
  // readOnly hides the tools that change Search Console state.
  readOnly?: boolean;
}

const siteParam = z
  .string()
  .optional()
  .describe(
    '対象プロパティ。省略時は環境変数 GSC_SITE。"example.com" は "sc-domain:example.com"（ドメインプロパティ）、"https://example.com" は "https://example.com/"（URLプレフィックス）に補完される。両者は別プロパティなので正確な文字列は sites_list で確認する',
  );

export function createServer(opts: ServerOptions): McpServer {
  const server = new McpServer(
    { name: "search-console", version: opts.version },
    {
      instructions:
        "Google Search Console API のツール群。対象プロパティは各ツールの site 引数か環境変数 GSC_SITE で決まる。プロパティ文字列が不明なら先に sites_list を呼ぶ。認証エラーが出たら auth_status で原因を確認する。",
    },
  );

  const resolveSite = (site?: string): string => {
    const s = normalizeSite(site || opts.defaultSite || "");
    if (!s) {
      throw new Error(
        "対象プロパティが未指定です。site 引数を渡すか GSC_SITE を設定してください（候補は sites_list で確認）",
      );
    }
    return s;
  };

  server.registerTool(
    "auth_status",
    {
      title: "認証状態の確認",
      description:
        "どの認証情報（サービスアカウント / OAuth / ADC）が使われるかと、トークンを取得できるかを確認する。API は呼ばない。",
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    () => run(opts.authStatus),
  );

  server.registerTool(
    "sites_list",
    {
      title: "プロパティ一覧",
      description:
        "認証中のアカウントが見られる Search Console プロパティを一覧する。他ツールの site に渡す正確な文字列はここで確認する。サービスアカウントで空になる場合は、Search Console の「設定 > ユーザーと権限」でそのメールアドレスをユーザー追加していない。",
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    () =>
      run(async () => {
        const sites = await (await opts.getClient()).sites();
        return { sites: sites.map(siteJSON) };
      }),
  );

  server.registerTool(
    "sites_get",
    {
      title: "プロパティの権限を取得",
      description: "プロパティ1件について、認証中アカウントの権限レベルを取得する。",
      inputSchema: { site: siteParam },
      annotations: { readOnlyHint: true },
    },
    ({ site }) =>
      run(async () => {
        const s = await (await opts.getClient()).site(resolveSite(site));
        return { sites: [siteJSON(s)] };
      }),
  );

  server.registerTool(
    "query",
    {
      title: "検索パフォーマンスの取得",
      description: `Search Analytics API で、指定期間・指定ディメンションの検索パフォーマンス（クリック・表示回数・CTR・掲載順位）を取得する。

期間の優先順位: start_date/end_date > days > preset（既定 last_28d）。Search Console のデータは確定まで2〜3日かかるため、既定の終了日は「PT の今日 − 3日」（lag_days で変更可）。未確定の直近データも見るなら data_state=all。

dimensions を省略するとプロパティ全体の合計1行。順序がグループ順になる。

filters は「<ディメンション><演算子><値>」の式（query / page / country / device / searchAppearance が対象）:
  page~~/blog/          page が /blog/ を含む
  query!~ブランド名      query がブランド名を含まない（指名検索の除外）
  device==MOBILE        一致（!= は不一致）
  page~*^https://a\\.jp/ RE2 正規表現に一致（!* は除外）

compare: previous = 直前の同じ長さの期間、year = 364日前（曜日が揃う）。行に *_prev / *_delta が付き、position_gain は順位が上がった分（+3 = 3位上昇。両期間で表示があった行のみ）。date / hour ディメンションとは併用不可。

ctr は 0〜1 の比率、position は平均掲載順位。totals は取得した行の合計（position は表示回数で加重）。`,
      inputSchema: {
        site: siteParam,
        dimensions: z
          .array(z.enum(["query", "page", "country", "device", "date", "hour", "searchAppearance"]))
          .optional()
          .describe("グループ化するディメンション。hour は data_state=hourly_all が必須（直近10日分のみ）"),
        filters: z.array(z.string()).optional().describe("フィルタ式の配列（例: [\"page~~/blog/\", \"query!~ブランド名\"]）"),
        filter_group_type: z.enum(["and", "or"]).optional().describe("複数フィルタの結合（既定 and）"),
        start_date: z.string().optional().describe("開始日 YYYY-MM-DD"),
        end_date: z.string().optional().describe("終了日 YYYY-MM-DD（既定: PT の今日 − lag_days 日）"),
        days: z.number().int().positive().optional().describe("終了日から遡る日数"),
        preset: z.enum(PRESET_NAMES as [string, ...string[]]).optional().describe("期間プリセット（既定 last_28d）"),
        lag_days: z.number().int().min(0).optional().describe("データ確定の遅延日数（既定 3）"),
        limit: z
          .number()
          .int()
          .min(0)
          .optional()
          .describe("取得する最大行数（既定 100）。0 で全件を自動ページングするが、行数が膨大になり得るので絞り込みと併用する"),
        type: z.enum(["web", "image", "video", "news", "discover", "googleNews"]).optional().describe("検索種別（既定 web）"),
        data_state: z
          .enum(["final", "all", "hourly_all"])
          .optional()
          .describe("final = 確定のみ（既定） / all = 未確定を含む / hourly_all = 時間別"),
        aggregation: z
          .enum(["auto", "byProperty", "byPage"])
          .optional()
          .describe("集計単位（既定 auto）。byProperty は page ディメンション/フィルタと併用不可"),
        compare: z.enum(["previous", "year"]).optional().describe("比較期間"),
      },
      annotations: { readOnlyHint: true },
    },
    (a) =>
      run(async () => {
        const o = buildQueryOptions({
          site: resolveSite(a.site),
          dimensions: a.dimensions,
          filters: a.filters,
          filterGroupType: a.filter_group_type,
          type: a.type,
          dataState: a.data_state,
          aggregation: a.aggregation,
          range: { start: a.start_date, end: a.end_date, days: a.days, preset: a.preset, lagDays: a.lag_days },
          limit: a.limit ?? 100,
        });
        if (!a.compare) {
          return plainResult(o, await (await opts.getClient()).query(o));
        }
        assertComparable(o);
        const prevRange = comparisonRange(o.range, a.compare);
        const client = await opts.getClient();
        const [current, previous] = await Promise.all([client.query(o), client.query({ ...o, range: prevRange })]);
        return compareResult(o, prevRange, current, previous);
      }),
  );

  server.registerTool(
    "inspect",
    {
      title: "URL のインデックス検査",
      description:
        "URL Inspection API で、URL がインデックスされているか、正規URLはどれか、最後にクロールされたのはいつか、モバイル・リッチリザルトに問題がないかを返す。URL は対象プロパティ配下である必要がある。クォータは1プロパティあたり 1日2,000件 / 1分600件。1件失敗しても他は続行し、その行に error が入る。",
      inputSchema: {
        site: siteParam,
        urls: z.array(z.string().url()).min(1).max(50).describe("検査する URL（完全な URL）"),
        language_code: z.string().optional().describe("結果メッセージの言語（BCP-47。既定 ja）"),
      },
      annotations: { readOnlyHint: true },
    },
    ({ site, urls, language_code }) =>
      run(async () => {
        const s = resolveSite(site);
        const client = await opts.getClient();
        const results = await mapLimit(urls, INSPECT_CONCURRENCY, async (url) => {
          try {
            const r = await client.inspect(s, url, language_code ?? "ja");
            return {
              url,
              inspection_result_link: r.inspectionResultLink,
              index_status: r.indexStatusResult ?? {},
              mobile_usability: r.mobileUsabilityResult,
              rich_results: r.richResultsResult,
              amp: r.ampResult,
            };
          } catch (e) {
            // One bad URL must not sink the whole batch: record the error in
            // its row and keep the others.
            return { url, error: (e as Error).message };
          }
        });
        return { site: s, results };
      }),
  );

  server.registerTool(
    "sitemaps_list",
    {
      title: "サイトマップ一覧",
      description: "プロパティに送信済みのサイトマップを一覧する（最終送信/取得日時、エラー・警告件数、送信/登録URL数）。",
      inputSchema: { site: siteParam },
      annotations: { readOnlyHint: true },
    },
    ({ site }) =>
      run(async () => {
        const s = resolveSite(site);
        const maps = await (await opts.getClient()).sitemaps(s);
        return { site: s, sitemaps: maps.map(sitemapJSON) };
      }),
  );

  server.registerTool(
    "sitemaps_get",
    {
      title: "サイトマップの詳細",
      description: "サイトマップ1件の詳細を取得する。",
      inputSchema: { site: siteParam, sitemap_url: z.string().url().describe("サイトマップの完全な URL") },
      annotations: { readOnlyHint: true },
    },
    ({ site, sitemap_url }) =>
      run(async () => {
        const s = resolveSite(site);
        const m = await (await opts.getClient()).sitemap(s, sitemap_url);
        return { site: s, sitemaps: [sitemapJSON(m)] };
      }),
  );

  if (opts.readOnly) return server;

  server.registerTool(
    "sitemaps_submit",
    {
      title: "サイトマップの送信",
      description:
        "サイトマップを Google に送信（再送信）する。成功は「受理された」という意味で、クロール結果はすぐには反映されない。数分〜数時間後に sitemaps_list で last_downloaded / エラー件数を確認する。",
      inputSchema: {
        site: siteParam,
        sitemap_url: z.string().url().describe("サイトマップの完全な URL（例: https://example.com/sitemap.xml）"),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    },
    ({ site, sitemap_url }) =>
      run(async () => {
        const s = resolveSite(site);
        await (await opts.getClient()).submitSitemap(s, sitemap_url);
        return { site: s, submitted: sitemap_url, note: "取得結果は少し待ってから sitemaps_list で確認する" };
      }),
  );

  server.registerTool(
    "sitemaps_delete",
    {
      title: "サイトマップの削除",
      description: "サイトマップの登録をプロパティから削除する。ユーザーが明示的に削除を求めたときだけ使う。",
      inputSchema: { site: siteParam, sitemap_url: z.string().url().describe("サイトマップの完全な URL") },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
    },
    ({ site, sitemap_url }) =>
      run(async () => {
        const s = resolveSite(site);
        await (await opts.getClient()).deleteSitemap(s, sitemap_url);
        return { site: s, deleted: sitemap_url };
      }),
  );

  server.registerTool(
    "sites_add",
    {
      title: "プロパティの追加",
      description:
        "プロパティを認証中アカウントのリストに追加する。これは「追加」であって「確認（verification）」ではない。所有権の確認は Search Console の画面か DNS / HTML ファイル等で別途必要。",
      inputSchema: { site: z.string().min(1).describe("追加するプロパティ（GSC_SITE にはフォールバックしない）") },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    },
    ({ site }) =>
      run(async () => {
        const s = normalizeSite(site);
        await (await opts.getClient()).addSite(s);
        return { added: s, note: "所有権が未確認の場合は Search Console で確認する" };
      }),
  );

  server.registerTool(
    "sites_delete",
    {
      title: "プロパティの削除",
      description:
        "プロパティを認証中アカウントの一覧から削除する。ユーザーが明示的に削除を求めたときだけ使う。",
      inputSchema: { site: z.string().min(1).describe("削除するプロパティ（GSC_SITE にはフォールバックしない）") },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
    },
    ({ site }) =>
      run(async () => {
        const s = normalizeSite(site);
        await (await opts.getClient()).deleteSite(s);
        return { deleted: s };
      }),
  );

  return server;
}

// run turns a handler's result into a tool response. Failures are returned as
// tool errors (not protocol errors) so the model can read the hint and react.
async function run(fn: () => Promise<Record<string, unknown>>) {
  try {
    return { content: [{ type: "text" as const, text: JSON.stringify(await fn()) }] };
  } catch (e) {
    return { content: [{ type: "text" as const, text: `エラー: ${(e as Error).message}` }], isError: true };
  }
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

function siteJSON(s: any) {
  return { site_url: s.siteUrl, permission_level: s.permissionLevel };
}

function sitemapJSON(m: any) {
  return {
    path: m.path,
    type: m.type,
    is_sitemaps_index: m.isSitemapsIndex ?? false,
    is_pending: m.isPending ?? false,
    last_submitted: m.lastSubmitted,
    last_downloaded: m.lastDownloaded,
    // The API serialises int64 counters as strings.
    errors: Number(m.errors ?? 0),
    warnings: Number(m.warnings ?? 0),
    contents: (m.contents ?? []).map((c: any) => ({
      type: c.type,
      submitted: Number(c.submitted ?? 0),
      indexed: Number(c.indexed ?? 0),
    })),
  };
}

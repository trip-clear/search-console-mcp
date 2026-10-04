# search-console-mcp — Google Search Console MCP server

Google Search Console API を MCP ツールとして公開するサーバ（TypeScript 製・stdio）。検索パフォーマンスの取得、期間比較、URL のインデックス状況の検査、サイトマップ管理、プロパティ一覧に対応する。

[search-console-cli](https://github.com/trip-clear/search-console-cli)（`gsc` コマンド）の MCP 版で、期間プリセット・フィルタ式・比較の仕様と認証情報の置き場所（`~/.config/gsc`）を CLI と共有する。`gsc auth login` 済みならそのまま動く。

## 起動（npx）

必要なもの: Node.js 18 以上。

```bash
# GitHub から直接（private リポジトリなので GitHub への SSH / HTTPS 認証が必要）
npx -y github:trip-clear/search-console-mcp

# npm に公開した場合
npx -y @trip-clear/search-console-mcp
```

GitHub から起動する場合、初回は依存の取得とビルドが走るため数十秒かかる。バージョン固定は `github:trip-clear/search-console-mcp#v0.1.0` のようにタグを指定する。

### Claude Code

```bash
claude mcp add search-console -e GSC_SITE=sc-domain:example.com -- npx -y github:trip-clear/search-console-mcp
```

### Claude Desktop / `.mcp.json`

```json
{
  "mcpServers": {
    "search-console": {
      "command": "npx",
      "args": ["-y", "github:trip-clear/search-console-mcp"],
      "env": {
        "GSC_SITE": "sc-domain:example.com"
      }
    }
  }
}
```

## セットアップ（認証）

認証方法は3つ。優先順位は サービスアカウント → OAuth トークン → ADC。

### 1. OAuth（人が操作する場合の推奨）

1. Google Cloud で Search Console API を有効化する
   → https://console.cloud.google.com/apis/library/searchconsole.googleapis.com
2. 「APIとサービス > 認証情報」で **デスクトップアプリ** の OAuth クライアントを作成
3. ダウンロードした JSON を `~/.config/gsc/client_secret.json` に置く
   （または `GSC_CLIENT_ID` / `GSC_CLIENT_SECRET` を環境変数で渡す）
4. ログイン

```bash
npx -y github:trip-clear/search-console-mcp login    # ブラウザが開く。トークンは ~/.config/gsc/token.json (0600) に保存
npx -y github:trip-clear/search-console-mcp status   # どの認証情報が使われるかを確認
```

トークンは `gsc` CLI と同じファイル・同じ形式なので、`gsc auth login` でログインしても構わない。サーバ起動中にログインし直した場合も、再起動なしで次のツール呼び出しから反映される。

### 2. サービスアカウント（CI・自動化向け）

サービスアカウントの JSON キーを用意し、**そのメールアドレスを Search Console の「設定 > ユーザーと権限」でユーザー追加する**（これを忘れると 403 になる。プロパティ側の権限であって IAM ロールではない）。

```json
"env": { "GSC_CREDENTIALS": "/path/to/service-account.json" }
```

Google Workspace のドメイン全体の委任を使う場合は `GSC_IMPERSONATE=user@example.com`。

### 3. ADC

ADC のユーザー認証情報は gcloud ログイン時に付与されたスコープしか持たないため、Search Console のスコープを明示する。

```bash
gcloud auth application-default login \
  --scopes=https://www.googleapis.com/auth/webmasters,https://www.googleapis.com/auth/cloud-platform
```

## ツール

| ツール | 内容 |
|---|---|
| `query` | 検索パフォーマンス（クリック・表示回数・CTR・掲載順位）。ディメンション・フィルタ・期間比較に対応 |
| `inspect` | URL のインデックス検査（URL Inspection API。1回50件まで） |
| `sites_list` / `sites_get` | プロパティの一覧・権限 |
| `sitemaps_list` / `sitemaps_get` | サイトマップの一覧・詳細 |
| `auth_status` | どの認証情報が使われているかの確認 |
| `sitemaps_submit` / `sitemaps_delete` | サイトマップの送信・削除（変更系） |
| `sites_add` / `sites_delete` | プロパティの追加・削除（変更系） |

変更系の4ツールは `GSC_READONLY=1` で無効化できる。

### 対象プロパティ

各ツールの `site` 引数、または環境変数 `GSC_SITE`。

| 書き方 | 解釈 |
|---|---|
| `example.com` | `sc-domain:example.com`（ドメインプロパティに補完） |
| `sc-domain:example.com` | そのまま |
| `https://example.com` | `https://example.com/`（URLプレフィックス。末尾スラッシュを補完） |

ドメインプロパティと URL プレフィックスは**別のプロパティ**。正確な文字列は `sites_list` で確認する。

### query の引数

| 引数 | 内容 |
|---|---|
| `dimensions` | `query` `page` `country` `device` `date` `hour` `searchAppearance`。省略時は全体の合計1行。順序がグループ順 |
| `filters` | フィルタ式の配列（下表）。`filter_group_type: "or"` で OR 結合 |
| `start_date` / `end_date` | `YYYY-MM-DD` |
| `days` | 終了日から遡る日数 |
| `preset` | `today` `yesterday` `latest` `last_7d` `last_28d`（既定）`last_30d` `last_90d` `last_3m` `last_6m` `last_12m` `last_16m` `this_month` `last_month` |
| `lag_days` | データ確定の遅延日数（既定 3） |
| `limit` | 最大行数（既定 100。`0` で全件を自動ページング） |
| `type` | `web`（既定）`image` `video` `news` `discover` `googleNews` |
| `data_state` | `final`（既定）/ `all`（未確定を含む）/ `hourly_all`（`hour` ディメンションで必須） |
| `aggregation` | `auto`（既定）/ `byProperty` / `byPage` |
| `compare` | `previous`（直前の同じ長さの期間）/ `year`（364日前 = 曜日が揃う） |

期間の優先順位は `start_date`/`end_date` > `days` > `preset`。Search Console のデータ確定には2〜3日かかるため、既定の終了日は **PT の今日 − 3日**。

フィルタ式（`query` / `page` / `country` / `device` / `searchAppearance` が対象）:

| 演算子 | 意味 | 例 |
|---|---|---|
| `==` | 一致 | `device==MOBILE` |
| `!=` | 不一致 | `country!=jpn` |
| `~~` | 含む | `page~~/blog/` |
| `!~` | 含まない | `query!~ブランド名` |
| `~*` | 正規表現に一致 | `page~*^https://example\.jp/(a\|b)` |
| `!*` | 正規表現を除外 | `page!*/tag/` |

結果は JSON で、フィールド名は CLI の `-o json` と揃えている（`site` `range` `dimensions` `rows` `totals`、比較時は `compare_range` `*_prev` `*_delta` `totals_previous`）。CLI との違いは3点:

- `limit` の既定が 100（CLI は 1000）。モデルのコンテキストを圧迫しないため
- `ctr` は小数4桁、`position` は小数2桁に丸める
- 比較時に `position_gain`（順位が上がった分。`+3` = 3位上昇）を行に含める。両期間で表示があった行のみ

## 環境変数

| 変数 | 用途 |
|---|---|
| `GSC_SITE` | 既定の対象プロパティ |
| `GSC_CREDENTIALS` / `GOOGLE_APPLICATION_CREDENTIALS` | サービスアカウント JSON |
| `GSC_IMPERSONATE` | ドメイン全体の委任で代理するユーザー |
| `GSC_CLIENT_ID` / `GSC_CLIENT_SECRET` | OAuth クライアント（ファイルの代わり） |
| `GSC_OAUTH_CLIENT` | OAuth クライアント JSON のパス |
| `GSC_CONFIG_DIR` | 設定・トークンの保存先（既定 `~/.config/gsc`。CLI と共有） |
| `GSC_READONLY` | `1` で変更系ツールを無効化 |
| `GSC_ENDPOINT` | API ホストの上書き（テスト・デバッグ用） |

## 開発

```bash
npm install
npm run build   # dist/ に出力
npm test        # ユニット + スタブサーバに対する E2E（実 API は叩かない）
```

手元のビルドを MCP クライアントから使うときは `"command": "node", "args": ["/path/to/search-console-mcp/dist/index.js"]`。

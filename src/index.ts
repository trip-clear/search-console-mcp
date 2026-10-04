#!/usr/bin/env node
import { createRequire } from "node:module";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { Credentials, logout, resolveCredentials } from "./auth.js";
import { Client } from "./client.js";
import { login } from "./login.js";
import { createServer } from "./server.js";

const { version } = createRequire(import.meta.url)("../package.json") as { version: string };

const USAGE = `search-console-mcp ${version} — Google Search Console MCP server

使い方:
  search-console-mcp            MCP サーバを stdio で起動する（MCP クライアントから呼ぶ）
  search-console-mcp login      ブラウザで OAuth ログインし、トークンを保存する
  search-console-mcp logout     保存済み OAuth トークンを削除する
  search-console-mcp status     どの認証情報が使われるかを確認する

環境変数:
  GSC_SITE                      既定の対象プロパティ
  GSC_CREDENTIALS               サービスアカウント JSON（GOOGLE_APPLICATION_CREDENTIALS でも可）
  GSC_IMPERSONATE               ドメイン全体の委任で代理するユーザーのメールアドレス
  GSC_CLIENT_ID / GSC_CLIENT_SECRET, GSC_OAUTH_CLIENT   OAuth クライアント
  GSC_CONFIG_DIR                設定・トークンの保存先（既定 ~/.config/gsc。gsc CLI と共有）
  GSC_READONLY=1                変更系ツール（sitemaps_submit/delete, sites_add/delete）を無効化
`;

async function authStatus(): Promise<Record<string, unknown>> {
  const creds = await resolveCredentials();
  try {
    await creds.headers();
  } catch (e) {
    throw new Error(
      `認証情報（${creds.source.kind}）は見つかりましたが、トークンを取得できませんでした: ${(e as Error).message}`,
    );
  }
  return { kind: creds.source.kind, detail: creds.source.detail, token: "ok" };
}

async function serve(): Promise<void> {
  // Credentials are cached only while they work, so a login done while the
  // server is running is picked up by the next tool call.
  let creds: Credentials | undefined;
  const getClient = async () => {
    const c = (creds ??= await resolveCredentials());
    return new Client({
      headers: () =>
        c.headers().catch((e) => {
          creds = undefined;
          throw e;
        }),
      userAgent: `search-console-mcp/${version}`,
      endpoint: process.env.GSC_ENDPOINT,
    });
  };

  const server = createServer({
    version,
    getClient,
    authStatus,
    defaultSite: process.env.GSC_SITE,
    readOnly: ["1", "true"].includes((process.env.GSC_READONLY ?? "").toLowerCase()),
  });
  await server.connect(new StdioServerTransport());
}

async function main(): Promise<void> {
  const cmd = process.argv[2];
  switch (cmd) {
    case undefined:
      return serve();
    case "login": {
      const path = await login((line) => console.error(line));
      console.error(`ログインしました。トークンを保存: ${path}`);
      return;
    }
    case "logout":
      console.error(`トークンを削除しました: ${await logout()}`);
      return;
    case "status":
      console.log(JSON.stringify(await authStatus(), null, 2));
      return;
    case "--version":
    case "-v":
      console.log(version);
      return;
    case "--help":
    case "-h":
    case "help":
      console.log(USAGE);
      return;
    default:
      console.error(`不明なコマンド: ${cmd}\n\n${USAGE}`);
      process.exitCode = 2;
  }
}

main().catch((e) => {
  console.error(`エラー: ${(e as Error).message}`);
  process.exitCode = 1;
});

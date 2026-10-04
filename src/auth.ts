// Resolves Google credentials for the Search Console API.
//
// Three credential sources are supported, in priority order:
//
//  1. Service account JSON (GSC_CREDENTIALS or GOOGLE_APPLICATION_CREDENTIALS).
//     The service account's email must be added as a user of the Search Console
//     property, or impersonate a human user with domain-wide delegation
//     (GSC_IMPERSONATE).
//  2. A cached OAuth token from `search-console-mcp login` or `gsc auth login`
//     (~/.config/gsc/token.json -- the file is shared with the gsc CLI).
//  3. Application Default Credentials (`gcloud auth application-default login`).

import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { GoogleAuth, JWT, OAuth2Client } from "google-auth-library";

// Scope grants read and write access to Search Console data. Write is needed
// for sitemaps_submit, sitemaps_delete, sites_add and sites_delete.
export const SCOPE = "https://www.googleapis.com/auth/webmasters";

export const LOGIN_COMMAND = "npx -y @trip-clear/search-console-mcp login";

export class NoCredentialsError extends Error {
  constructor() {
    super(`認証情報が見つかりません

次のいずれかを設定してください:
  1. ${LOGIN_COMMAND}
       OAuth（人が操作する場合の推奨。gsc auth login 済みならそのトークンを共有する）
  2. 環境変数 GSC_CREDENTIALS=/path/sa.json
       サービスアカウント（そのメールアドレスを Search Console の
       「設定 > ユーザーと権限」でユーザー追加する）
  3. gcloud auth application-default login --scopes=${SCOPE},https://www.googleapis.com/auth/cloud-platform
       ADC`);
  }
}

// Source describes which credential source was used, for auth_status.
export interface Source {
  kind: "service-account" | "oauth" | "adc";
  detail: string;
}

export interface Credentials {
  source: Source;
  headers(): Promise<Record<string, string>>;
}

type Env = NodeJS.ProcessEnv;

export async function resolveCredentials(env: Env = process.env): Promise<Credentials> {
  const file = credentialsFile(env);
  if (file) {
    let data: any;
    try {
      data = JSON.parse(await readFile(file, "utf8"));
    } catch (e) {
      throw new Error(`read credentials ${file}: ${(e as Error).message}`);
    }
    switch (kindOf(data)) {
      case "service_account": {
        const subject = env.GSC_IMPERSONATE || undefined; // domain-wide delegation only
        const jwt = new JWT({ email: data.client_email, key: data.private_key, scopes: [SCOPE], subject });
        const detail = subject ? `${data.client_email} (impersonating ${subject})` : data.client_email;
        return { source: { kind: "service-account", detail }, headers: () => headersOf(jwt) };
      }
      case "oauth_client":
      // An OAuth client secret only becomes usable once login has exchanged
      // it for a token, so fall through to the cache.
      case "authorized_user":
        // gcloud's ADC file; the ADC branch below picks it up.
        break;
      default:
        throw new Error(`${file} is neither a service account key nor an OAuth client secret`);
    }
  }

  const tok = await loadToken(env);
  if (tok) {
    const client = await oauthClient(env);
    client.setCredentials({
      access_token: tok.access_token,
      refresh_token: tok.refresh_token,
      token_type: tok.token_type,
      expiry_date: tok.expiry ? Date.parse(tok.expiry) : undefined,
    });
    return {
      source: { kind: "oauth", detail: tokenPath(env) },
      headers: async () => {
        try {
          return await headersOf(client);
        } catch (e) {
          throw new Error(
            `${(e as Error).message}\n\n保存済みトークンが失効・取り消された可能性があります。\`${LOGIN_COMMAND}\` をやり直してください`,
          );
        }
      },
    };
  }

  try {
    const adc = await new GoogleAuth({ scopes: [SCOPE] }).getClient();
    return {
      source: { kind: "adc", detail: "application default credentials" },
      headers: async () => {
        try {
          return await headersOf(adc);
        } catch (e) {
          throw new Error(
            `${(e as Error).message}\n\nADC が失効しているか、Search Console のスコープがありません。再ログインしてください:\n  gcloud auth application-default login --scopes=${SCOPE},https://www.googleapis.com/auth/cloud-platform\n\nより簡単なのは OAuth です: ${LOGIN_COMMAND}`,
          );
        }
      },
    };
  } catch {
    throw new NoCredentialsError();
  }
}

// headersOf returns the Authorization header (plus x-goog-user-project when
// the credential carries a quota project, which ADC user credentials need).
async function headersOf(client: { getRequestHeaders(): Promise<Headers> }): Promise<Record<string, string>> {
  return Object.fromEntries((await client.getRequestHeaders()).entries());
}

function credentialsFile(env: Env): string {
  return env.GSC_CREDENTIALS || env.GOOGLE_APPLICATION_CREDENTIALS || "";
}

// kindOf tells a service account key apart from an OAuth client secret.
function kindOf(data: any): string {
  if (data?.type === "service_account") return "service_account";
  if (data?.type === "authorized_user") return "authorized_user";
  if (data?.installed || data?.web) return "oauth_client";
  return "";
}

// oauthClient builds the OAuth client from, in order: GSC_CLIENT_ID +
// GSC_CLIENT_SECRET, or a client secret JSON (GSC_OAUTH_CLIENT, GSC_CREDENTIALS
// when it holds one, or ~/.config/gsc/client_secret.json).
export async function oauthClient(env: Env = process.env): Promise<OAuth2Client> {
  if (env.GSC_CLIENT_ID && env.GSC_CLIENT_SECRET) {
    return new OAuth2Client({ clientId: env.GSC_CLIENT_ID, clientSecret: env.GSC_CLIENT_SECRET });
  }

  const fallback = join(configDir(env), "client_secret.json");
  const candidates = [env.GSC_OAUTH_CLIENT, credentialsFile(env), fallback].filter(Boolean) as string[];
  for (const path of candidates) {
    let raw: string;
    try {
      raw = await readFile(path, "utf8");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT" && path === fallback) break;
      throw e;
    }
    let data: any;
    try {
      data = JSON.parse(raw);
    } catch (e) {
      throw new Error(`parse OAuth client ${path}: ${(e as Error).message}`);
    }
    const c = data.installed ?? data.web;
    if (c?.client_id) return new OAuth2Client({ clientId: c.client_id, clientSecret: c.client_secret });
    if (path !== credentialsFile(env)) throw new Error(`parse OAuth client ${path}: not an OAuth client secret`);
  }

  throw new Error(`OAuth クライアントが未設定です

Search Console API を有効化した Google Cloud プロジェクトで「デスクトップアプリ」の
OAuth クライアントを作成し、次のいずれかで渡してください:
  - ダウンロードした JSON を ${fallback} に置く
  - GSC_CLIENT_ID と GSC_CLIENT_SECRET を環境変数で設定する`);
}

// The config directory is shared with the gsc CLI on purpose, so one login
// serves both.
export function configDir(env: Env = process.env): string {
  if (env.GSC_CONFIG_DIR) return env.GSC_CONFIG_DIR;
  if (env.XDG_CONFIG_HOME) return join(env.XDG_CONFIG_HOME, "gsc");
  return join(homedir(), ".config", "gsc");
}

export function tokenPath(env: Env = process.env): string {
  return join(configDir(env), "token.json");
}

// StoredToken is the on-disk layout the gsc CLI writes (Go's oauth2.Token).
export interface StoredToken {
  access_token?: string;
  token_type?: string;
  refresh_token?: string;
  expiry?: string; // RFC 3339
}

async function loadToken(env: Env): Promise<StoredToken | undefined> {
  const path = tokenPath(env);
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw e;
  }
  let tok: StoredToken;
  try {
    tok = JSON.parse(raw);
  } catch (e) {
    throw new Error(`parse ${path}: ${(e as Error).message} (delete it and run: ${LOGIN_COMMAND})`);
  }
  if (!tok.refresh_token && !(tok.expiry && Date.parse(tok.expiry) > Date.now())) {
    throw new Error(`cached token is expired and has no refresh token (run: ${LOGIN_COMMAND})`);
  }
  return tok;
}

export async function saveToken(tok: StoredToken, env: Env = process.env): Promise<string> {
  await mkdir(configDir(env), { recursive: true, mode: 0o700 });
  // The token is a live credential: keep it readable only by its owner.
  await writeFile(tokenPath(env), JSON.stringify(tok, null, 2), { mode: 0o600 });
  return tokenPath(env);
}

// logout removes the cached OAuth token. It is not an error if none exists.
export async function logout(env: Env = process.env): Promise<string> {
  await rm(tokenPath(env), { force: true });
  return tokenPath(env);
}

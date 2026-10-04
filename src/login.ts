import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { AddressInfo } from "node:net";
import { CodeChallengeMethod } from "google-auth-library";
import { SCOPE, oauthClient, saveToken } from "./auth.js";

// LOGIN_TIMEOUT_MS bounds how long we wait for the user to finish the browser
// consent flow before giving up and releasing the local port.
const LOGIN_TIMEOUT_MS = 3 * 60 * 1000;

// login runs the OAuth installed-app flow: it starts a loopback listener,
// opens the consent screen in a browser, exchanges the authorization code and
// caches the resulting token. It returns the path the token was written to.
export async function login(log: (line: string) => void): Promise<string> {
  const client = await oauthClient();
  const state = randomBytes(24).toString("base64url");
  const { codeVerifier, codeChallenge } = await client.generateCodeVerifierAsync();

  const server = createServer();
  // Google's "Desktop app" clients accept any loopback port, so let the OS
  // pick a free one instead of hardcoding one that might be taken.
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const redirectUri = `http://127.0.0.1:${(server.address() as AddressInfo).port}/callback`;

  try {
    const code = new Promise<string>((resolve, reject) => {
      server.on("request", (req, res) => {
        const url = new URL(req.url ?? "/", redirectUri);
        if (url.pathname !== "/callback") {
          res.writeHead(404).end();
          return;
        }
        const error = url.searchParams.get("error");
        if (error) {
          res.writeHead(400).end("authorization failed: " + error);
          reject(new Error(`authorization denied: ${error}`));
          return;
        }
        if (url.searchParams.get("state") !== state) {
          res.writeHead(400).end("state mismatch");
          reject(new Error("state mismatch: the callback did not come from the request we started"));
          return;
        }
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }).end(`<!doctype html><meta charset="utf-8"><title>search-console-mcp</title>
<body style="font-family:system-ui;padding:3rem">
<h1>認証が完了しました</h1><p>ターミナルに戻ってください。このタブは閉じて構いません。</p>`);
        resolve(url.searchParams.get("code") ?? "");
      });
    });

    const authUrl = client.generateAuthUrl({
      redirect_uri: redirectUri,
      scope: [SCOPE],
      state,
      access_type: "offline", // ask for a refresh token
      prompt: "consent", // ...even on a repeat consent
      code_challenge: codeChallenge,
      code_challenge_method: CodeChallengeMethod.S256,
    });
    log(`ブラウザで認証してください:\n\n  ${authUrl}\n`);
    openBrowser(authUrl);

    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("timed out waiting for the browser callback")), LOGIN_TIMEOUT_MS);
    });
    let authCode: string;
    try {
      authCode = await Promise.race([code, timeout]);
    } finally {
      clearTimeout(timer);
    }

    const { tokens } = await client.getToken({ code: authCode, codeVerifier, redirect_uri: redirectUri });
    return await saveToken({
      access_token: tokens.access_token ?? undefined,
      token_type: tokens.token_type ?? "Bearer",
      refresh_token: tokens.refresh_token ?? undefined,
      expiry: tokens.expiry_date ? new Date(tokens.expiry_date).toISOString() : undefined,
    });
  } finally {
    server.close();
    server.closeAllConnections?.();
  }
}

// openBrowser is best-effort: the URL is printed either way.
function openBrowser(url: string): void {
  let cmd = "xdg-open";
  let args: string[] = [];
  if (process.platform === "darwin") cmd = "open";
  else if (process.platform === "win32") [cmd, args] = ["rundll32", ["url.dll,FileProtocolHandler"]];
  spawn(cmd, [...args, url], { stdio: "ignore", detached: true })
    .on("error", () => {})
    .unref();
}

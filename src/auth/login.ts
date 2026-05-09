/**
 * Top-level pairing orchestrator. Drives the OAuth-loopback dance:
 *
 *   1. Bind a single-use HTTP server on 127.0.0.1:<loopbackPort>.
 *   2. Open the user's browser to <webUrl>/oauth/connect?... with our
 *      loopback URI as redirect_uri.
 *   3. Wait for the browser to hit /oauth/callback?code=...&state=...,
 *      verify state matches our CSRF token, capture the code.
 *   4. Hand off to ./login-oauth#exchangeAndPersist (token + link + persist).
 *   5. Close the loopback server, return the persisted creds.
 */
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import http from "node:http";
import { AddressInfo } from "node:net";

import type { Creds } from "./store.js";
import { exchangeAndPersist } from "./login-oauth.js";

export type PairOptions = {
  agentName: string;
  clientId: string;
  /** Optional confidential-client secret. Local dev clients use PKCE instead. */
  clientSecret?: string;
  apiUrl: string;
  webUrl: string;
  /** Loopback port for the redirect handler. Default 9999. */
  loopbackPort?: number;
  /** Loopback path. Default `/cb`. */
  loopbackPath?: string;
  accountId?: string;
  /** Wait this long for the browser callback before giving up. Default 5min. */
  timeoutMs?: number;
  openBrowser?: (url: string) => void;
  onProgress?: (line: string) => void;
};

const DEFAULT_PORT = 9999;
const DEFAULT_PATH = "/cb";
const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;

export async function pairWithBrowser(opts: PairOptions): Promise<Creds> {
  const port = opts.loopbackPort ?? DEFAULT_PORT;
  const cbPath = opts.loopbackPath ?? DEFAULT_PATH;
  const redirectUri = `http://127.0.0.1:${port}${cbPath}`;
  const state = crypto.randomBytes(16).toString("hex");
  const codeVerifier = newPkceVerifier();
  const codeChallenge = pkceChallenge(codeVerifier);
  const log = opts.onProgress ?? ((s: string) => console.log(s));

  const { code, boundPort } = await captureAuthCode({
    cbPath,
    desiredPort: port,
    expectedState: state,
    timeoutMs: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    onListening: (boundPort) => {
      const url = buildConsentUrl({
        webUrl: opts.webUrl,
        clientId: opts.clientId,
        redirectUri: `http://127.0.0.1:${boundPort}${cbPath}`,
        scope: "channel:link",
        state,
        codeChallenge,
      });
      log(`open in your browser to authorize:\n  ${url}`);
      const opener = opts.openBrowser ?? defaultBrowserOpen;
      opener(url);
    },
  });

  const effectiveRedirect =
    boundPort === port ? redirectUri : `http://127.0.0.1:${boundPort}${cbPath}`;

  log(`code received; exchanging for token…`);
  const creds = await exchangeAndPersist({
    code,
    agentName: opts.agentName,
    clientId: opts.clientId,
    clientSecret: opts.clientSecret,
    codeVerifier,
    redirectUri: effectiveRedirect,
    apiUrl: opts.apiUrl,
    accountId: opts.accountId,
  });
  log(`linked as @${creds.handle}`);
  return creds;
}

type CaptureOptions = {
  cbPath: string;
  desiredPort: number;
  expectedState: string;
  timeoutMs: number;
  onListening: (boundPort: number) => void;
};

function captureAuthCode(opts: CaptureOptions): Promise<{ code: string; boundPort: number }> {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const url = new URL(req.url ?? "/", `http://127.0.0.1`);
      if (url.pathname !== opts.cbPath) {
        res.writeHead(404).end("not found");
        return;
      }
      const error = url.searchParams.get("error");
      if (error) {
        sendHtml(res, "Pairing cancelled", `The bridge did not receive authorization. (${error})`);
        cleanup(new Error(`oauth flow returned error: ${error}`));
        return;
      }
      const code = url.searchParams.get("code");
      const state = url.searchParams.get("state");
      if (!code) {
        sendHtml(res, "Missing code", "The redirect carried no authorization code. Try again.");
        cleanup(new Error("missing code in callback"));
        return;
      }
      if (state !== opts.expectedState) {
        sendHtml(res, "State mismatch", "CSRF guard rejected this redirect. Restart pairing.");
        cleanup(new Error("oauth state mismatch (possible CSRF)"));
        return;
      }
      sendHtml(
        res,
        "You can close this tab",
        "The bridge has captured the authorization. Return to your terminal.",
      );
      const boundPort = (server.address() as AddressInfo).port;
      cleanup(null, { code, boundPort });
    });

    let timer: NodeJS.Timeout | null = null;
    let settled = false;

    function cleanup(err: Error | null, value?: { code: string; boundPort: number }) {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      server.close();
      if (err) reject(err);
      else if (value) resolve(value);
    }

    server.on("error", (err) => cleanup(err));
    server.listen(opts.desiredPort, "127.0.0.1", () => {
      const boundPort = (server.address() as AddressInfo).port;
      timer = setTimeout(
        () => cleanup(new Error(`pairing timed out after ${opts.timeoutMs}ms`)),
        opts.timeoutMs,
      );
      opts.onListening(boundPort);
    });
  });
}

function sendHtml(res: http.ServerResponse, title: string, body: string) {
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  res.end(`<!doctype html><html><head><meta charset="utf-8"><title>${title}</title>
<style>body{font-family:-apple-system,system-ui,sans-serif;background:#0a1422;color:#fff;padding:48px;line-height:1.5}h1{font-weight:600;margin-bottom:12px}p{opacity:.78}</style>
</head><body><h1>${title}</h1><p>${body}</p></body></html>`);
}

function buildConsentUrl(opts: {
  webUrl: string;
  clientId: string;
  redirectUri: string;
  scope: string;
  state: string;
  codeChallenge: string;
}): string {
  const url = new URL("/oauth/connect", opts.webUrl);
  url.searchParams.set("client_id", opts.clientId);
  url.searchParams.set("redirect_uri", opts.redirectUri);
  url.searchParams.set("scope", opts.scope);
  url.searchParams.set("state", opts.state);
  url.searchParams.set("code_challenge", opts.codeChallenge);
  url.searchParams.set("code_challenge_method", "S256");
  return url.toString();
}

function newPkceVerifier(): string {
  return crypto.randomBytes(32).toString("base64url");
}

function pkceChallenge(verifier: string): string {
  return crypto.createHash("sha256").update(verifier).digest("base64url");
}

function defaultBrowserOpen(url: string): void {
  const cmd =
    process.platform === "darwin"
      ? "open"
      : process.platform === "win32"
        ? "cmd"
        : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
  try {
    const child = spawn(cmd, args, { stdio: "ignore", detached: true });
    child.on("error", () => undefined);
    child.unref();
  } catch {
    /* swallow */
  }
}

/**
 * Headless device-code pairing. For machines that can't open a browser:
 * print a short user code, the user signs in elsewhere and approves the
 * code, the bridge polls until it receives a scoped channel-link token.
 *
 * Provider held at "openclaw" for now (see ./login-oauth.ts).
 */
import {
  HelloAgentApiError,
  linkChannel,
  oauthPollDeviceToken,
  oauthStartDeviceAuthorization,
} from "@helloagentai/sdk";

import {
  CREDS_VERSION,
  DEFAULT_ACCOUNT_ID,
  type Creds,
  writeCreds,
} from "./store.js";

const CHANNEL_PROVIDER = "openclaw";

export type DevicePairOptions = {
  agentName: string;
  clientId: string;
  apiUrl: string;
  accountId?: string;
  timeoutMs?: number;
  onProgress?: (line: string) => void;
};

const DEFAULT_TIMEOUT_MS = 15 * 60 * 1000;

export async function pairWithDeviceCode(opts: DevicePairOptions): Promise<Creds> {
  const accountId = opts.accountId ?? DEFAULT_ACCOUNT_ID;
  const log = opts.onProgress ?? ((s: string) => console.log(s));

  const device = await oauthStartDeviceAuthorization({
    clientId: opts.clientId,
    apiUrl: opts.apiUrl,
  });

  log(`open ${device.verification_uri}`);
  log(`enter code: ${device.user_code}`);

  const deadline =
    Date.now() + Math.min(opts.timeoutMs ?? DEFAULT_TIMEOUT_MS, device.expires_in * 1000);
  const intervalMs = Math.max(device.interval, 1) * 1000;
  let accessToken = "";

  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, intervalMs));
    try {
      const tokenResp = await oauthPollDeviceToken({
        clientId: opts.clientId,
        deviceCode: device.device_code,
        apiUrl: opts.apiUrl,
      });
      accessToken = tokenResp.access_token;
      break;
    } catch (e) {
      if (e instanceof HelloAgentApiError && e.code === "authorization_pending") {
        continue;
      }
      throw e;
    }
  }

  if (!accessToken) {
    throw new Error("device authorization timed out");
  }

  const linkResp = await linkChannel({
    provider: CHANNEL_PROVIDER,
    token: accessToken,
    agentName: opts.agentName,
    apiUrl: opts.apiUrl,
  });

  const creds: Creds = {
    version: CREDS_VERSION,
    handle: linkResp.handle,
    agentName: linkResp.agent_name,
    ownerHandle: linkResp.user_handle,
    token: linkResp.token,
    apiUrl: opts.apiUrl,
    serverWs: linkResp.relay_ws,
    linkedAt: new Date().toISOString(),
    source: "device",
  };
  await writeCreds(creds, accountId);
  log(`linked as @${creds.handle}`);
  return creds;
}

/**
 * OAuth code exchange + channel link + persistence. Takes the authorization
 * code captured by the loopback server (./login.ts), trades it for a scoped
 * access token, calls `/v1/channels/openclaw/link`, persists the returned
 * ha_* token to disk.
 *
 * NOTE: provider is hardcoded to "openclaw" because the relay's
 * `channelProviders` map (relay/internal/api/channels.go) only knows
 * "openclaw" today. Functionally identical for our purposes — the relay
 * just labels the link that way. Switch to "hermes" once the relay
 * registers it.
 */
import {
  HelloAgentApiError,
  linkChannel,
  oauthExchangeToken,
} from "@helloagentai/sdk";

import {
  CREDS_VERSION,
  DEFAULT_ACCOUNT_ID,
  type Creds,
  writeCreds,
} from "./store.js";

const CHANNEL_PROVIDER = "openclaw"; // TODO: switch to "hermes" once relay supports

export type ExchangeAndPersistOptions = {
  code: string;
  agentName: string;
  clientId: string;
  clientSecret?: string;
  codeVerifier?: string;
  redirectUri: string;
  apiUrl: string;
  accountId?: string;
};

export async function exchangeAndPersist(
  opts: ExchangeAndPersistOptions,
): Promise<Creds> {
  const accountId = opts.accountId ?? DEFAULT_ACCOUNT_ID;

  const tokenResp = await oauthExchangeToken({
    code: opts.code,
    clientId: opts.clientId,
    clientSecret: opts.clientSecret,
    codeVerifier: opts.codeVerifier,
    redirectUri: opts.redirectUri,
    apiUrl: opts.apiUrl,
  });

  const linkResp = await linkChannel({
    provider: CHANNEL_PROVIDER,
    token: tokenResp.access_token,
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
    relayWs: linkResp.relay_ws,
    linkedAt: new Date().toISOString(),
    source: "oauth",
  };
  await writeCreds(creds, accountId);
  return creds;
}

export { HelloAgentApiError };

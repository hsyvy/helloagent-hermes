/**
 * Manual fallback: paste an existing HelloAgent ha_* agent token, validate
 * by completing one WebSocket auth handshake against the relay, then
 * persist it under the bridge's credential dir.
 *
 * Lifted from openclaw-HelloAgent/src/auth/import-token.ts with imports
 * pointed at the bridge-local store.
 */
import { Agent, AuthFailedError } from "@helloagent/sdk";

import {
  CREDS_VERSION,
  DEFAULT_ACCOUNT_ID,
  type Creds,
  writeCreds,
} from "./store.js";

export type ImportTokenOptions = {
  token: string;
  apiUrl: string;
  relayWs: string;
  accountId?: string;
  timeoutMs?: number;
  onProgress?: (line: string) => void;
};

export async function importToken(opts: ImportTokenOptions): Promise<Creds> {
  const accountId = opts.accountId ?? DEFAULT_ACCOUNT_ID;
  const log = opts.onProgress ?? ((s: string) => console.log(s));
  const handle = await resolveHandleFromToken(
    opts.token,
    opts.relayWs,
    opts.timeoutMs,
  );
  const { ownerHandle, agentName } = splitHandle(handle);

  const creds: Creds = {
    version: CREDS_VERSION,
    handle,
    agentName,
    ownerHandle,
    token: opts.token,
    apiUrl: opts.apiUrl,
    relayWs: opts.relayWs,
    linkedAt: new Date().toISOString(),
    source: "manual",
  };
  await writeCreds(creds, accountId);
  log(`imported token for @${creds.handle}`);
  return creds;
}

async function resolveHandleFromToken(
  token: string,
  relayWs: string,
  timeoutMs = 30_000,
): Promise<string> {
  if (!token.startsWith("ha_")) {
    throw new Error("expected an ha_* agent token");
  }

  let authFailure: AuthFailedError | undefined;
  const agent = new Agent({
    token,
    relayUrl: relayWs,
    reconnect: { initialMs: 100, maxMs: 100 },
    logger: { warn: () => undefined, error: () => undefined },
    onAuthFailed: (err) => {
      authFailure = err;
    },
  });
  const run = agent.run();
  const deadline = Date.now() + timeoutMs;
  try {
    while (Date.now() < deadline) {
      if (agent.handle) return agent.handle;
      if (authFailure) {
        throw new Error(`token rejected by relay: ${authFailure.detail}`);
      }
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error("token validation timed out");
  } finally {
    agent.stop();
    await Promise.race([
      run.catch(() => undefined),
      new Promise((r) => setTimeout(r, 250)),
    ]);
  }
}

function splitHandle(handle: string): { ownerHandle: string; agentName: string } {
  const idx = handle.indexOf("/");
  if (idx < 0) return { ownerHandle: "", agentName: handle };
  return { ownerHandle: handle.slice(0, idx), agentName: handle.slice(idx + 1) };
}

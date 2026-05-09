#!/usr/bin/env node
/**
 * helloagent-hermes — bridge CLI.
 *
 * Commands:
 *   pair               Pair with HelloAgent. Default: PKCE OAuth (browser).
 *     --device         Headless device-code flow.
 *     --token <T> --relay-ws <URL>  Manual ha_* token import (no browser).
 *     --agent-name <N> Suffix used after your handle (default: hermes).
 *     --api-url <URL>  HelloAgent REST base.   Env: HA_HERMES_BRIDGE_API_URL
 *     --web-url <URL>  HelloAgent web base.    Env: HA_HERMES_BRIDGE_WEB_URL
 *     --account <ID>   Account id for multi-account setups (default: default).
 *
 *   run                Start the bridge (relay client + wschat server).
 *     --port <N>       wschat bind port (default 8770).
 *     --host <H>       wschat bind host (default 127.0.0.1).
 *     --wschat-token <T>  Optional shared secret Hermes must echo in hello.
 *     --account <ID>   Account id to load creds from.
 *
 *   status             Show paired accounts and creds metadata.
 *
 *   logout             Delete creds for the given account.
 *     --account <ID>   Account id (default: default).
 *
 * Defaults:
 *   API URL  https://api.helloagent.cc
 *   Web URL  https://app.helloagent.cc
 *   Client   helloagent-hermes
 */
import { pairWithBrowser } from "./auth/login.js";
import { pairWithDeviceCode } from "./auth/login-device.js";
import { importToken } from "./auth/import-token.js";
import { hasAnyAuth } from "./auth/presence.js";
import {
  DEFAULT_ACCOUNT_ID,
  deleteCreds,
  listLinkedAccountIds,
  readCreds,
} from "./auth/store.js";
import { createBridge } from "./bridge.js";
import { logger } from "./core/logger.js";

const log = logger("cli");

type Argv = {
  command: string;
  flags: Record<string, string | boolean>;
};

function parseArgs(argv: string[]): Argv {
  const [command, ...rest] = argv;
  const flags: Record<string, string | boolean> = {};
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (!arg.startsWith("--")) continue;
    const name = arg.slice(2);
    const next = rest[i + 1];
    if (!next || next.startsWith("--")) {
      flags[name] = true;
    } else {
      flags[name] = next;
      i++;
    }
  }
  return { command: command ?? "help", flags };
}

function envOrDefault(envName: string, fallback: string): string {
  return process.env[envName]?.trim() || fallback;
}

const DEFAULTS = {
  apiUrl: () => envOrDefault("HA_HERMES_BRIDGE_API_URL", "https://api.helloagent.cc"),
  webUrl: () => envOrDefault("HA_HERMES_BRIDGE_WEB_URL", "https://app.helloagent.cc"),
  clientId: () => envOrDefault("HA_HERMES_BRIDGE_CLIENT_ID", "helloagent-hermes"),
  agentName: "hermes",
  port: 8770,
  host: "127.0.0.1",
};

async function cmdPair(flags: Argv["flags"]): Promise<void> {
  const accountId = String(flags.account ?? DEFAULT_ACCOUNT_ID);
  const apiUrl = String(flags["api-url"] ?? DEFAULTS.apiUrl());
  const agentName = String(flags["agent-name"] ?? DEFAULTS.agentName);
  const clientId = String(flags["client-id"] ?? DEFAULTS.clientId());

  // Manual import path
  if (typeof flags.token === "string" && flags.token) {
    const relayWs = String(flags["relay-ws"] ?? "");
    if (!relayWs) throw new Error("--relay-ws is required with --token");
    const creds = await importToken({
      token: String(flags.token),
      apiUrl,
      relayWs,
      accountId,
      onProgress: (l) => console.log(l),
    });
    console.log(`✓ paired as @${creds.handle}`);
    return;
  }

  // Device-code path
  if (flags.device) {
    const creds = await pairWithDeviceCode({
      agentName,
      clientId,
      apiUrl,
      accountId,
      onProgress: (l) => console.log(l),
    });
    console.log(`✓ paired as @${creds.handle}`);
    return;
  }

  // Browser PKCE path (default)
  const webUrl = String(flags["web-url"] ?? DEFAULTS.webUrl());
  const creds = await pairWithBrowser({
    agentName,
    clientId,
    apiUrl,
    webUrl,
    accountId,
    onProgress: (l) => console.log(l),
  });
  console.log(`✓ paired as @${creds.handle}`);
}

async function cmdRun(flags: Argv["flags"]): Promise<void> {
  const accountId = String(flags.account ?? DEFAULT_ACCOUNT_ID);
  const creds = await readCreds(accountId);
  if (!creds) {
    throw new Error(
      `no paired account "${accountId}". Run 'helloagent-hermes pair' first.`,
    );
  }
  const port = Number(flags.port ?? DEFAULTS.port);
  const host = String(flags.host ?? DEFAULTS.host);
  const wschatToken =
    typeof flags["wschat-token"] === "string"
      ? String(flags["wschat-token"])
      : undefined;

  const bridge = createBridge({
    account: {
      accountId,
      handle: creds.handle,
      agentName: creds.agentName,
      ownerHandle: creds.ownerHandle,
      token: creds.token,
      apiUrl: creds.apiUrl,
      relayWs: creds.relayWs,
    },
    host,
    port,
    wschatToken,
  });

  const onShutdown = async () => {
    log.info("shutdown signal received");
    await bridge.stop();
    process.exit(0);
  };
  process.once("SIGINT", () => void onShutdown());
  process.once("SIGTERM", () => void onShutdown());

  await bridge.start();
  console.log(`bridge running:`);
  console.log(`  HelloAgent handle:  @${creds.handle}`);
  console.log(`  wschat endpoint:    ws://${host}:${port}`);
  console.log(`  point Hermes at:    WSCHAT_URL=ws://${host}:${port}`);
  console.log(`Press Ctrl+C to stop.`);
}

async function cmdStatus(): Promise<void> {
  const ids = await listLinkedAccountIds();
  if (ids.length === 0) {
    console.log("No paired accounts.");
    console.log("Run 'helloagent-hermes pair' to link one.");
    return;
  }
  for (const id of ids) {
    const creds = await readCreds(id);
    if (!creds) continue;
    console.log(`account: ${id}`);
    console.log(`  handle:    @${creds.handle}`);
    console.log(`  api:       ${creds.apiUrl}`);
    console.log(`  relay:     ${creds.relayWs}`);
    console.log(`  linked:    ${creds.linkedAt}`);
    console.log(`  source:    ${creds.source ?? "(unknown)"}`);
  }
}

async function cmdLogout(flags: Argv["flags"]): Promise<void> {
  const accountId = String(flags.account ?? DEFAULT_ACCOUNT_ID);
  const creds = await readCreds(accountId);
  if (!creds) {
    console.log(`No paired account "${accountId}".`);
    return;
  }
  await deleteCreds(accountId);
  console.log(`✓ removed creds for @${creds.handle} (${accountId})`);
  console.log(
    "Note: the relay-side agent token is not revoked — delete via the HelloAgent web UI or DELETE /v1/channels/<provider>.",
  );
}

function printHelp(): void {
  console.log(`helloagent-hermes — bridge HelloAgent users to a Hermes agent

Usage:
  helloagent-hermes pair [--device | --token <T> --relay-ws <URL>] [--agent-name <N>]
  helloagent-hermes run  [--port <N>] [--host <H>] [--wschat-token <T>]
  helloagent-hermes status
  helloagent-hermes logout [--account <ID>]

Examples:
  # 1. Pair (browser PKCE)
  helloagent-hermes pair --agent-name jarvis

  # 2. Pair (manual token import for advanced users)
  helloagent-hermes pair --token ha_xxx --relay-ws ws://localhost:8080/v1/ws

  # 3. Run the bridge
  helloagent-hermes run --port 8770

  # 4. Then in Hermes (with the wschat plugin installed):
  WSCHAT_URL=ws://127.0.0.1:8770 hermes gateway

Env overrides:
  HA_HERMES_BRIDGE_DIR       state dir (default ~/.helloagent-hermes)
  HA_HERMES_BRIDGE_API_URL   default --api-url
  HA_HERMES_BRIDGE_WEB_URL   default --web-url
  HA_HERMES_BRIDGE_CLIENT_ID default --client-id
  HA_HERMES_BRIDGE_DEBUG=1   verbose logs
`);
}

async function main(): Promise<void> {
  const { command, flags } = parseArgs(process.argv.slice(2));
  if (command === "help" || flags.help) {
    printHelp();
    return;
  }
  switch (command) {
    case "pair":
      await cmdPair(flags);
      return;
    case "run":
      await cmdRun(flags);
      return;
    case "status":
      await cmdStatus();
      return;
    case "logout":
      await cmdLogout(flags);
      return;
    default:
      console.error(`unknown command: ${command}\n`);
      printHelp();
      process.exit(1);
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  if (process.env.HA_HERMES_BRIDGE_DEBUG === "1" && err instanceof Error && err.stack) {
    console.error(err.stack);
  }
  process.exit(1);
});

// Re-export hasAnyAuth so external embedders / tests can probe quickly.
export { hasAnyAuth };

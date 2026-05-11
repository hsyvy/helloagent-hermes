#!/usr/bin/env node
/**
 * helloagent-hermes — CLI.
 *
 * Commands:
 *   pair               Pair (if not paired) and start the bridge as a
 *                      background daemon. Prompts for an `ha_*` agent
 *                      token interactively.
 *
 *     --token <T>      Skip the prompt; use this token directly (e.g. CI).
 *     --account <ID>   Account id for multi-account setups (default: default).
 *     --re-pair        Stop any running bridge, discard creds, prompt again.
 *
 *   status             Show paired account info and whether the bridge
 *                      daemon is running.
 *
 *   stop               Stop the running bridge daemon.
 *
 *   logout             Stop the bridge and delete creds.
 *     --account <ID>   Account id (default: default).
 *
 *   uninstall          Stop the bridge and remove ALL local state (every
 *                      account's creds, the daemon log, the state dir).
 *                      Prompts to confirm.
 *     --yes            Skip the confirmation prompt (for scripting).
 *
 * State files (under ~/.helloagent-hermes/):
 *   credentials/<accountId>/creds.json   pair output (chmod 0600)
 *   bridge.pid                           PID of the running daemon
 *   bridge.log                           verbose daemon log
 *
 * Defaults baked in:
 *   API URL    https://api.helloagent.cc
 *   Server WS  wss://api.helloagent.cc/v1/ws
 *   Bind       ws://127.0.0.1:8770
 *
 * Env-var escape hatches (local dev / advanced):
 *   HA_HERMES_BRIDGE_API_URL    override REST API url
 *   HA_HERMES_BRIDGE_SERVER_WS  override server WS url
 *   HA_HERMES_BRIDGE_HOST       override bind host (default 127.0.0.1)
 *   HA_HERMES_BRIDGE_PORT       override bind port (default 8770)
 *   HA_HERMES_BRIDGE_TOKEN      shared secret the agent must echo in hello
 *   HA_HERMES_BRIDGE_DIR        state dir (default ~/.helloagent-hermes)
 *   HA_HERMES_BRIDGE_DEBUG=1    verbose CLI logs (the daemon is always verbose
 *                               in its log file)
 */
import { spawn, type ChildProcess } from "node:child_process";
import * as fs from "node:fs/promises";
import os from "node:os";
import * as path from "node:path";
import * as readline from "node:readline/promises";
import { stdin, stdout } from "node:process";

import { importToken } from "./auth/import-token.js";
import {
  type Creds,
  CredsFormatError,
  DEFAULT_ACCOUNT_ID,
  deleteCreds,
  listLinkedAccountIds,
  readCredsLenient,
  readCreds,
  resolveStateDir,
} from "./auth/store.js";
import { createBridge } from "./bridge.js";

const PAIRING_URL = "https://app.helloagent.cc/app/agents/new";
const DEFAULT_STATE_DIR = path.join(os.homedir(), ".helloagent-hermes");

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

function envOr<T extends string | number>(envName: string, fallback: T): T {
  const v = process.env[envName]?.trim();
  if (!v) return fallback;
  return (typeof fallback === "number" ? Number(v) : v) as T;
}

const DEFAULTS = {
  apiUrl: () => envOr("HA_HERMES_BRIDGE_API_URL", "https://api.helloagent.cc"),
  serverWs: () => envOr("HA_HERMES_BRIDGE_SERVER_WS", "wss://api.helloagent.cc/v1/ws"),
  host: () => envOr("HA_HERMES_BRIDGE_HOST", "127.0.0.1"),
  port: () => envOr("HA_HERMES_BRIDGE_PORT", 8770),
  socketToken: () => process.env.HA_HERMES_BRIDGE_TOKEN?.trim() || undefined,
};

const pidPath = () => path.join(resolveStateDir(), "bridge.pid");
const logPath = () => path.join(resolveStateDir(), "bridge.log");

function assertDefaultUninstallTarget(stateDir: string): void {
  const configuredStateDir = path.resolve(stateDir);
  const allowedStateDir = path.resolve(DEFAULT_STATE_DIR);
  const authDirOverride = process.env.HA_HERMES_BRIDGE_AUTH_DIR?.trim();

  if (configuredStateDir === allowedStateDir && !authDirOverride) return;

  const overrideDetail = authDirOverride
    ? `\nHA_HERMES_BRIDGE_AUTH_DIR is set to ${authDirOverride}`
    : "";
  throw new Error(
    `refusing to uninstall outside the default state dir\n` +
      `configured state dir: ${stateDir}\n` +
      `allowed state dir:    ${DEFAULT_STATE_DIR}${overrideDetail}\n` +
      `Unset HA_HERMES_BRIDGE_DIR/HA_HERMES_BRIDGE_AUTH_DIR or remove custom state manually.`,
  );
}

async function readRunningPid(): Promise<number | null> {
  let raw: string;
  try {
    raw = await fs.readFile(pidPath(), "utf-8");
  } catch {
    return null;
  }
  const pid = parseInt(raw.trim(), 10);
  if (!Number.isFinite(pid) || pid <= 0) return null;
  try {
    process.kill(pid, 0); // probe
    return pid;
  } catch {
    // Stale PID; clean up.
    await fs.unlink(pidPath()).catch(() => undefined);
    return null;
  }
}

async function promptForToken(): Promise<string> {
  console.log("");
  console.log("Link this bridge to a HelloAgent account:");
  console.log("");
  console.log(`  1. Open ${PAIRING_URL}`);
  console.log(`  2. Create an agent and copy its token (starts with "ha_")`);
  console.log("  3. Paste the token below");
  console.log("");
  const rl = readline.createInterface({ input: stdin, output: stdout });
  try {
    const answer = await rl.question("Token: ");
    return answer.trim();
  } finally {
    rl.close();
  }
}

async function ensurePaired(flags: Argv["flags"]): Promise<Creds> {
  const accountId = String(flags.account ?? DEFAULT_ACCOUNT_ID);
  const force = Boolean(flags["re-pair"]);

  const existing = force ? null : await readCreds(accountId);
  if (existing) return existing;

  const token =
    typeof flags.token === "string" && flags.token
      ? flags.token.trim()
      : await promptForToken();

  if (!token) throw new Error("token is required");
  if (!token.startsWith("ha_")) {
    throw new Error('expected an "ha_..." agent token');
  }

  const creds = await importToken({
    token,
    apiUrl: DEFAULTS.apiUrl(),
    serverWs: DEFAULTS.serverWs(),
    accountId,
    onProgress: (l) => console.log(l),
  });
  return creds;
}

function waitForDaemonReady(child: ChildProcess, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false;

    const cleanup = () => {
      clearTimeout(timer);
      child.off("message", onMessage);
      child.off("exit", onExit);
      child.off("error", onError);
    };

    const finish = (err?: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (err) reject(err);
      else resolve();
    };

    const onMessage = (message: unknown) => {
      if (
        typeof message === "object" &&
        message !== null &&
        (message as { type?: unknown }).type === "ready"
      ) {
        finish();
      }
    };

    const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
      const detail = signal ? `signal ${signal}` : `code ${code ?? "unknown"}`;
      finish(
        new Error(
          `bridge daemon exited before ready (${detail}). Check ${logPath()} for details.`,
        ),
      );
    };

    const onError = (err: Error) => {
      finish(err);
    };

    const timer = setTimeout(() => {
      finish(
        new Error(
          `bridge daemon did not become ready within ${timeoutMs}ms. Check ${logPath()} for details.`,
        ),
      );
    }, timeoutMs);

    child.once("message", onMessage);
    child.once("exit", onExit);
    child.once("error", onError);
  });
}

async function spawnDaemon(accountId: string): Promise<{ pid: number }> {
  const stateDir = resolveStateDir();
  await fs.mkdir(stateDir, { recursive: true });

  const out = await fs.open(logPath(), "a");
  try {
    const child = spawn(
      process.execPath,
      [process.argv[1], "_serve", "--account", accountId],
      {
        detached: true,
        stdio: ["ignore", out.fd, out.fd, "ipc"],
        env: { ...process.env, HA_HERMES_BRIDGE_DEBUG: "1" },
      },
    );
    try {
      if (!child.pid) throw new Error("failed to spawn bridge daemon");
      await fs.writeFile(pidPath(), String(child.pid), { mode: 0o600 });
      await waitForDaemonReady(child, 12_000);
      if (child.connected) child.disconnect();
      child.unref();
      return { pid: child.pid };
    } catch (err) {
      if (child.pid) {
        try {
          process.kill(child.pid, "SIGTERM");
        } catch {
          /* best-effort */
        }
      }
      await fs.unlink(pidPath()).catch(() => undefined);
      throw err;
    }
  } finally {
    await out.close();
  }
}

async function cmdPair(flags: Argv["flags"]): Promise<void> {
  const accountId = String(flags.account ?? DEFAULT_ACCOUNT_ID);

  // If --re-pair, stop any running daemon first.
  if (flags["re-pair"]) await stopDaemon();

  const running = await readRunningPid();
  const creds = await ensurePaired(flags);

  if (running) {
    console.log(`✓ Connected to HelloAgent as @${creds.handle}.`);
    console.log("  Bridge already running — chat through the HelloAgent app or browser.");
    return;
  }

  await spawnDaemon(accountId);

  console.log(`✓ Connected to HelloAgent as @${creds.handle}.`);
  console.log("  You can now chat with your agent through the HelloAgent app or browser.");
}

async function cmdServe(flags: Argv["flags"]): Promise<void> {
  // Hidden subcommand — runs the bridge in the foreground until SIGTERM.
  // Invoked by `pair` via spawn, with stdout/stderr redirected to bridge.log.
  const accountId = String(flags.account ?? DEFAULT_ACCOUNT_ID);
  const creds = await readCreds(accountId);
  if (!creds) {
    throw new Error(`no paired account "${accountId}"`);
  }

  const bridge = createBridge({
    account: {
      accountId,
      handle: creds.handle,
      agentName: creds.agentName,
      ownerHandle: creds.ownerHandle,
      token: creds.token,
      apiUrl: creds.apiUrl,
      serverWs: creds.serverWs,
    },
    host: DEFAULTS.host(),
    port: DEFAULTS.port(),
    socketToken: DEFAULTS.socketToken(),
  });

  const onShutdown = async () => {
    await bridge.stop();
    await fs.unlink(pidPath()).catch(() => undefined);
    process.exit(0);
  };
  process.once("SIGINT", () => void onShutdown());
  process.once("SIGTERM", () => void onShutdown());

  await bridge.start();
  if (typeof process.send === "function") {
    process.send({ type: "ready" });
  }
  // Idle until signaled. setInterval keeps the event loop alive without
  // doing real work; the bridge has its own listeners holding it open.
  setInterval(() => undefined, 1 << 30);
}

async function stopDaemon(): Promise<boolean> {
  const pid = await readRunningPid();
  if (!pid) return false;
  process.kill(pid, "SIGTERM");
  // Wait briefly for it to exit and remove its PID file.
  for (let i = 0; i < 30; i++) {
    if (!(await readRunningPid())) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  // Best-effort cleanup if it didn't go away.
  await fs.unlink(pidPath()).catch(() => undefined);
  return true;
}

async function cmdStop(): Promise<void> {
  const stopped = await stopDaemon();
  if (stopped) console.log("✓ bridge stopped");
  else console.log("No bridge running.");
}

async function cmdStatus(): Promise<void> {
  const ids = await listLinkedAccountIds();
  if (ids.length === 0) {
    console.log("No paired accounts.");
    console.log("Run 'helloagent-hermes pair' to link one.");
    return;
  }
  for (const id of ids) {
    let creds: Creds | null;
    try {
      creds = await readCreds(id);
    } catch (err) {
      if (!(err instanceof CredsFormatError)) throw err;
      console.log(`account: ${id}`);
      console.log(`  creds:     incompatible (${err.message})`);
      continue;
    }
    if (!creds) continue;
    console.log(`account: ${id}`);
    console.log(`  handle:    @${creds.handle}`);
    console.log(`  api:       ${creds.apiUrl}`);
    console.log(`  server:    ${creds.serverWs}`);
    console.log(`  linked:    ${creds.linkedAt}`);
    console.log(`  source:    ${creds.source ?? "(unknown)"}`);
  }
  const pid = await readRunningPid();
  console.log("");
  if (pid) console.log(`bridge: running (pid ${pid}, log ${logPath()})`);
  else console.log("bridge: stopped");
}

async function cmdUninstall(flags: Argv["flags"]): Promise<void> {
  const skipConfirm = Boolean(flags.yes || flags.y);
  const stateDir = resolveStateDir();
  assertDefaultUninstallTarget(stateDir);

  // Discover everything we'd remove, so the user sees the plan first.
  const pid = await readRunningPid();
  const ids = await listLinkedAccountIds();
  const accounts: { id: string; handle?: string }[] = [];
  for (const id of ids) {
    let handle: string | undefined;
    try {
      const c = await readCreds(id);
      handle = c?.handle;
    } catch (err) {
      // Incompatible / malformed creds still get deleted; just no handle.
      if (!(err instanceof CredsFormatError)) throw err;
      const raw = await readCredsLenient(id);
      handle = typeof raw?.handle === "string" ? raw.handle : undefined;
    }
    accounts.push({ id, handle });
  }
  let stateDirExists = true;
  try {
    await fs.access(stateDir);
  } catch {
    stateDirExists = false;
  }

  if (!pid && accounts.length === 0 && !stateDirExists) {
    console.log("Nothing to remove — no daemon running, no paired accounts, no state dir.");
    console.log("");
    console.log("To finish uninstalling, run:  npm uninstall -g @helloagentai/hermes");
    return;
  }

  console.log("This will:");
  if (pid) console.log(`  • stop the bridge daemon (pid ${pid})`);
  for (const a of accounts) {
    const label = a.handle ? `@${a.handle}` : "(no handle)";
    console.log(`  • delete creds for "${a.id}" ${label}`);
  }
  if (stateDirExists) console.log(`  • remove ${stateDir}/ (including bridge.log)`);
  console.log("");

  if (!skipConfirm) {
    const rl = readline.createInterface({ input: stdin, output: stdout });
    let answer: string;
    try {
      answer = (await rl.question("Proceed? [y/N]: ")).trim().toLowerCase();
    } finally {
      rl.close();
    }
    if (answer !== "y" && answer !== "yes") {
      console.log("Aborted.");
      return;
    }
  }

  await stopDaemon();
  for (const a of accounts) {
    await deleteCreds(a.id);
  }
  if (stateDirExists) {
    await fs.rm(stateDir, { recursive: true, force: true });
  }

  console.log("✓ local state removed");
  console.log("");
  console.log("Two things this command can't do for you:");
  console.log("  1. Remove the package:    npm uninstall -g @helloagentai/hermes");
  console.log("  2. Revoke the agent token on the server. Visit");
  console.log("     https://app.helloagent.cc and delete the agent — until you");
  console.log("     do, anyone with the token can still impersonate it.");
}

async function cmdLogout(flags: Argv["flags"]): Promise<void> {
  const accountId = String(flags.account ?? DEFAULT_ACCOUNT_ID);
  let creds: Creds | null = null;
  let invalidCreds = false;
  let invalidHandle: string | undefined;
  try {
    creds = await readCreds(accountId);
  } catch (err) {
    if (!(err instanceof CredsFormatError)) throw err;
    invalidCreds = true;
    const raw = await readCredsLenient(accountId);
    invalidHandle = typeof raw?.handle === "string" ? raw.handle : undefined;
    console.warn(`Deleting incompatible credentials: ${err.message}`);
  }
  if (!creds) {
    if (!invalidCreds) {
      console.log(`No paired account "${accountId}".`);
      return;
    }
  }
  await stopDaemon();
  await deleteCreds(accountId);
  const handle = creds?.handle ?? invalidHandle;
  if (handle) console.log(`✓ removed creds for @${handle} (${accountId})`);
  else console.log(`✓ removed creds for account "${accountId}"`);
  console.log(
    "Note: the server-side agent token is not revoked — delete via the HelloAgent web UI.",
  );
}

function printHelp(): void {
  console.log(`helloagent-hermes — bridge HelloAgent users to a local agent

Usage:
  helloagent-hermes pair       [--token <T>] [--account <ID>] [--re-pair]
  helloagent-hermes status
  helloagent-hermes stop
  helloagent-hermes logout     [--account <ID>]
  helloagent-hermes uninstall  [--yes]

The 'pair' command links the bridge to a HelloAgent agent token (prompts
interactively if not given), then starts the bridge as a background
daemon and returns. Your terminal is free; the bridge keeps running.

To get a token, visit ${PAIRING_URL}, create an agent, and copy its token.

Examples:
  # First-time setup (interactive paste):
  helloagent-hermes pair

  # Subsequent runs (creds already exist — skips the prompt):
  helloagent-hermes pair

  # Non-interactive (CI / scripting):
  helloagent-hermes pair --token ha_xxx

  # Force re-pair against a fresh token:
  helloagent-hermes pair --re-pair

  # Stop the running bridge:
  helloagent-hermes stop

  # Remove all local state (then 'npm uninstall -g @helloagentai/hermes'):
  helloagent-hermes uninstall
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
    case "status":
      await cmdStatus();
      return;
    case "stop":
      await cmdStop();
      return;
    case "logout":
      await cmdLogout(flags);
      return;
    case "uninstall":
      await cmdUninstall(flags);
      return;
    case "_serve":
      await cmdServe(flags);
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

/**
 * Persists per-account HelloAgent credentials to disk.
 *
 * Layout:
 *   <stateDir>/credentials/<accountId>/creds.json
 *   <stateDir>/credentials/<accountId>/creds.json.bak
 *
 * stateDir defaults to ~/.helloagent-hermes; override via HA_HERMES_BRIDGE_DIR
 * (full path to the state dir). For tests, HA_HERMES_BRIDGE_AUTH_DIR can
 * override the credentials dir directly.
 *
 * Atomic writes: temp file + rename, chmod 0600 on the final and the backup.
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

export const CREDS_VERSION = 1;
export const DEFAULT_ACCOUNT_ID = "default";

export type Creds = {
  version: number;
  handle: string;
  agentName: string;
  ownerHandle: string;
  token: string;
  apiUrl: string;
  serverWs: string;
  linkedAt: string;
  source?: "oauth" | "device" | "manual";
};

export function resolveStateDir(): string {
  const explicit = process.env.HA_HERMES_BRIDGE_DIR?.trim();
  if (explicit) return explicit;
  return path.join(os.homedir(), ".helloagent-hermes");
}

export function resolveAuthDir(): string {
  const explicit = process.env.HA_HERMES_BRIDGE_AUTH_DIR?.trim();
  if (explicit) return explicit;
  return path.join(resolveStateDir(), "credentials");
}

export function accountAuthDir(accountId: string = DEFAULT_ACCOUNT_ID): string {
  return path.join(resolveAuthDir(), accountId);
}

function credsPath(accountId: string = DEFAULT_ACCOUNT_ID): string {
  return path.join(accountAuthDir(accountId), "creds.json");
}

function backupPath(accountId: string = DEFAULT_ACCOUNT_ID): string {
  return path.join(accountAuthDir(accountId), "creds.json.bak");
}

export async function readCreds(
  accountId: string = DEFAULT_ACCOUNT_ID,
): Promise<Creds | null> {
  try {
    const raw = await fs.readFile(credsPath(accountId), "utf-8");
    const parsed = JSON.parse(raw) as Creds;
    if (parsed.version !== CREDS_VERSION) {
      throw new Error(
        `creds at ${credsPath(accountId)} are version ${parsed.version}, expected ${CREDS_VERSION}. Run 'helloagent-hermes pair' to re-link, or 'helloagent-hermes logout --account ${accountId}' to delete.`,
      );
    }
    return parsed;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw e;
  }
}

export async function writeCreds(
  creds: Creds,
  accountId: string = DEFAULT_ACCOUNT_ID,
): Promise<void> {
  const dir = accountAuthDir(accountId);
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  const final = credsPath(accountId);
  const tmp = `${final}.tmp.${process.pid}.${Date.now()}`;
  const payload = JSON.stringify(creds, null, 2) + "\n";
  await fs.writeFile(tmp, payload, { mode: 0o600 });

  try {
    const existing = await fs.readFile(final);
    await fs.writeFile(backupPath(accountId), existing, { mode: 0o600 });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }

  await fs.rename(tmp, final);
  await fs.chmod(final, 0o600);
}

export async function deleteCreds(
  accountId: string = DEFAULT_ACCOUNT_ID,
): Promise<void> {
  for (const p of [credsPath(accountId), backupPath(accountId)]) {
    try {
      await fs.unlink(p);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    }
  }
}

export async function listLinkedAccountIds(): Promise<string[]> {
  const dir = resolveAuthDir();
  let entries: import("node:fs").Dirent[];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw e;
  }
  const linked: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    try {
      await fs.access(path.join(dir, entry.name, "creds.json"));
      linked.push(entry.name);
    } catch {
      /* missing creds.json, skip */
    }
  }
  return linked;
}

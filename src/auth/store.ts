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

export const CREDS_VERSION = 2;
export const DEFAULT_ACCOUNT_ID = "default";

export class CredsFormatError extends Error {
  constructor(
    message: string,
    readonly path: string,
  ) {
    super(message);
    this.name = "CredsFormatError";
  }
}

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

function recoveryHint(accountId: string): string {
  return `Run 'helloagent-hermes pair --re-pair --account ${accountId}' to re-link, or 'helloagent-hermes logout --account ${accountId}' to delete.`;
}

function formatError(accountId: string, reason: string): CredsFormatError {
  const file = credsPath(accountId);
  return new CredsFormatError(
    `creds at ${file} ${reason}. ${recoveryHint(accountId)}`,
    file,
  );
}

function validateCreds(parsed: unknown, accountId: string): Creds {
  if (typeof parsed !== "object" || parsed === null) {
    throw formatError(accountId, "are not a JSON object");
  }

  const candidate = parsed as Partial<Creds>;
  if (candidate.version !== CREDS_VERSION) {
    throw formatError(
      accountId,
      `are version ${String(candidate.version)}, expected ${CREDS_VERSION}`,
    );
  }

  const requiredStrings = [
    "handle",
    "agentName",
    "ownerHandle",
    "token",
    "apiUrl",
    "serverWs",
    "linkedAt",
  ] as const;
  for (const field of requiredStrings) {
    if (typeof candidate[field] !== "string" || candidate[field].length === 0) {
      const hint = field === "serverWs"
        ? "; this looks like an older credentials file"
        : "";
      throw formatError(accountId, `are missing ${field}${hint}`);
    }
  }

  return candidate as Creds;
}

export async function readCreds(
  accountId: string = DEFAULT_ACCOUNT_ID,
): Promise<Creds | null> {
  try {
    const raw = await fs.readFile(credsPath(accountId), "utf-8");
    return validateCreds(JSON.parse(raw), accountId);
  } catch (e) {
    if (e instanceof SyntaxError) {
      throw formatError(accountId, "contain invalid JSON");
    }
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw e;
  }
}

export async function readCredsLenient(
  accountId: string = DEFAULT_ACCOUNT_ID,
): Promise<Partial<Creds> | null> {
  try {
    const raw = await fs.readFile(credsPath(accountId), "utf-8");
    const parsed = JSON.parse(raw) as Partial<Creds>;
    return typeof parsed === "object" && parsed !== null ? parsed : {};
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
    if (e instanceof SyntaxError) return {};
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

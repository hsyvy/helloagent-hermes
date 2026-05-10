/**
 * Per-account managed HelloAgent SDK client.
 *
 * Wraps `Agent` from `@helloagentai/sdk` and tracks lifecycle status
 * (starting → ready → needs_repairing → stopped) plus a typed inbound
 * handler.
 */
import { Agent, AuthFailedError, type IncomingMessage } from "@helloagentai/sdk";

import { logger } from "./logger.js";
import type { ResolvedAccount } from "./types.js";

const log = logger("core/ha-client");

export type ClientStatus = "starting" | "ready" | "needs_repairing" | "stopped";

type ClientStatusListener = (status: ClientStatus, detail?: string) => void;

type IncomingHandler = (
  msg: IncomingMessage,
) => string | Promise<string> | AsyncIterable<string>;

export type HaClientOptions = {
  account: ResolvedAccount;
  onStatus?: ClientStatusListener;
  onIncoming?: IncomingHandler;
};

export class HaClient {
  readonly account: ResolvedAccount;
  readonly agent: Agent;
  readonly ready: Promise<void>;

  status: ClientStatus = "starting";
  detail?: string;

  private readonly onStatus?: ClientStatusListener;

  constructor(opts: HaClientOptions) {
    this.account = opts.account;
    this.onStatus = opts.onStatus;

    this.agent = new Agent({
      token: opts.account.token,
      relayUrl: opts.account.serverWs,
      onAuthFailed: (err: AuthFailedError) => this.handleAuthFailed(err),
      logger: {
        warn: (msg: string, ...args: unknown[]) =>
          log.warn(`sdk: ${msg}`, args.length ? { args } : undefined),
        error: (msg: string, ...args: unknown[]) =>
          log.error(`sdk: ${msg}`, args.length ? { args } : undefined),
      },
    });

    if (opts.onIncoming) {
      this.agent.onMessage(opts.onIncoming);
    }

    this.ready = this.waitForHandle();

    // Long-lived run loop; exceptions surface via reconnect/log paths.
    this.agent.run().catch(() => {
      /* terminal — stop() ends the loop cleanly */
    });

    this.emitStatus("starting");
  }

  send(toHandle: string, text: string, conversationId?: string): string {
    if (this.status !== "ready") {
      throw new Error(`ha-client: not ready (status=${this.status})`);
    }
    return this.agent.send(toHandle, text, conversationId);
  }

  stop(): void {
    if (this.status === "stopped") return;
    try {
      this.agent.stop();
    } catch {
      /* swallow — agent may already be torn down */
    }
    this.status = "stopped";
    this.emitStatus("stopped");
  }

  private handleAuthFailed(err: AuthFailedError): void {
    this.status = "needs_repairing";
    this.detail = err.detail;
    this.emitStatus("needs_repairing", err.detail);
  }

  private async waitForHandle(): Promise<void> {
    const deadlineMs = 10_000;
    const startedAt = Date.now();
    while (Date.now() - startedAt < deadlineMs) {
      if (this.agent.handle === this.account.handle) {
        if (this.status === "starting") {
          this.status = "ready";
          this.emitStatus("ready");
        }
        return;
      }
      if (this.status === "needs_repairing") {
        throw new Error(
          `pairing required: ${this.detail ?? "auth failed"}`,
        );
      }
      if (this.status === "stopped") {
        throw new Error("stopped before ready");
      }
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error(`handle not resolved within ${deadlineMs}ms`);
  }

  private emitStatus(status: ClientStatus, detail?: string): void {
    log.info(`status → ${status}${detail ? ` (${detail})` : ""}`);
    this.onStatus?.(status, detail);
  }
}

/** Shared types for the bridge. */

export type ResolvedAccount = {
  /** Account id used to namespace creds on disk. Defaults to "default". */
  accountId: string;
  /** Full HelloAgent handle, e.g. "alice/jarvis". */
  handle: string;
  /** Suffix after the slash. */
  agentName: string;
  /** Owner handle (before the slash). */
  ownerHandle: string;
  /** Long-lived ha_* token. */
  token: string;
  /** REST API base. */
  apiUrl: string;
  /** HelloAgent server WebSocket URL. */
  serverWs: string;
};

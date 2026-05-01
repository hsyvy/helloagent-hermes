/**
 * TTL + LRU dedup for inbound messages from the relay. Prevents
 * double-dispatch after relay reconnects (the Agent SDK can replay messages
 * within its delivery window). Mirrors the shape used by openclaw-HelloAgent
 * but trimmed to the inputs we actually need.
 */

const DEFAULT_TTL_MS = 5 * 60 * 1000;
const DEFAULT_MAX = 2000;

export class MessageDedup {
  private readonly seen = new Map<string, number>();
  private readonly ttlMs: number;
  private readonly maxEntries: number;

  constructor(opts: { ttlMs?: number; maxEntries?: number } = {}) {
    this.ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS;
    this.maxEntries = opts.maxEntries ?? DEFAULT_MAX;
  }

  /** Returns true if `id` is a fresh message; false if it's a duplicate. */
  tryRecord(id: string): boolean {
    const now = Date.now();
    this.evictExpired(now);

    const prior = this.seen.get(id);
    if (prior !== undefined && now - prior < this.ttlMs) {
      return false;
    }
    this.seen.set(id, now);

    if (this.seen.size > this.maxEntries) {
      // Cheap LRU-ish eviction: drop the oldest 10% by insertion order.
      const drop = Math.ceil(this.maxEntries * 0.1);
      let dropped = 0;
      for (const key of this.seen.keys()) {
        if (dropped >= drop) break;
        this.seen.delete(key);
        dropped++;
      }
    }
    return true;
  }

  private evictExpired(now: number): void {
    const cutoff = now - this.ttlMs;
    for (const [id, t] of this.seen) {
      if (t < cutoff) this.seen.delete(id);
    }
  }
}

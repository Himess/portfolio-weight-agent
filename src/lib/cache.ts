/**
 * A bounded TTL cache.
 *
 * Bounded matters: the sparkline cache was a plain Map keyed by symbol with no
 * eviction, so a long-running server accumulated an entry for every symbol
 * anyone ever searched and never released one. Small per entry, unbounded over
 * time — the shape of a leak.
 *
 * Eviction is least-recently-used. Map preserves insertion order and re-setting
 * a key moves it to the end, so a read that re-inserts is enough to maintain
 * recency without a second structure.
 */

export type CacheOptions = { ttlMs: number; max: number };

type Entry<V> = { value: V; expiresAt: number };

export class TtlCache<V> {
  private readonly map = new Map<string, Entry<V>>();

  constructor(private readonly opts: CacheOptions) {}

  get(key: string): V | undefined {
    const hit = this.map.get(key);
    if (!hit) return undefined;

    if (Date.now() >= hit.expiresAt) {
      this.map.delete(key);
      return undefined;
    }

    // Touch: re-insert so this key becomes the most recently used.
    this.map.delete(key);
    this.map.set(key, hit);
    return hit.value;
  }

  set(key: string, value: V): void {
    // Delete first so an update also refreshes recency.
    this.map.delete(key);
    this.map.set(key, { value, expiresAt: Date.now() + this.opts.ttlMs });

    while (this.map.size > this.opts.max) {
      // Map iteration order is insertion order, so the first key is the LRU.
      const oldest = this.map.keys().next();
      if (oldest.done) break;
      this.map.delete(oldest.value);
    }
  }

  /** Read-through: compute and store on a miss, with in-flight de-duplication. */
  private readonly inflight = new Map<string, Promise<V>>();

  async wrap(key: string, produce: () => Promise<V>): Promise<V> {
    const hit = this.get(key);
    if (hit !== undefined) return hit;

    // Two requests arriving together on a cold key should make one upstream
    // call, not two. This is the difference between a burst of traffic being
    // absorbed and being amplified.
    const pending = this.inflight.get(key);
    if (pending) return pending;

    const promise = produce()
      .then((value) => {
        this.set(key, value);
        return value;
      })
      .finally(() => {
        this.inflight.delete(key);
      });

    this.inflight.set(key, promise);
    return promise;
  }

  delete(key: string): void {
    this.map.delete(key);
  }

  clear(): void {
    this.map.clear();
    this.inflight.clear();
  }

  get size(): number {
    return this.map.size;
  }
}

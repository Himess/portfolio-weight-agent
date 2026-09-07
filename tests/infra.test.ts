import { afterEach, describe, expect, it, vi } from "vitest";

import { TtlCache } from "../src/lib/cache";
import { HttpError, TimeoutError, fetchJson, fetchJsonFrom, isRetryable } from "../src/lib/http";
import { failure } from "../src/server/respond";

describe("TtlCache", () => {
  afterEach(() => vi.useRealTimers());

  it("returns a stored value and forgets it after the TTL", () => {
    vi.useFakeTimers();
    const c = new TtlCache<number>({ ttlMs: 1000, max: 10 });
    c.set("a", 1);
    expect(c.get("a")).toBe(1);

    vi.advanceTimersByTime(1001);
    expect(c.get("a")).toBeUndefined();
    // An expired entry is dropped, not merely hidden.
    expect(c.size).toBe(0);
  });

  it("evicts the least recently used once full", () => {
    const c = new TtlCache<number>({ ttlMs: 60_000, max: 3 });
    c.set("a", 1);
    c.set("b", 2);
    c.set("c", 3);

    c.get("a"); // a becomes most recent, b is now the oldest
    c.set("d", 4);

    expect(c.size).toBe(3);
    expect(c.get("b")).toBeUndefined();
    expect(c.get("a")).toBe(1);
    expect(c.get("d")).toBe(4);
  });

  it("stays bounded under sustained writes — the leak this replaced", () => {
    const c = new TtlCache<number>({ ttlMs: 60_000, max: 50 });
    for (let i = 0; i < 5000; i++) c.set(`k${i}`, i);
    expect(c.size).toBe(50);
  });

  it("makes one upstream call when two readers race a cold key", async () => {
    const c = new TtlCache<string>({ ttlMs: 60_000, max: 10 });
    let calls = 0;
    const produce = async () => {
      calls++;
      await new Promise((r) => setTimeout(r, 20));
      return "value";
    };

    const [x, y] = await Promise.all([c.wrap("k", produce), c.wrap("k", produce)]);
    expect(x).toBe("value");
    expect(y).toBe("value");
    expect(calls).toBe(1);
  });

  it("does not cache a failed production, and lets the next caller retry", async () => {
    const c = new TtlCache<string>({ ttlMs: 60_000, max: 10 });
    await expect(c.wrap("k", async () => { throw new Error("boom"); })).rejects.toThrow("boom");
    // The failure must not be remembered as a value or wedge the in-flight slot.
    await expect(c.wrap("k", async () => "recovered")).resolves.toBe("recovered");
  });
});

describe("retry policy", () => {
  it("retries what can clear on its own", () => {
    expect(isRetryable(new TimeoutError("u", 1))).toBe(true);
    expect(isRetryable(new HttpError(429, "u", ""))).toBe(true);
    expect(isRetryable(new HttpError(503, "u", ""))).toBe(true);
    expect(isRetryable(new TypeError("network"))).toBe(true);
  });

  it("does not retry what will fail identically", () => {
    // Sending a bad request again only burns the deadline.
    expect(isRetryable(new HttpError(400, "u", ""))).toBe(false);
    expect(isRetryable(new HttpError(404, "u", ""))).toBe(false);
    expect(isRetryable(new Error("plain"))).toBe(false);
  });
});

describe("fetchJson", () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
    vi.restoreAllMocks();
  });

  it("retries a 500 and succeeds on a later attempt", async () => {
    let n = 0;
    globalThis.fetch = vi.fn(async () => {
      n++;
      return n < 3
        ? new Response("upstream sad", { status: 500 })
        : new Response(JSON.stringify({ ok: true }), { status: 200 });
    }) as unknown as typeof fetch;

    await expect(fetchJson("https://x.test/a", { backoffMs: 1 })).resolves.toEqual({ ok: true });
    expect(n).toBe(3);
  });

  it("gives up on a 400 after a single attempt", async () => {
    let n = 0;
    globalThis.fetch = vi.fn(async () => {
      n++;
      return new Response("bad", { status: 400 });
    }) as unknown as typeof fetch;

    await expect(fetchJson("https://x.test/a", { backoffMs: 1 })).rejects.toBeInstanceOf(HttpError);
    expect(n).toBe(1);
  });

  it("reports malformed JSON against the URL that produced it", async () => {
    globalThis.fetch = vi.fn(async () => new Response("<html>nope", { status: 200 })) as unknown as typeof fetch;
    await expect(fetchJson("https://x.test/a")).rejects.toThrow(/Malformed JSON/);
  });

  it("falls through to the mirror when the primary host is geo-blocked", async () => {
    const seen: string[] = [];
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      seen.push(url);
      return url.includes("primary")
        ? new Response("blocked", { status: 451 })
        : new Response(JSON.stringify({ from: "mirror" }), { status: 200 });
    }) as unknown as typeof fetch;

    const out = await fetchJsonFrom(["https://primary.test", "https://mirror.test"], "/p", { backoffMs: 1 });
    expect(out).toEqual({ from: "mirror" });
    expect(seen.some((u) => u.startsWith("https://mirror.test"))).toBe(true);
  });

  it("does not try the next host for a request that is simply wrong", async () => {
    let n = 0;
    globalThis.fetch = vi.fn(async () => {
      n++;
      return new Response("bad symbol", { status: 400 });
    }) as unknown as typeof fetch;

    await expect(
      fetchJsonFrom(["https://a.test", "https://b.test"], "/p", { backoffMs: 1 }),
    ).rejects.toBeInstanceOf(HttpError);
    expect(n).toBe(1);
  });
});

describe("errors name the upstream that actually failed", () => {
  async function body(res: Response) {
    return (await res.json()) as { error: string; code: string; retryable: boolean };
  }

  it("blames Telegram for a Telegram failure", async () => {
    const res = failure(
      new HttpError(401, "https://api.telegram.org/bot123/getMe", "Unauthorized"),
      "Creating the watch",
    );
    const json = await body(res);
    expect(json.error).toContain("Telegram returned HTTP 401");
    expect(json.error).not.toContain("Binance");
  });

  it("still blames Binance for a Binance failure", async () => {
    const res = failure(new HttpError(418, "https://api.binance.com/api/v3/ticker", ""), "The review");
    expect((await body(res)).error).toContain("Binance returned HTTP 418");
  });

  it("names the model provider rather than an exchange", async () => {
    const res = failure(
      new HttpError(429, "https://generativelanguage.googleapis.com/v1beta/openai/chat", ""),
      "The review",
    );
    const json = await body(res);
    expect(json.error).toContain("model provider is rate-limiting");
    expect(json.code).toBe("rate_limited");
  });

  it("names the upstream on a timeout too", async () => {
    const res = failure(new TimeoutError("https://api.telegram.org/bot123/sendMessage", 12000), "Alerting");
    expect((await body(res)).error).toContain("waiting for Telegram");
  });

  it("survives an unparseable url without claiming a vendor", async () => {
    const res = failure(new HttpError(500, "not-a-url", ""), "Something");
    expect((await body(res)).error).toContain("the upstream service");
  });
});

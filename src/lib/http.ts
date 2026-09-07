/**
 * Upstream HTTP with a deadline and a retry policy.
 *
 * Market-data calls had neither. A hung Binance connection held a request open
 * until something else gave up, and a single transient 5xx failed a whole
 * review — which the user sees as "the agent is broken" rather than "one call
 * blipped".
 *
 * The policy is deliberately narrow. Retrying is only safe for requests with no
 * side effects, and only worth it for failures that plausibly clear on their
 * own: network errors, timeouts, 429 and 5xx. A 400 means the request was
 * wrong; sending it again just wastes the deadline.
 */

export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly url: string,
    readonly body: string,
  ) {
    super(`HTTP ${status} from ${url}: ${body.slice(0, 200)}`);
    this.name = "HttpError";
  }
}

export class TimeoutError extends Error {
  constructor(readonly url: string, readonly ms: number) {
    super(`Timed out after ${ms}ms: ${url}`);
    this.name = "TimeoutError";
  }
}

export type FetchOptions = {
  timeoutMs?: number;
  retries?: number;
  /** Base backoff; each attempt waits base * 2^n plus jitter. */
  backoffMs?: number;
  headers?: Record<string, string>;
  signal?: AbortSignal;
  method?: "GET" | "POST" | "PUT" | "DELETE";
  /** Serialised body. Callers set their own Content-Type. */
  body?: string;
};

const DEFAULTS = { timeoutMs: 10_000, retries: 2, backoffMs: 300 };

/**
 * A GET can be repeated safely; a POST cannot. Retrying a timed-out
 * sendMessage is how one alert becomes three, so anything that writes gets one
 * attempt unless the caller explicitly asks for more.
 */
function defaultRetries(method: string | undefined): number {
  return method && method !== "GET" ? 0 : DEFAULTS.retries;
}

export function isRetryable(err: unknown): boolean {
  if (err instanceof TimeoutError) return true;
  if (err instanceof HttpError) return err.status === 429 || err.status >= 500;
  // Network-level failures (DNS, reset, refused) surface as TypeError from fetch.
  return err instanceof TypeError;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function fetchText(url: string, options: FetchOptions = {}): Promise<string> {
  const timeoutMs = options.timeoutMs ?? DEFAULTS.timeoutMs;
  const retries = options.retries ?? defaultRetries(options.method);
  const backoffMs = options.backoffMs ?? DEFAULTS.backoffMs;

  let lastError: unknown;

  for (let attempt = 0; attempt <= retries; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    // Honour a caller's cancellation as well as our own deadline.
    const onAbort = () => controller.abort();
    options.signal?.addEventListener("abort", onAbort);

    try {
      const res = await fetch(url, {
        method: options.method,
        body: options.body,
        signal: controller.signal,
        headers: { Accept: "application/json", ...options.headers },
      });

      if (!res.ok) throw new HttpError(res.status, url, await res.text());
      return await res.text();
    } catch (err) {
      // Distinguish our deadline from the caller cancelling.
      if (err instanceof DOMException && err.name === "AbortError") {
        lastError = options.signal?.aborted ? err : new TimeoutError(url, timeoutMs);
      } else {
        lastError = err;
      }

      if (options.signal?.aborted) throw lastError;
      if (attempt === retries || !isRetryable(lastError)) throw lastError;

      // Exponential backoff with jitter, so parallel callers do not retry in lockstep.
      const wait = backoffMs * 2 ** attempt + Math.random() * backoffMs;
      await sleep(wait);
    } finally {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
    }
  }

  throw lastError instanceof Error ? lastError : new Error(`Request failed: ${url}`);
}

export async function fetchJson<T>(url: string, options: FetchOptions = {}): Promise<T> {
  const text = await fetchText(url, options);
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error(`Malformed JSON from ${url}: ${text.slice(0, 120)}`);
  }
}

/**
 * Try each host in order, moving on when one is unreachable or geo-blocked.
 * Binance's primary API answers 451 in some regions; the market-data mirror
 * serves the same payloads.
 */
export async function fetchJsonFrom<T>(
  hosts: readonly string[],
  path: string,
  options: FetchOptions = {},
): Promise<T> {
  let lastError: unknown;
  for (const host of hosts) {
    try {
      return await fetchJson<T>(`${host}${path}`, options);
    } catch (err) {
      lastError = err;
      // A 4xx that is not a geo-block is the request's fault, not the host's —
      // the next host would reject it identically.
      if (err instanceof HttpError && err.status < 500 && err.status !== 429 && err.status !== 451 && err.status !== 403) {
        throw err;
      }
    }
  }
  throw lastError instanceof Error ? lastError : new Error(`All hosts failed for ${path}`);
}

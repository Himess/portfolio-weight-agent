/** Display formatting. The single place deterministic figures become strings. */

export function usd(n: number, opts: { compact?: boolean } = {}): string {
  if (!Number.isFinite(n)) return "$0";
  const abs = Math.abs(n);
  const sign = n < 0 ? "-" : "";
  if (opts.compact && abs >= 1_000_000) return `${sign}$${(abs / 1_000_000).toFixed(2)}M`;
  if (opts.compact && abs >= 10_000) return `${sign}$${(abs / 1000).toFixed(1)}k`;
  if (abs >= 1000) return `${sign}$${abs.toLocaleString("en-US", { maximumFractionDigits: 0 })}`;
  if (abs >= 1) return `${sign}$${abs.toFixed(2)}`;
  return `${sign}$${abs.toFixed(4)}`;
}

export function pct(n: number, dp = 1): string {
  return `${Number.isFinite(n) ? n.toFixed(dp) : "0.0"}%`;
}

export function pp(n: number, dp = 1): string {
  const v = Number.isFinite(n) ? n : 0;
  return `${v > 0 ? "+" : ""}${v.toFixed(dp)}pp`;
}

export function ppAbs(n: number, dp = 1): string {
  return `${Number.isFinite(n) ? Math.abs(n).toFixed(dp) : "0.0"}pp`;
}

export function qty(n: number): string {
  if (!Number.isFinite(n)) return "0";
  return n.toFixed(8).replace(/\.?0+$/, "");
}

export function bps(n: number): string {
  return `${Number.isFinite(n) ? n.toFixed(1) : "0.0"} bps`;
}

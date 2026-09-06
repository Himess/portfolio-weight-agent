"use client";

/**
 * Route-level error boundary.
 *
 * Without this a thrown render error leaves a blank white page — the worst
 * possible failure for something showing financial figures, because it is
 * indistinguishable from "nothing to show". Say what happened, make recovery
 * one click, and state plainly that nothing was sent.
 */

import { useEffect } from "react";

export default function Error({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error("[ui] unhandled error", error);
  }, [error]);

  return (
    <main style={{ maxWidth: 640, margin: "0 auto", padding: "80px 26px" }}>
      <div className="card card-p-lg">
        <span className="pill pill-red" style={{ fontWeight: 700 }}>
          Something broke
        </span>

        <h1 style={{ fontSize: 22, fontWeight: 700, margin: "16px 0 0", letterSpacing: "-0.02em" }}>
          The interface hit an error
        </h1>

        <p style={{ fontSize: 14, color: "var(--ink-2)", lineHeight: 1.6, margin: "12px 0 0" }}>
          No order was placed and nothing was sent to Binance — this app cannot execute anything
          without your explicit confirmation, and that step was never reached. Your saved allocation
          is untouched.
        </p>

        <pre
          style={{
            marginTop: 16,
            padding: "12px 14px",
            borderRadius: "var(--r-sm)",
            background: "var(--surface-2)",
            border: "1px solid var(--line)",
            fontSize: 11.5,
            fontFamily: "var(--mono)",
            color: "var(--ink-2)",
            whiteSpace: "pre-wrap",
            wordBreak: "break-word",
            margin: "16px 0 0",
          }}
        >
          {error.message || "Unknown error"}
          {error.digest ? `\n\ndigest: ${error.digest}` : ""}
        </pre>

        <div style={{ display: "flex", gap: 10, marginTop: 20 }}>
          <button className="btn btn-primary" onClick={reset}>
            Try again
          </button>
          <button className="btn" onClick={() => window.location.reload()}>
            Reload the page
          </button>
        </div>
      </div>
    </main>
  );
}

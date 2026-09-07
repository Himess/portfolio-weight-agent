/**
 * What an alert actually says.
 *
 * Separated from the scan so it can be rendered and read without sending
 * anything — `npm run watch:preview` prints a real message from real data, and
 * the tests assert on the text rather than on a mock of the Telegram API.
 *
 * The rule from the narrative layer holds here too: every figure in the message
 * is formatted from a number the deterministic core produced. Nothing is
 * retyped, nothing is rounded twice, and the model's prose is inserted as prose
 * — it never supplies a digit.
 */

import { pct, usd } from "./format";
import type { WatchVerdict } from "./watch";
import type { DriftRow, PortfolioState } from "../types";

/** Telegram's HTML mode rejects a malformed message outright; escape everything interpolated. */
export function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export type MessageInput = {
  label: string | null;
  preference: string;
  state: PortfolioState;
  breached: string[];
  verdict: WatchVerdict;
  /** `headline\n\nbody` from the narrative layer. Empty for the in-band case. */
  narrative: string;
  fellBack: boolean;
};

function driftLine(r: DriftRow): string {
  const over = r.driftPp >= 0;
  return (
    `• <b>${esc(r.symbol)}</b> ${pct(r.currentWeight * 100, 1)} against a ${pct(r.targetWeight * 100, 1)} target` +
    ` — ${over ? "+" : "−"}${Math.abs(r.driftPp).toFixed(1)}pp ${over ? "over" : "under"}, band ±${r.bandPp.toFixed(1)}pp`
  );
}

/**
 * The narrative is always `headline\n\nbody`. The headline carries the verdict
 * in the user's own terms — the same sentence the app puts at the top of the
 * proposal, so an alert and the screen never say different things.
 */
export function splitNarrative(narrative: string): { headline: string; body: string } {
  const i = narrative.indexOf("\n\n");
  if (i < 0) return { headline: narrative.trim(), body: "" };
  return { headline: narrative.slice(0, i).trim(), body: narrative.slice(i + 2).trim() };
}

export function composeMessage(input: MessageInput): string {
  if (input.verdict === "IN_BAND") {
    return [
      `<b>Back inside its bands</b>`,
      ``,
      `Everything in ${esc(input.label ?? "your allocation")} is within tolerance again.` +
        ` Total drift is ${input.state.totalDriftPp.toFixed(1)}pp on ${usd(input.state.navUsd)}.`,
      ``,
      `<i>Nothing to do. You will not hear from the agent again until something moves out of band.</i>`,
    ].join("\n");
  }

  const { headline, body } = splitNarrative(input.narrative);
  const rows = input.state.rows.filter((r) => input.breached.includes(r.symbol));

  const lines = [`<b>${esc(headline)}</b>`, ``];
  if (body) lines.push(esc(body), ``);

  lines.push(`<b>Outside its band</b>`, rows.map(driftLine).join("\n"), ``);
  lines.push(
    `<i>${usd(input.state.navUsd)} · ${input.state.totalDriftPp.toFixed(1)}pp total drift · ${esc(input.preference)} tracking</i>`,
  );

  lines.push(
    ``,
    input.verdict === "HOLD"
      ? `<i>Nothing to approve. You will hear from the agent when that changes.</i>`
      : `<i>Nothing has been ordered. Open the app to review and approve.</i>`,
  );

  // A fallback is the deterministic default, not a considered call. Saying so
  // is the difference between an honest alert and one that overstates itself.
  if (input.fellBack) {
    lines.push(
      ``,
      `<i>The judgment layer was unavailable, so this is the deterministic default rather than a considered call.</i>`,
    );
  }

  return lines.join("\n");
}

/** Telegram HTML, rendered back to plain text — for previews and tests. */
export function toPlainText(html: string): string {
  return html
    .replace(/<\/?(b|i|u|s|code|pre)>/g, "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

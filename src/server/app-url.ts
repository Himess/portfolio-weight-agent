/**
 * Where this deployment lives, for links that leave the app.
 *
 * A Telegram message has no referrer to work from, so the URL has to be
 * derived. APP_URL wins when set — it is the only way to name a custom domain.
 * Otherwise Vercel's production hostname is used in preference to VERCEL_URL,
 * which points at the individual deployment and would send someone to a build
 * that is no longer current.
 */
export function appUrl(fallbackFrom?: Request): string {
  const explicit = process.env.APP_URL?.replace(/\/$/, "");
  if (explicit) return explicit;

  const vercel = process.env.VERCEL_PROJECT_PRODUCTION_URL ?? process.env.VERCEL_URL;
  if (vercel) return `https://${vercel}`;

  return fallbackFrom ? new URL(fallbackFrom.url).origin : "http://localhost:3000";
}

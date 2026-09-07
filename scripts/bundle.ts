/**
 * Pack the project into files you can hand to another Claude.
 *
 * A code review that only sees code gives advice about code. The interesting
 * questions here are about *judgement* — where the boundary between arithmetic
 * and the model should sit, whether the measurements support the defaults,
 * what is missing — and none of that is visible from a directory listing. So
 * the bundle leads with an orientation document that states the thesis, the
 * non-negotiables, what has already been measured, and what is still open.
 * Without it the reply is a generic lint pass.
 *
 * Sources come from `git ls-files`, never a directory walk. That is the whole
 * secret-safety story: .env, the captured windows, the watch store and
 * .vercel/ are gitignored, so they cannot reach a file that is about to be
 * uploaded somewhere. Anything untracked is invisible to this script by
 * construction rather than by a blocklist someone has to remember to update.
 *
 * Usage:
 *   npm run bundle
 */

import { mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import path from "node:path";

const ROOT = process.cwd();
const OUT = path.join(ROOT, "bundle");

/** Tracked files only — see the note above about why this is not a walk. */
function tracked(): string[] {
  return execFileSync("git", ["ls-files"], { cwd: ROOT, encoding: "utf8" })
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Large, generated, or not ours. Data files are named individually below. */
const SKIP = [
  /^data\//, // replay captures: megabytes of numbers, no discussion value
  /^PortfolioAgentUI\.jsx$/, // the reference UI this was built from, not our code
  /^next-env\.d\.ts$/,
  /package-lock\.json$/,
  /^\.gitkeep$/,
  /tsconfig\.tsbuildinfo$/,
];

const LANG: Record<string, string> = {
  ".ts": "ts",
  ".tsx": "tsx",
  ".js": "js",
  ".mjs": "js",
  ".css": "css",
  ".json": "json",
  ".md": "md",
};

type Section = { file: string; title: string; blurb: string; match: (p: string) => boolean };

/**
 * Split along the architecture, not alphabetically. Each part is a layer with
 * one job, which is also how the design is meant to be argued about.
 */
const SECTIONS: Section[] = [
  {
    file: "01-core-deterministic.md",
    title: "The deterministic core",
    blurb:
      "Pure functions. Every number the user ever sees originates here. No I/O, no model, no clock of their own. If you want to argue that something should move *into* this layer, this is the file to argue from.",
    match: (p) => p.startsWith("src/core/") || p.startsWith("src/lib/"),
  },
  {
    file: "02-llm-judgment.md",
    title: "The judgment layer",
    blurb:
      "The only places a model is consulted, and the guardrails around each. Prompts, schemas, fallbacks, and the checks that reject a response rather than trusting it. The central claim of the product lives or dies here.",
    match: (p) => p.startsWith("src/llm/") || p === "src/agent.ts" || p === "src/types.ts",
  },
  {
    file: "03-server-and-adapters.md",
    title: "Adapters, API routes and server plumbing",
    blurb:
      "Where the app meets Binance, Telegram and the browser. Market data, the MCP client, sealed sessions, rate limiting, the watch store, and every HTTP route.",
    match: (p) =>
      p.startsWith("src/adapters/") || p.startsWith("src/server/") || p.startsWith("src/app/api/"),
  },
  {
    file: "04-ui.md",
    title: "The interface",
    blurb:
      "Four screens plus the conversational surface. Styling is a small set of tokens extracted from a reference design; layout is hand-rolled rather than a component library.",
    match: (p) =>
      (p.startsWith("src/app/") && !p.startsWith("src/app/api/")) || p.endsWith(".css"),
  },
  {
    file: "05-tests.md",
    title: "Tests",
    blurb:
      "176 of them, all runnable without an API key. Several encode a bug that was actually hit; those comments are the interesting part.",
    match: (p) => p.startsWith("tests/"),
  },
  {
    file: "06-scripts.md",
    title: "Measurement and capture scripts",
    blurb:
      "Every figure quoted in the docs is produced by one of these. They are the reason the README can claim numbers rather than adjectives.",
    match: (p) => p.startsWith("scripts/"),
  },
  {
    file: "07-docs-and-config.md",
    title: "Docs, spec and configuration",
    blurb:
      "The original design spec with its amendments, the README, the alerts document, and build configuration.",
    match: (p) =>
      p.startsWith("docs/") ||
      p.startsWith(".claude/") ||
      // Dotfiles at the root are configuration too, and which files are
      // *excluded* from git and from the deploy is part of the design.
      (!p.includes("/") &&
        (p.startsWith(".") ||
          p.endsWith(".md") ||
          p.endsWith(".json") ||
          p.endsWith(".ts") ||
          p.endsWith(".mjs"))),
  },
];

function fence(p: string, body: string): string {
  const lang = LANG[path.extname(p)] ?? "";
  // A file containing a fence would break the outer one; four backticks is
  // enough for anything realistic here and keeps the output diffable.
  const ticks = body.includes("```") ? "````" : "```";
  return `\n### \`${p}\`\n\n${ticks}${lang}\n${body.replace(/\s+$/, "")}\n${ticks}\n`;
}

function tree(files: string[]): string {
  const dirs = new Map<string, string[]>();
  for (const f of files) {
    const dir = f.includes("/") ? f.slice(0, f.lastIndexOf("/")) : ".";
    if (!dirs.has(dir)) dirs.set(dir, []);
    dirs.get(dir)!.push(f.slice(dir === "." ? 0 : dir.length + 1));
  }
  return [...dirs.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([dir, names]) => `${dir}/\n  ${names.sort().join("\n  ")}`)
    .join("\n\n");
}

async function main() {
  const files = tracked().filter((f) => !SKIP.some((re) => re.test(f)));
  await rm(OUT, { recursive: true, force: true });
  await mkdir(OUT, { recursive: true });

  const bodies = new Map<string, string>();
  for (const f of files) {
    bodies.set(f, await readFile(path.join(ROOT, f), "utf8"));
  }

  const orientation = await readFile(path.join(ROOT, "scripts", "bundle-intro.md"), "utf8");
  const claimed = new Set<string>();
  const written: { name: string; bytes: number; count: number }[] = [];

  const intro = orientation.replace("{{TREE}}", tree(files));
  await writeFile(path.join(OUT, "00-START-HERE.md"), intro, "utf8");
  written.push({ name: "00-START-HERE.md", bytes: intro.length, count: 0 });

  const parts: string[] = [intro];

  for (const section of SECTIONS) {
    const mine = files.filter((f) => !claimed.has(f) && section.match(f)).sort();
    mine.forEach((f) => claimed.add(f));
    if (mine.length === 0) continue;

    const text =
      `# ${section.title}\n\n${section.blurb}\n\n` +
      `${mine.length} files.\n\n---\n` +
      mine.map((f) => fence(f, bodies.get(f)!)).join("\n");

    await writeFile(path.join(OUT, section.file), text, "utf8");
    written.push({ name: section.file, bytes: text.length, count: mine.length });
    parts.push(text);
  }

  const orphans = files.filter((f) => !claimed.has(f));
  if (orphans.length > 0) {
    // A file no section claims is a gap in this script, not something to drop
    // silently — the whole point is that the bundle is the whole project.
    const text = `# Everything else\n\n${orphans.length} files no section claimed.\n\n---\n` +
      orphans.map((f) => fence(f, bodies.get(f)!)).join("\n");
    await writeFile(path.join(OUT, "08-other.md"), text, "utf8");
    written.push({ name: "08-other.md", bytes: text.length, count: orphans.length });
    parts.push(text);
  }

  const all = parts.join("\n\n---\n\n");
  await writeFile(path.join(OUT, "ALL-IN-ONE.md"), all, "utf8");

  const kb = (n: number) => `${(n / 1024).toFixed(0)} KB`;
  console.log(`bundle/  —  ${files.length} files packed\n`);
  for (const w of written) {
    console.log(`  ${w.name.padEnd(28)} ${kb(w.bytes).padStart(8)}  ${w.count ? `${w.count} files` : "orientation"}`);
  }
  console.log(`  ${"ALL-IN-ONE.md".padEnd(28)} ${kb(all.length).padStart(8)}  everything above, concatenated`);
  console.log(`\nUpload 00-START-HERE.md first — it is what turns a lint pass into a design review.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

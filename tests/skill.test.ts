import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

/**
 * The Skills Hub skill, checked against the format the hub actually publishes.
 *
 * Two things this guards. First, the frontmatter: the hub's README documents a
 * `title:` field, but all nineteen published skills use `name:` — so the format
 * here is taken from the skills rather than from the prose about them, and a
 * silent drift back would be invisible until a PR bounced.
 *
 * Second, the copy. The skill lives at `skills/` because that is where the hub
 * expects it and where a PR mirrors from, and at `.claude/skills/` because that
 * is where Claude Code actually loads it from. Two copies of a document drift,
 * so this fails the moment they stop being the same file.
 */

const CANONICAL = "skills/portfolio-weight-agent/SKILL.md";

/**
 * Every client wants the skill somewhere different — Claude Code reads
 * `.claude/skills/`, the cross-agent convention is `.agents/skills/`, and the
 * hub wants `skills/`. Copies are listed rather than globbed so that adding a
 * client is a deliberate line here, and forgetting to sync one is a red test.
 *
 * This is not hypothetical: `.agents/` was added an hour after this file and was
 * already a section behind.
 */
const COPIES = [
  ".claude/skills/portfolio-weight-agent/SKILL.md",
  ".agents/skills/portfolio-weight-agent/SKILL.md",
];

/** Git may check these out with CRLF; the format is about fields, not bytes. */
const read = (f: string) => readFileSync(f, "utf8").split("\r\n").join("\n");

const raw = read(CANONICAL);

function frontmatter(text: string): Record<string, string> {
  const end = text.indexOf("\n---\n", 4);
  expect(text.startsWith("---\n")).toBe(true);
  expect(end).toBeGreaterThan(0);

  const block = text.slice(4, end);
  const fields: Record<string, string> = {};
  let key: string | null = null;
  for (const line of block.split("\n")) {
    const top = /^([A-Za-z][A-Za-z0-9_-]*):\s?(.*)$/.exec(line);
    if (top && !line.startsWith(" ")) {
      key = top[1];
      fields[key] = top[2];
    } else if (key) {
      fields[key] += `\n${line}`;
    }
  }
  return fields;
}

describe("the Skills Hub skill", () => {
  const fields = frontmatter(raw);

  it("uses the frontmatter fields the published skills use", () => {
    // name and description appear in 19/19; metadata in 18/19.
    expect(fields.name).toBe("portfolio-weight-agent");
    expect(fields).toHaveProperty("description");
    expect(fields).toHaveProperty("metadata");
    expect(fields.license?.trim()).toBe("MIT");
  });

  it("carries an author and a quoted version, as the hub does", () => {
    expect(fields.metadata).toMatch(/author:/);
    expect(fields.metadata).toMatch(/version: "\d+\.\d+\.\d+"/);
  });

  it("describes when to trigger and when not to", () => {
    // A description that only says what a skill does fires on everything
    // adjacent to it. Every published skill states its intents; the good ones
    // also state what they are not for.
    expect(fields.description).toMatch(/Use when/i);
    expect(fields.description).toMatch(/Do NOT use/i);
  });

  it("states the boundary the whole product rests on", () => {
    expect(raw).toMatch(/never places an order/i);
    expect(raw).toMatch(/## What this skill cannot do/);
  });

  it("points at tools this server actually exposes", () => {
    for (const tool of [
      "set_allocation",
      "review_portfolio",
      "propose_rebalance",
      "explain_decision",
      "list_decisions",
    ]) {
      expect(raw).toContain(tool);
    }
  });

  it.each(COPIES)("is identical to the copy at %s", (copy) => {
    expect(read(copy)).toBe(raw);
  });
});

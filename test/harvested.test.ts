import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { compile, ZshPatternError, type ZshOptionsInput } from "../src/index.js";
import patternTexts from "./fixtures/patterns.json" with { type: "json" };
import subjectTexts from "./fixtures/subjects.json" with { type: "json" };

/**
 * Every pattern zsh's test suite compiles, matched against a fixed set of
 * subjects under **every combination** of the options that can change the
 * result, with the answers supplied by the zsh built from ./zsh.
 *
 * Each row is "<combination bitmask, hex>\t<bitstring>\t<index>", where the
 * index points into fixtures/patterns.json: a pattern may contain a tab or a
 * newline, which a line based fixture cannot carry, so the texts live in JSON.
 * One row per distinct outcome, tagged with the combinations that produce it.
 * See scripts/harvest-patterns.mjs and scripts/compress-sweep.mjs.
 */
const lines = readFileSync(
  fileURLToPath(new URL("./fixtures/harvested.txt", import.meta.url)),
  "utf8",
).split("\n");

const header = new Map(
  lines
    .filter((line) => line.startsWith("#"))
    .map((line) => {
      const tab = line.indexOf("\t");
      return [line.slice(1, tab), line.slice(tab + 1)] as [string, string];
    }),
);

const zshVersion = header.get("zsh") ?? "unknown";
/**
 * Subjects come from JSON for the same reason the patterns do: some hold bytes
 * that are not characters, kept as `0xDC00 + byte` the way zsh represents them.
 */
const subjects = subjectTexts as string[];
/** Option names in bit order, as swept by scripts/harvest-patterns.mjs. */
const optionNames = (header.get("options") ?? "").split("\t");

/** zsh option name to the name this package uses. */
const OPTION_KEYS: Record<string, keyof ZshOptionsInput> = {
  extendedglob: "extendedGlob",
  kshglob: "kshGlob",
  shglob: "shGlob",
  multibyte: "multibyte",
  posixidentifiers: "posixIdentifiers",
  caseglob: "caseGlob",
  badpattern: "badPattern",
};

function optionsFor(combo: number): ZshOptionsInput {
  const options: ZshOptionsInput = {};
  for (const [bit, name] of optionNames.entries()) {
    const key = OPTION_KEYS[name];
    if (!key) throw new Error(`unknown option in fixture: ${name}`);
    (options as Record<string, boolean>)[key] = ((combo >> bit) & 1) === 1;
  }
  return options;
}

interface Row {
  combos: number[];
  /** Empty when zsh refused the pattern under these options. */
  expected: string;
  rejected: boolean;
  pattern: string;
}

const rows: Row[] = [];
for (const line of lines) {
  if (line.startsWith("#") || line.length === 0) continue;
  const t1 = line.indexOf("\t");
  const t2 = line.indexOf("\t", t1 + 1);
  const maskText = line.slice(0, t1);
  const rejected = maskText.endsWith("!");
  const mask = BigInt(`0x${rejected ? maskText.slice(0, -1) : maskText}`);
  const combos: number[] = [];
  for (let bit = 0; bit < 1 << optionNames.length; bit++) {
    if ((mask >> BigInt(bit)) & 1n) combos.push(bit);
  }
  const index = Number(line.slice(t2 + 1));
  rows.push({
    combos,
    rejected,
    expected: line.slice(t1 + 1, t2),
    pattern: (patternTexts as string[])[index - 1],
  });
}

/**
 * A leading `~` is filename expansion, which the harness defeats by prefixing
 * a sentinel to the pattern and to every subject; the same rule applies here so
 * the two agree.  See scripts/harvest-patterns.mjs.
 */
const TILDE_SENTINEL = "Z";
const prefixFor = (pattern: string) => (pattern.startsWith("~") ? TILDE_SENTINEL : "");

const describeCombo = (combo: number) =>
  optionNames
    .map((name, bit) => (((combo >> bit) & 1) === 1 ? name : `no${name}`))
    .join(" ");

describe("patterns from zsh's test suite, swept over option combinations", () => {
  it(`has a corpus, answered by zsh ${zshVersion}`, () => {
    expect(patternTexts.length).toBeGreaterThan(4000);
    expect(rows.every((row) => typeof row.pattern === "string")).toBe(true);
    expect(subjects.length).toBeGreaterThan(50);
    expect(optionNames.length).toBeGreaterThan(3);
    expect(rows.length).toBeGreaterThan(3000);
    const pairs = rows.reduce((sum, row) => sum + row.combos.length, 0);
    expect(pairs).toBeGreaterThan(90_000);
  });

  for (const { combos, rejected, expected, pattern } of rows) {
    const label = JSON.stringify(pattern);
    const count = `${combos.length} combination${combos.length === 1 ? "" : "s"}`;
    if (rejected) {
      // `BAD_PATTERN` is only consulted for filename generation, so a
      // malformed pattern is always an error when matching.
      it(`${label} is rejected (${count})`, () => {
        for (const combo of combos) {
          expect(() => compile(pattern, optionsFor(combo)).test("x")).toThrow(ZshPatternError);
        }
      });
      continue;
    }
    it(`${label} (${count})`, () => {
      for (const combo of combos) {
        const options = optionsFor(combo);
        const prefix = prefixFor(pattern);
        const compiled = compile(prefix + pattern, options);
        const actual = subjects.map((s) => (compiled.test(prefix + s) ? "1" : "0")).join("");
        if (actual !== expected) {
          const differing = subjects
            .filter((_, i) => actual[i] !== expected[i])
            .map((s) => JSON.stringify(s));
          expect.fail(
            `${pattern} under ${describeCombo(combo)}\n` +
              `  differs on ${differing.join(", ")}\n` +
              `  zsh:  ${expected}\n  ours: ${actual}`,
          );
        }
      }
    });
  }
});

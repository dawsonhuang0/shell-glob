import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { expandBraces } from "../src/braces.js";
import { resolveOptions, type ZshOptionsInput } from "../src/options.js";
import { fixtureLines } from "./helpers/fixture.js";
// The corpus is imported from the generator rather than restated, so the
// fixture and the test can never come to disagree about what was swept.
// @ts-expect-error -- a plain .mjs script, with no declarations of its own
import { corpus } from "../scripts/harvest-braces.mjs";

/**
 * Brace expansion against the shell that defines it.
 *
 * Every word in the sweep was expanded by a real zsh; the fixture records the
 * ones that changed.  A word missing from it is one zsh left alone, and the
 * test asserts that too -- so expanding something zsh would not is caught just
 * as surely as failing to expand something it would.
 */
const lines = fixtureLines(fileURLToPath(new URL("./fixtures/braces.txt", import.meta.url)));

const zshVersion = lines[0].split("\t")[1];
const sets = new Map<string, { total: number; changed: Map<string, string[]> }>();
let current: { total: number; changed: Map<string, string[]> } | null = null;
for (const line of lines.slice(1)) {
  if (line.startsWith("#set\t")) {
    const [, name, total] = line.split("\t");
    current = { total: Number(total), changed: new Map() };
    sets.set(name, current);
  } else if (line !== "" && current) {
    const [word, results] = JSON.parse(line) as [string, string[]];
    current.changed.set(word, results);
  }
}

const OPTIONS: Record<string, ZshOptionsInput> = {
  default: {},
  braceccl: { braceCcl: true },
  ignorebraces: { ignoreBraces: true },
};

const words: string[] = corpus();

describe(`brace expansion against zsh ${zshVersion}`, () => {
  it("has a corpus, and the fixture was built from this one", () => {
    expect(words.length).toBeGreaterThan(19_000);
    for (const [name, set] of sets) {
      expect(set.total, name).toBe(words.length);
    }
    expect([...sets.keys()].sort()).toEqual(["braceccl", "default", "ignorebraces"]);
    // IGNORE_BRACES leaves every word alone, which is the option working.
    expect(sets.get("ignorebraces")!.changed.size).toBe(0);
  });

  for (const [name, set] of sets) {
    const opts = resolveOptions(OPTIONS[name]);
    it(`expands every word as zsh does under ${name}`, () => {
      const wrong: string[] = [];
      for (const word of words) {
        const expected = set.changed.get(word) ?? [word];
        const actual = expandBraces(word, opts);
        if (actual.length !== expected.length || actual.some((a, i) => a !== expected[i])) {
          wrong.push(
            `${JSON.stringify(word)}: ${JSON.stringify(actual)} != ${JSON.stringify(expected)}`,
          );
        }
      }
      expect(wrong.slice(0, 20).join("\n"), `${wrong.length} of ${words.length}`).toBe("");
    });
  }
});

describe("brace expansion, case by case", () => {
  const g = (word: string, opts: ZshOptionsInput = {}) =>
    expandBraces(word, resolveOptions(opts));

  it("expands a comma list", () => {
    expect(g("a{b,c}d")).toEqual(["abd", "acd"]);
    expect(g("{a,b}{c,d}")).toEqual(["ac", "ad", "bc", "bd"]);
    expect(g("{a,}")).toEqual(["a", ""]);
    expect(g("{,}")).toEqual(["", ""]);
  });

  it("leaves a group that is not an expansion alone", () => {
    expect(g("{a}")).toEqual(["{a}"]);
    expect(g("{}")).toEqual(["{}"]);
    expect(g("{a,b")).toEqual(["{a,b"]);
    expect(g("a}b")).toEqual(["a}b"]);
    expect(g("{a..e..2}")).toEqual(["{a..e..2}"]);
  });

  // zsh turns the outer braces into text and expands what is inside them,
  // rather than treating the pair as a group with one element.
  it("expands the inner group when the outer one is not an expansion", () => {
    expect(g("{a{b,c}}")).toEqual(["{ab}", "{ac}"]);
    expect(g("{{a,b}}")).toEqual(["{a}", "{b}"]);
    expect(g("{a,b{c,d}}")).toEqual(["a", "bc", "bd"]);
    expect(g("{a,{b,c}}")).toEqual(["a", "b", "c"]);
  });

  it("counts a numeric range, in the direction it was written", () => {
    expect(g("{1..3}")).toEqual(["1", "2", "3"]);
    expect(g("{3..1}")).toEqual(["3", "2", "1"]);
    expect(g("{-3..3}")).toEqual(["-3", "-2", "-1", "0", "1", "2", "3"]);
    expect(g("{1..10..3}")).toEqual(["1", "4", "7", "10"]);
    expect(g("{2..-2..2}")).toEqual(["2", "0", "-2"]);
  });

  it("pads from whichever end was written with a leading zero", () => {
    expect(g("{01..4}")).toEqual(["01", "02", "03", "04"]);
    expect(g("{1..010}")).toEqual(
      ["001", "002", "003", "004", "005", "006", "007", "008", "009", "010"],
    );
  });

  // The range is only a shape at this point; the real parse happens later and
  // when it fails the word still comes back without its braces.
  it("drops the braces from a range it cannot parse", () => {
    expect(g("{1..10..0}")).toEqual(["1..10..0"]);
  });

  it("counts a character range", () => {
    expect(g("{a..e}")).toEqual(["a", "b", "c", "d", "e"]);
    expect(g("{e..a}")).toEqual(["e", "d", "c", "b", "a"]);
    expect(g("{a..a}")).toEqual(["a"]);
  });

  it("expands a character class only with BRACE_CCL", () => {
    expect(g("{a-e}")).toEqual(["{a-e}"]);
    expect(g("{a-e}", { braceCcl: true })).toEqual(["a", "b", "c", "d", "e"]);
    expect(g("{a-cx-z}", { braceCcl: true })).toEqual(["a", "b", "c", "x", "y", "z"]);
    // A comma still makes it a list, even with the option on.
    expect(g("{a,b}", { braceCcl: true })).toEqual(["a", "b"]);
  });

  it("does nothing at all under IGNORE_BRACES", () => {
    expect(g("a{b,c}d", { ignoreBraces: true })).toEqual(["a{b,c}d"]);
    expect(g("{1..3}", { ignoreBraces: true })).toEqual(["{1..3}"]);
  });

  // zsh has a lexer to tell it which braces were quoted; here the backslash
  // does that job, and it stays in the word for the globber to resolve.
  it("takes an escaped brace literally, and keeps the backslash", () => {
    expect(g("\\{a,b\\}")).toEqual(["\\{a,b\\}"]);
    expect(g("{a\\,b,c}")).toEqual(["a\\,b", "c"]);
    expect(g("\\{{a,b}")).toEqual(["\\{a", "\\{b"]);
    expect(g("{a,b}\\{c,d}")).toEqual(["a\\{c,d}", "b\\{c,d}"]);
  });
});

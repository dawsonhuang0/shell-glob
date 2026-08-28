import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { match } from "../src/index.js";
import { fixtureLines } from "./helpers/fixture.js";

/**
 * `(#a...)` was the one corner no corpus reached: `harvested.txt` holds not a
 * single approximate case, and zsh's own tests use the flag nineteen times on
 * a handful of shapes.  `scripts/harvest-approx.mjs` generates 16,640 -- 65
 * pattern shapes against 64 subjects at every error budget from none to three
 * -- and the zsh built from `./zsh` answers them.
 *
 * It found 123 disagreements, then 557 once the corpus was widened.  All of
 * them are gone.  Getting there meant following `patmatch` rather than writing
 * a matcher that computes the same thing a tidier way, because approximate
 * matching in zsh is not a function of the pattern and the subject alone:
 *
 *   - A literal run is not a choice point.  zsh walks a `P_EXACTLY` exactly;
 *     if it matches in full, `scan = next` and it never comes back, so a later
 *     failure is repaired where it happens rather than by mis-spelling
 *     something that already matched.  `(#a1)ab?` does not match `ab`.
 *   - Every node that is not a literal run gets exactly one repair -- omit a
 *     character from the subject, in a loop -- and that includes `(#s)` and
 *     `(#e)`, which is why `(#a1)abc(#e)` matches `abcd`.
 *   - A pattern holding nothing but globbing flags is compiled to a plain
 *     string and compared as one, so `(#a1)` matches the empty string and
 *     nothing else, while `(#a1)()` has a node in it and matches `a`.
 *   - `exactpos` and `exactend` say how far into a run the repairs have got,
 *     and both outlive the attempt that set them.  `exactpos` is copied into a
 *     local and put back between attempts; `exactend` is not, so an attempt
 *     that fails inside a *different* run leaves it there and the repairs that
 *     follow measure against the wrong end.  `bc` does not match `(#a1)a?c`,
 *     though it matches `(#a1)abc`.
 *   - `errsfound` is put back only by a branch -- an alternation, a closure, a
 *     `*` -- and not when a node or a counted iteration fails.  An error spent
 *     on a failed `(#cN,M)` iteration stays spent.
 *   - `(#cN,M)` is P_COUNT, which keeps its count and the position it last
 *     tried on the pattern node; the count is put back when an iteration fails
 *     and the position is not.
 *
 * Because a node that fails leaves state behind, *reaching* a node is part of
 * the answer.  Every optimisation in the matcher that skips a node it can
 * prove would fail -- the width bounds, the deterministic run, the closure
 * fast path -- is therefore switched off wherever approximation is in force.
 * The one exception is the `*` lookahead, which is switched off and on by the
 * budget in force at that star exactly as zsh's is: off under `(#a...)`, on
 * inside an exclusion, where approximation has to be asked for again.
 *
 * The price is that approximate matching is slower here than in zsh rather
 * than faster, which is the right way round for a port.
 */
const CORPUS = fileURLToPath(new URL("./fixtures/approx.txt", import.meta.url));
const DIVERGENCES = fileURLToPath(new URL("./fixtures/approx-divergences.txt", import.meta.url));

const lines = (path: string) =>
  fixtureLines(path)
    .filter((line) => line.length > 0 && !line.startsWith("#"));

/** "t", "f", or "E" where zsh rejects the pattern outright. */
const cases = lines(CORPUS).map((line) => {
  const [res, pattern, subject = ""] = line.split("\t");
  return { res, pattern, subject };
});

/** What this package says, in the same three states. */
function ours(pattern: string, subject: string): string {
  try {
    return match(subject, pattern, { extendedGlob: true }) ? "t" : "f";
  } catch {
    return "E";
  }
}

const known = new Set(lines(DIVERGENCES));
const key = (pattern: string, subject: string) => `${pattern}\t${subject}`;

describe("approximate matching against zsh", () => {
  it("has a corpus and a divergence list to check against", () => {
    expect(cases.length).toBe(118656);
    expect(known.size).toBe(0);
  });

  for (const { res, pattern, subject } of cases) {
    if (known.has(key(pattern, subject))) continue;
    const what = res === "E" ? "a bad pattern" : res === "t" ? "true" : "false";
    it(`[[ ${JSON.stringify(subject)} = ${pattern} ]] is ${what}`, () => {
      expect(ours(pattern, subject)).toBe(res);
    });
  }

  it("disagrees with zsh in exactly the recorded places", () => {
    const now = new Set<string>();
    for (const { res, pattern, subject } of cases) {
      if (ours(pattern, subject) !== res) now.add(key(pattern, subject));
    }
    const appeared = [...now].filter((k) => !known.has(k));
    const fixed = [...known].filter((k) => !now.has(k));
    expect({ appeared, fixed }).toEqual({ appeared: [], fixed: [] });
  });

  it("agrees with zsh on every case in the corpus", () => {
    expect(known.size).toBe(0);
  });

  it("covers the flag group in every position, not just the front", () => {
    // The bug this corpus grew to catch lived in the non-leading positions.
    const nonLeading = cases.filter((c) => !c.pattern.startsWith("(#a"));
    expect(nonLeading.length).toBeGreaterThan(cases.length / 4);
    expect(cases.some((c) => /.\(#a\d\)$/.test(c.pattern))).toBe(true);
    expect(cases.some((c) => /.\(#a\d\)./.test(c.pattern))).toBe(true);
  });
});

/**
 * The worked examples out of `Doc/Zsh/expn.yo`'s "Approximate Matching"
 * section.  This is the nearest thing `(#aN)` has to a specification, and it
 * is worth pinning separately from the generated corpus: the corpus records
 * what one build of zsh does, while these are what zsh says it does.
 *
 * Every one of them was checked against the zsh built from `./zsh` as well.
 */
describe("the examples in Doc/Zsh/expn.yo", () => {
  const cases: [string, string, boolean, string?][] = [
    ["dcba", "(#a3)abcd", true, "two substitutions and a transposition"],
    // "Non-literal parts of the pattern must match exactly": `?` may be
    // matched by an extra character in the subject, but never dropped.
    ["abcd", "(#a1)???", true, "rule 4 against an empty part of the pattern"],
    ["ab", "(#a1)???", false, "all the ? must match"],
    // "errors are counted separately for non-contiguous strings in the pattern"
    ["aebf", "(#a2)(ab|cd)ef", true, "one error in each of two runs"],
    ["aebf", "(#a1)(ab|cd)ef", false, "which is two errors, not one"],
    // Exclusions are approximated separately, and only if asked.
    ["READ.ME", "(#a1)README~READ_ME", true, "the exclusion matches exactly"],
    ["READ_ME", "(#a1)README~READ_ME", false, "and so excludes this"],
    ["READ.ME", "(#a1)README~(#a1)READ_ME", false, "now the exclusion approximates too"],
    // "the point at which an error is first found is the crucial one"
    ["abcdxyz", "(#a1)abc(#a0)xyz", false, "the error falls where approximation is off"],
    ["catdogfox", "(#a1)cat((#a0)dog)fox", true],
    ["catdoxfox", "(#a1)cat((#a0)dog)fox", false, "the error is inside the (#a0) group"],
    ["cbtdogfox", "(#a1)cat((#a0)dog)fox", true, "and outside it, one error is allowed"],
    ["cbtdogfox", "(#a1)cat(#a0)dog(#a1)fox", true, "the documented equivalent spelling"],
  ];

  for (const [subject, pattern, expected, why] of cases) {
    it(`[[ ${subject} = ${pattern} ]] is ${expected}${why ? ` -- ${why}` : ""}`, () => {
      expect(match(subject, pattern, { extendedGlob: true })).toBe(expected);
    });
  }

  it("counts a slash as an ordinary character outside filename generation", () => {
    // The manual's "a/bc is two errors from ab/c" is about globbing, where a
    // slash may not be transposed.  In `[[ ... ]]` it is an ordinary
    // character, so the transposition costs one error -- as zsh agrees.
    expect(match("ab/c", "(#a1)a/bc", { extendedGlob: true })).toBe(true);
  });
});

import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { match } from "../src/index.js";
import { fixtureLines } from "./helpers/fixture.js";

const EXT = { extendedGlob: true } as const;

/** Reads one of zsh's own `res str pat` corpus files. */
function corpus(file: string) {
  return fixtureLines(fileURLToPath(new URL(`./fixtures/${file}`, import.meta.url)))
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"))
    .map((line) => {
      const [res, str, pat] = line.split(/\s+/);
      return { expected: res === "t", str, pat };
    });
}

/**
 * Misc/globtests from the zsh source tree, which its own D02glob.ztst runs
 * under `setopt extendedglob badpattern; unsetopt kshglob`.
 */
describe("zsh Misc/globtests corpus", () => {
  for (const { expected, str, pat } of corpus("globtests.txt")) {
    it(`[[ ${str} = ${pat} ]] is ${expected}`, () => {
      expect(match(str, pat, EXT)).toBe(expected);
    });
  }
});

/** Misc/globtests.ksh, the same idea under `setopt kshglob extendedglob`. */
describe("zsh Misc/globtests.ksh corpus", () => {
  for (const { expected, str, pat } of corpus("globtests-ksh.txt")) {
    it(`[[ ${str} = ${pat} ]] is ${expected}`, () => {
      expect(match(str, pat, { ...EXT, kshGlob: true })).toBe(expected);
    });
  }
});

/**
 * zsh's P_WBRANCH marks each subject position a closure has been entered at
 * and refuses to enter it there twice, "to remove exponential behaviour in
 * backtracking nested closures" (Src/pattern.c).  Both patterns below come
 * from zsh's own Misc/globtests corpus, which uses them at 26 characters --
 * enough to take a matcher without the mark about a fifth of a second, and
 * about half a second for the ksh form.
 *
 * These run them far past that.  Without the mark the work doubles with every
 * few characters, so a 400 character subject would not finish at all; with it
 * the cost is flat enough that the timeout below is never close.
 */
describe("nested closures do not backtrack exponentially", () => {
  const subject = "fffooofoooooffoofffooofffx".repeat(16).slice(0, 400);

  it("(f#o#)# over 400 characters", () => {
    expect(match(subject, "(f#o#)#", EXT)).toBe(false);
  }, 1000);

  it("*(*(f)*(o)) over 400 characters", () => {
    expect(match(subject, "*(*(f)*(o))", { ...EXT, kshGlob: true })).toBe(false);
  }, 1000);

  it("still answers the 26 character cases zsh's corpus uses", () => {
    const short = "fffooofoooooffoofffooofffx";
    expect(match(short, "(f#o#)#", EXT)).toBe(false);
    expect(match(short.slice(0, -1), "(f#o#)#", EXT)).toBe(true);
  });
});

import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { match } from "../src/index.js";
import { fixtureLines } from "./helpers/fixture.js";

/**
 * Cases captured from the real zsh by scripts/gen-zsh-cases.zsh.  Each line is
 * "status<TAB>options<TAB>string<TAB>pattern", where status is what
 * `[[ $string = ${~pattern} ]]` returned.
 */
const cases = fixtureLines(
  fileURLToPath(new URL("./fixtures/zsh-cases.txt", import.meta.url)),
)
  .filter((line) => line.length > 0)
  .map((line) => {
    const [status, opts, str, pat] = line.split("\t");
    return {
      expected: status === "0",
      options: {
        extendedGlob: !opts.includes("E") && !opts.includes("K"),
        kshGlob: opts.includes("k") || opts.includes("K"),
      },
      str,
      pat,
    };
  });

describe("cases captured from zsh", () => {
  for (const { expected, options, str, pat } of cases) {
    it(`[[ ${str} = ${pat} ]] is ${expected}`, () => {
      expect(match(str, pat, options)).toBe(expected);
    });
  }
});

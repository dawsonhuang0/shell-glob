import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

const EXT = { extendedGlob: true } as const;

/** Expected values were read out of `$match`, `$mbegin` and `$mend` in zsh 5.9. */
const cases: [string, string, { groups: string[]; mbegin: number[]; mend: number[] } | null][] = [
  [
    "a_string_with_a_message",
    "(a|an)_(#b)(*)",
    { groups: ["string_with_a_message"], mbegin: [3], mend: [23] },
  ],
  ["abab", "(#b)([ab])#", { groups: ["b"], mbegin: [4], mend: [4] }],
  ["foo.c", "(#b)(*).c", { groups: ["foo"], mbegin: [1], mend: [3] }],
  [
    "XababcdcdY",
    "(#b)X((ab|cd)#)Y",
    { groups: ["ababcdcd", "cd"], mbegin: [2, 8], mend: [9, 9] },
  ],
  ["XababcdcdY", "(#b)X(ab|cd)#Y", { groups: ["cd"], mbegin: [8], mend: [9] }],
  ["abc", "(#b)(a)(b)(c)", { groups: ["a", "b", "c"], mbegin: [1, 2, 3], mend: [1, 2, 3] }],
  ["abc", "(#b)(x)#(a)*", { groups: ["", "a"], mbegin: [-1, 1], mend: [-1, 1] }],
  ["hello", "(#b)(h)(#B)(e)llo", { groups: ["h"], mbegin: [1], mend: [1] }],
];

describe("backreferences", () => {
  for (const [str, pat, expected] of cases) {
    it(`${pat} against ${str}`, () => {
      const result = compile(pat, EXT).exec(str);
      if (expected === null) {
        expect(result).toBeNull();
        return;
      }
      expect(result).not.toBeNull();
      expect(result!.groups).toEqual(expected.groups);
      expect(result!.mbegin).toEqual(expected.mbegin);
      expect(result!.mend).toEqual(expected.mend);
    });
  }

  it("only the first nine groups are recorded, as in zsh", () => {
    const pattern = "(#b)" + "(a)".repeat(12);
    expect(compile(pattern, EXT).exec("a".repeat(12))!.groups).toHaveLength(9);
  });
});

import { describe, expect, it } from "vitest";
import { evaluateArith, globSync, ZshPatternError } from "../src/index.js";
import { virtualFs as virtual } from "./helpers/virtual-fs.js";

/**
 * A glob qualifier subscript is a full arithmetic expression, not a number:
 * `*(om[2*2])` is the fourth match and `*(om[^~])` is an error.  Every
 * expectation below was taken from the zsh built from `./zsh`, either through
 * `$(( ))` or through the subscript itself.
 *
 * The precedence is zsh's own (`z_prec` in Src/math.c), not C's -- `CPRECEDENCES`
 * selects C's and is off by default -- so the shifts and the bitwise operators
 * bind tighter than multiplication, and `**` sits between them.
 */
describe("arithmetic", () => {
  const cases: [string, number][] = [
    ["1", 1], ["-1", -1], ["+2", 2], ["1+1", 2], ["3-1", 2], ["2*2", 4],
    ["8/4", 2], ["9%7", 2], ["4/2/2", 1], ["8%3", 2],
    // Integer operands divide as integers; a float operand does not.
    ["-7/2", -3], ["7/-2", -3], ["3.9/2", 1], ["1.5", 1], ["2.9", 2], ["-0.5", 0],
    ["1e0", 1],
    // zsh's precedence, which is not C's.
    ["1|2*3", 9], ["1<<2+3", 7], ["-2**2", 4], ["2**3*2", 16], ["1&3|2", 3],
    ["1^1|1", 1], ["8>>1+1", 5], ["1+2<<1", 5], ["2*3&4", 0],
    ["2**3**2", 512], ["2**1", 2], ["2**10", 1024],
    // 64 bit, as `zlong` is.
    ["1<<31", 2147483648],
    ["~0", -1], ["~-3", 2], ["!0", 1], ["!!1", 1], ["~~1", 1],
    ["1&&2", 1], ["1&&0", 0], ["0&&1", 0], ["0||2", 1], ["1||0", 1], ["0||0", 0],
    // `^^` is a logical exclusive or, which C has no operator for.
    ["1^^1", 0], ["0^^1", 1], ["1||0^^1", 0],
    ["1==1", 1], ["2!=2", 0], ["2>1", 1], ["1<2", 1],
    ["1?2:3", 2], ["1?0:2", 0], ["0?1:2", 2],
    ["(1,2)", 2], ["1,2,3", 3], ["((1))", 1], ["-(1)", -1], ["2*(1+1)", 4],
    // A leading zero is not octal: that is OCTAL_ZEROES, which is off.
    ["010", 10], ["07", 7],
    ["0x2", 2], ["0xff", 255], ["0b10", 2],
    ["2#10", 2], ["16#2", 2], ["36#z", 35], ["8#17", 15], ["2#101", 5],
    // zstrtol stops where it cannot go on rather than complaining.
    ["0x", 0], ["2#", 0], ["#2", 0], ["0#1", 1],
    ["1_0", 10], ["1_000", 1000],
    // Every parameter is unset here, and an unset one is zero.
    ["foo", 0], ["a=2", 2],
    ["1 , 2", 2], ["- 1", -1], ["0", 0],
  ];

  for (const [expr, expected] of cases) {
    it(`${expr} is ${expected}`, () => {
      expect(evaluateArith(expr, expr)).toBe(expected);
    });
  }

  for (const expr of ["", "^~", "**2", "1?2", "1,,2", "1..2", "1#1", "1+", "+", "1 2"]) {
    it(`${JSON.stringify(expr)} is a bad math expression`, () => {
      expect(() => evaluateArith(expr, expr)).toThrow(ZshPatternError);
    });
  }

  for (const expr of ["5/0", "9%0"]) {
    it(`${expr} is a division by zero`, () => {
      expect(() => evaluateArith(expr, expr)).toThrow(/division by zero/);
    });
  }
});

/**
 * The subscript splits at its top level comma only, the one `getarg` stops at
 * (Src/params.c): brackets and parentheses are counted, so `[(1,2)]` is one
 * expression using the comma operator rather than a range.
 */
describe("qualifier subscripts", () => {
  const tree = {
    "/t": {
      fa: { mtimeMs: 5000 },
      fb: { mtimeMs: 4000 },
      fc: { mtimeMs: 3000 },
      fd: { mtimeMs: 2000 },
      fe: { mtimeMs: 1000 },
    },
  };

  const run = (pattern: string, extendedGlob = true) =>
    globSync(pattern, {
      cwd: "/t",
      bareGlobQual: true,
      extendedGlob,
      nullGlob: true,
      fs: virtual(tree),
    });

  const cases: [string, string[]][] = [
    // `om` is newest first, and `fa` is the newest here.
    ["f*(om[1])", ["fa"]],
    ["f*(om[2])", ["fb"]],
    ["f*(om[1,3])", ["fa", "fb", "fc"]],
    ["f*(om[2*2])", ["fd"]],
    ["f*(om[0x2])", ["fb"]],
    ["f*(om[0])", []],
    ["f*(om[foo])", []],
    // The comma operator inside parentheses, which does not split the range.
    ["f*(#qom[(1,2)])", ["fb"]],
  ];

  for (const [pattern, expected] of cases) {
    it(`${pattern} selects ${expected.join(", ") || "nothing"}`, () => {
      expect(run(pattern)).toEqual(expected);
    });
  }

  for (const pattern of ["f*(om[])", "f*(om[2,])"]) {
    it(`${pattern} is an error`, () => {
      expect(() => run(pattern)).toThrow(ZshPatternError);
    });
  }

  // With EXTENDED_GLOB a `~` stops the group being read as a qualifier list at
  // all, so it is an ordinary pattern that matches nothing; without it the
  // group is qualifiers and `^~` is an arithmetic error.  zsh does both.
  it("f*(om[^~]) is a pattern under EXTENDED_GLOB and an error without it", () => {
    expect(run("f*(om[^~])")).toEqual([]);
    expect(() => run("f*(om[^~])", false)).toThrow(ZshPatternError);
  });
});

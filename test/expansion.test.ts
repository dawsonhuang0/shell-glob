import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

const EXT = { extendedGlob: true } as const;

/**
 * The prefix, suffix and substitution forms of parameter expansion, checked
 * against what zsh 5.9 produces for the same inputs.
 */
describe("parameter expansion helpers", () => {
  const s = "abcabc";

  it("strips the shortest prefix, as ${s#*b}", () => {
    expect(s.slice(compile("*b", EXT).matchStart(s)!)).toBe("cabc");
  });

  it("strips the longest prefix, as ${s##*b}", () => {
    expect(s.slice(compile("*b", EXT).matchStart(s, { longest: true })!)).toBe("c");
  });

  it("strips the shortest suffix, as ${s%b*}", () => {
    expect(s.slice(0, compile("b*", EXT).matchEnd(s)!)).toBe("abca");
  });

  it("strips the longest suffix, as ${s%%b*}", () => {
    expect(s.slice(0, compile("b*", EXT).matchEnd(s, { longest: true })!)).toBe("a");
  });

  it("replaces the first match, as ${s/b/X}", () => {
    expect(compile("b", EXT).replace(s, "X")).toBe("aXcabc");
  });

  it("replaces every match, as ${s//b/X}", () => {
    expect(compile("b", EXT).replace(s, "X", { global: true })).toBe("aXcaXc");
  });

  it("uses the leftmost longest match, as ${s/a*b/Y}", () => {
    expect(compile("a*b", EXT).replace(s, "Y")).toBe("Yc");
  });

  it("does not replace an empty match next to the previous one", () => {
    expect(compile("a#", EXT).replace("aaa", "X", { global: true })).toBe("X");
  });

  it("replaces an empty match at every position", () => {
    expect(compile("x#", EXT).replace("ab", "-", { global: true })).toBe("-a-b-");
    expect(compile("", EXT).replace("ab", "-", { global: true })).toBe("-a-b-");
  });

  it("counts closures that may match nothing at all", () => {
    expect(compile("(a|)(#c2,3)b", EXT).test("b")).toBe(true);
    expect(compile("(a|)(#c2,3)b", EXT).test("aab")).toBe(true);
    expect(compile("(a|)(#c2)", EXT).test("")).toBe(true);
  });

  it("leaves the string alone when nothing matches", () => {
    expect(compile("x", EXT).replace(s, "-", { global: true })).toBe(s);
  });

  it("passes the match to a replacement function", () => {
    expect(
      compile("[aeiou]", EXT).replace("veldt jynx", (m) => m.match.toUpperCase(), {
        global: true,
      }),
    ).toBe("vEldt jynx");
  });

  it("finds the leftmost longest match with search(), as ${s/b*c/X} does", () => {
    const found = compile("(#b)(b*)c", EXT).search("xxabcabc");
    expect(found?.match).toBe("bcabc");
    expect(found?.index).toBe(3);
    expect(found?.groups).toEqual(["bcab"]);
  });

  it("strips a prefix with a trailing wildcard, as ${s#a*} and ${s##a*}", () => {
    expect(s.slice(compile("a*", EXT).matchStart(s)!)).toBe("bcabc");
    expect(s.slice(compile("a*", EXT).matchStart(s, { longest: true })!)).toBe("");
  });
});

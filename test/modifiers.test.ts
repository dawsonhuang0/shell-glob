import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { globSync, ZshPatternError } from "../src/index.js";
import { splitModifiers } from "../src/modifiers.js";
import { virtualFs } from "./helpers/virtual-fs.js";
import { asPattern } from "./helpers/platform.js";

/**
 * The colon modifiers, checked against what zsh 5.9 produces for the same
 * inputs (`${${:-path}:r}` and friends).
 */
const fs = virtualFs({
  "/v": {
    "a.tar.gz": {},
    noext: {},
    ".hidden": {},
    aXaXa: {},
    "a b": {},
    "a\\ b": {},
    sub: { type: "dir" },
  },
  "/v/sub": { ".hidden": {}, "f.txt": {}, deep: { type: "dir" } },
  "/v/sub/deep": { "f.txt": {} },
});

const m = (word: string) =>
  globSync(word, { cwd: "/v", extendedGlob: true, globDots: true, nullGlob: true, fs })[0];

describe("colon modifiers", () => {
  it("takes the head and the tail", () => {
    expect(m("sub/deep/f.txt(:h)")).toBe("sub/deep");
    expect(m("sub/deep/f.txt(:t)")).toBe("f.txt");
    expect(m("noext(:h)")).toBe(".");
    expect(m("/v/sub(:h)")).toBe("/v");
  });

  it("splits off the extension, counting a leading dot", () => {
    expect(m("a.tar.gz(:r)")).toBe("a.tar");
    expect(m("a.tar.gz(:e)")).toBe("gz");
    expect(m("noext(:r)")).toBe("noext");
    expect(m("noext(:e)")).toBe("");
    expect(m(".hidden(:r)")).toBe("");
    expect(m(".hidden(:e)")).toBe("hidden");
    expect(m("sub/.hidden(:r)")).toBe("sub/");
    expect(m("sub/.hidden(:e)")).toBe("hidden");
  });

  it("changes case", () => {
    expect(m("a.tar.gz(:u)")).toBe("A.TAR.GZ");
    expect(m("a.tar.gz(:u:l)")).toBe("a.tar.gz");
  });

  it("substitutes once, or globally with g", () => {
    expect(m("sub/deep/f.txt(:s/e/E/)")).toBe("sub/dEep/f.txt");
    expect(m("sub/deep/f.txt(:gs/e/E/)")).toBe("sub/dEEp/f.txt");
    // Any character may delimit the substitution.
    expect(m("sub/deep/f.txt(:s#deep#shallow#)")).toBe("sub/shallow/f.txt");
    expect(m("sub/deep/f.txt(:s,deep,shallow,)")).toBe("sub/shallow/f.txt");
    expect(m("sub/deep/f.txt(:s/nothing/x/)")).toBe("sub/deep/f.txt");
  });

  it("takes an escaped delimiter inside a substitution", () => {
    expect(m("a.tar.gz(:s/\\//-/)")).toBe("a.tar.gz"); // no slash in the name
    expect(m("sub/deep/f.txt(:s/\\//-/)")).toBe("sub-deep/f.txt");
  });

  it("resolves .. relative to nothing, as zsh's :a does", () => {
    expect(globSync("f.txt(:a)", { cwd: "/", fs: virtualFs({ "/": { "f.txt": {} } }) })[0]).toBe(
      "/f.txt",
    );
  });

  it("makes a path absolute with a, resolving . and .. on the way", () => {
    expect(m("sub/deep/f.txt(:a)")).toBe("/v/sub/deep/f.txt");
    const real = asPattern(mkdtempSync(join(tmpdir(), "zsh-mod-")));
    mkdirSync(join(real, "sub/deep"), { recursive: true });
    writeFileSync(join(real, "sub/deep/f.txt"), "");
    expect(globSync("sub/../sub/deep/f.txt(:a)", { cwd: real, nullGlob: true })[0]).toBe(
      `${real}/sub/deep/f.txt`,
    );
    expect(globSync("./sub/deep/*(:a)", { cwd: real, nullGlob: true })[0]).toBe(
      `${real}/sub/deep/f.txt`,
    );
    rmSync(real, { recursive: true, force: true });
  });

  it("chains in the order given", () => {
    expect(m("sub/deep/f.txt(:h:t)")).toBe("deep");
    expect(m("sub/deep/f.txt(:t:r)")).toBe("f");
  });

  it("rejects a modifier that is not one, rather than ignoring it", () => {
    expect(() => m("noext(:Z)")).toThrow(ZshPatternError);
    expect(() => m("noext(:Z)")).toThrow(/unsupported modifier/);
    expect(() => m("noext(:s)")).toThrow(/missing delimiter/);
  });

  // A modifier may hold colons of its own, so the list is scanned rather than
  // split.  Each of these was checked against the shell.
  it("scans the list instead of splitting it on every colon", () => {
    expect(splitModifiers(":s:a:Y:")).toEqual(["s:a:Y:"]);
    expect(splitModifiers(":F:2:s/a/Y/")).toEqual(["F:2:s/a/Y/"]);
    expect(splitModifiers(":W:X:s/a/Y/")).toEqual(["W:X:s/a/Y/"]);
    expect(splitModifiers(":h:t")).toEqual(["h", "t"]);
    expect(splitModifiers(":t3:r")).toEqual(["t3", "r"]);
    // zsh stops as soon as the next character is not a colon, so the `t` is
    // dropped rather than applied.
    expect(splitModifiers(":s:a:Y:t")).toEqual(["s:a:Y:"]);
  });

  it("applies the prefixes that change how a modifier runs", () => {
    expect(m("aXaXa(:gs/a/Y/)")).toBe("YXYXY");
    expect(m("aXaXa(:fs/a/Y/)")).toBe("YXYXY");
    expect(m("aXaXa(:F:2:s/a/Y/)")).toBe("YXYXa");
    expect(m("aXaXa(:ws/a/Y/)")).toBe("YXaXa");
    // A prefix with nothing after it is left alone, not an error.
    expect(m("aXaXa(:g)")).toBe("aXaXa");
  });

  it("repeats the last substitution for :&", () => {
    expect(m("aXaXa(:s/a/Y/:&)")).toBe("YXYXa");
    // With no substitution before it there is nothing to repeat.
    expect(m("aXaXa(:&)")).toBe("aXaXa");
  });

  it("quotes and unquotes", () => {
    expect(m("a b(:q)")).toBe("a\\ b");
    expect(m("a\\ b(:Q)")).toBe("a b");
  });
});

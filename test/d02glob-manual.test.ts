import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { compile, globSync, match, ZshPatternError } from "../src/index.js";

/**
 * Blocks from zsh's Test/D02glob.ztst that the extractor cannot translate,
 * because they are written with shell functions, anonymous functions or
 * parameter expansion.  They are ported here by hand, keeping zsh's expected
 * results; the line numbers refer to D02glob.ztst in zsh 5.9.
 */

let tree: string;
const EXT = { extendedGlob: true } as const;
const g = (word: string, options = {}) => globSync(word, { cwd: tree, ...EXT, ...options });

beforeAll(() => {
  tree = mkdtempSync(join(tmpdir(), "zsh-d02m-"));
  for (const dir of ["glob.tmp", "glob.tmp/dir1", "glob.tmp/dir2", "glob.tmp/dir3",
                     "glob.tmp/dir4", "glob.tmp/dir3/subdir"]) {
    mkdirSync(join(tree, dir));
  }
  for (const dir of ["glob.tmp", "glob.tmp/dir1", "glob.tmp/dir2"]) {
    for (const name of ["a", "b", "c"]) writeFileSync(join(tree, dir, name), "");
  }
});

afterAll(() => rmSync(tree, { recursive: true, force: true }));

/** "exclusions regression test", lines 17-21 and 296-299. */
describe("exclusions over a whole tree", () => {
  it("excludes by absolute path with **/*~/*", () => {
    // print $absolute_dir/**/*~/* — every match is excluded by `/*`, since
    // `/` is not special in an exclusion, so the result is empty.
    expect(globSync(`${tree}/glob.tmp/**/*~/*`, { ...EXT, nullGlob: true })).toEqual([]);
  });

  it("expands glob.tmp/**/*~(.)# to the whole tree", () => {
    expect(g("glob.tmp/**/*~(.)#")).toEqual([
      "glob.tmp/a", "glob.tmp/b", "glob.tmp/c",
      "glob.tmp/dir1", "glob.tmp/dir1/a", "glob.tmp/dir1/b", "glob.tmp/dir1/c",
      "glob.tmp/dir2", "glob.tmp/dir2/a", "glob.tmp/dir2/b", "glob.tmp/dir2/c",
      "glob.tmp/dir3", "glob.tmp/dir3/subdir", "glob.tmp/dir4",
    ]);
  });
});

/** "Named character sets handled internally", lines 402-425. */
describe("named character sets handled internally", () => {
  const doesmatch = (str: string, pat: string, settings = {}) =>
    compile(pat, EXT, settings).test(str);

  it("[[:IDENT:]] covers shell identifier characters", () => {
    expect(doesmatch("MY_IDENTIFIER", "[[:IDENT:]]##")).toBe(true);
    expect(doesmatch("YOUR:IDENTIFIER", "[[:IDENT:]]##")).toBe(false);
  });

  it("[[:IFS:]] follows the value of IFS", () => {
    expect(doesmatch("\n", "[[:IFS:]]", { ifs: "\n" })).toBe(true);
    expect(doesmatch("\n", "[[:IFS:]]", { ifs: " " })).toBe(false);
  });

  it("[[:IFSSPACE:]] is whitespace in IFS only", () => {
    expect(doesmatch(":", "[[:IFSSPACE:]]", { ifs: ":" })).toBe(false);
    expect(doesmatch(" ", "[[:IFSSPACE:]]", { ifs: " " })).toBe(true);
  });

  it("[[:WORD:]] follows the value of WORDCHARS", () => {
    expect(doesmatch("/", "[[:WORD:]]", { wordChars: "" })).toBe(false);
    expect(doesmatch("/", "[[:WORD:]]", { wordChars: "/" })).toBe(true);
  });
});

/** "Misplaced (#c...) flag", lines 427-429: zsh reports a bad pattern. */
describe("misplaced (#c...) flag", () => {
  it("is a bad pattern", () => {
    expect(() => match("foo", "(#c0)foo", EXT)).toThrow(ZshPatternError);
  });

  it("is left as a plain word when globbing with BAD_PATTERN unset", () => {
    // The option is only consulted in filename generation; matching still
    // reports the error.
    expect(globSync("(#c0)foo", { ...EXT, badPattern: false, cwd: tree })).toEqual([
      "(#c0)foo",
    ]);
    expect(() => match("(#c0)foo", "(#c0)foo", { ...EXT, badPattern: false })).toThrow(
      ZshPatternError,
    );
  });
});

/** "single byte match with top bit set", lines 292-294. */
describe("characters with the top bit set", () => {
  it("matches inside a character class", () => {
    expect(match("björn", "*[åäöÅÄÖ]*", EXT)).toBe(true);
  });
});

/** "(#q) is ignored completely in conditional pattern matching", lines 583-586. */
describe("(#q...) in pattern matching", () => {
  it("is ignored, and backreferences still work", () => {
    const pattern = compile("(#b)ce\\ (f[^ ]#)\\ *s(#q./)", EXT);
    const result = pattern.exec("ce fichier n'existe pas");
    expect(result?.groups).toEqual(["fichier"]);
    expect(pattern.qualifiers).toBe("./");
  });
});

/** "non-directories not globbed as directories", lines 790-799. */
describe("a trailing slash", () => {
  beforeAll(() => writeFileSync(join(tree, "glob.tmp/not-a-directory"), ""));

  it("does not match a plain file", () => {
    expect(g("glob.tmp/not-a-dir*(N)")).toEqual(["glob.tmp/not-a-directory"]);
    expect(g("glob.tmp/not-a-dir*/(N)")).toEqual([]);
  });

  it("keeps the slash on the directories it does match", () => {
    expect(g("glob.tmp/dir*/(N)")).toEqual([
      "glob.tmp/dir1/", "glob.tmp/dir2/", "glob.tmp/dir3/", "glob.tmp/dir4/",
    ]);
    expect(g("glob.tmp/dir3/(N)")).toEqual(["glob.tmp/dir3/"]);
  });

  it("is implied by a closure, which consumes the slash itself", () => {
    expect(g("glob.tmp/dir3/(*/)#")).toEqual(["glob.tmp/dir3/", "glob.tmp/dir3/subdir/"]);
    expect(g("glob.tmp/dir3/**/")).toEqual(["glob.tmp/dir3/", "glob.tmp/dir3/subdir/"]);
  });
});

/** "modifiers :h and :t with numbers", lines 724-750. */
describe("the :h and :t modifiers with a count", () => {
  const path = "glob.tmp/my/test/dir/that/does/not/exist";

  beforeAll(() => {
    mkdirSync(join(tree, path), { recursive: true });
  });

  const modify = (modifier: string) => g(`${path}(${modifier})`)[0];

  it("keeps the leading components for :hN", () => {
    expect(modify(":h")).toBe("glob.tmp/my/test/dir/that/does/not");
    expect(modify(":h0")).toBe("glob.tmp/my/test/dir/that/does/not");
    expect(modify(":h10")).toBe("glob.tmp/my/test/dir/that/does/not/exist");
    expect(modify(":h3")).toBe("glob.tmp/my/test");
    expect(modify(":h2")).toBe("glob.tmp/my");
    expect(modify(":h1")).toBe("glob.tmp");
  });

  it("keeps the trailing components for :tN", () => {
    expect(modify(":t")).toBe("exist");
    expect(modify(":t0")).toBe("exist");
    expect(modify(":t10")).toBe("glob.tmp/my/test/dir/that/does/not/exist");
    expect(modify(":t3")).toBe("does/not/exist");
    expect(modify(":t2")).toBe("not/exist");
    expect(modify(":t1")).toBe("exist");
  });
});

/** "short-circuit modifier", lines 561-581. */
describe("the Y short circuit", () => {
  it("limits the number of matches", () => {
    expect(g("glob.tmp/dir*(Y1)")).toHaveLength(1);
    expect(g("glob.tmp/file*(NY1)")).toHaveLength(0);
    expect(g("glob.tmp/dir*(Y2)")).toHaveLength(2);
  });

  it("treats the count as an upper bound", () => {
    expect(g("glob.tmp/dir*(Y5)").sort()).toEqual([
      "glob.tmp/dir1", "glob.tmp/dir2", "glob.tmp/dir3", "glob.tmp/dir4",
    ]);
  });

  it("is switched back off by ^Y", () => {
    expect(g("glob.tmp/dir*(Y1^Y)")).toEqual([
      "glob.tmp/dir1", "glob.tmp/dir2", "glob.tmp/dir3", "glob.tmp/dir4",
    ]);
  });

  it("applies sorting after the limit", () => {
    expect(g("glob.tmp/dir*(Y4On)")).toEqual([
      "glob.tmp/dir4", "glob.tmp/dir3", "glob.tmp/dir2", "glob.tmp/dir1",
    ]);
  });

  it("globs before the last path component", () => {
    expect(g("glob.tmp/dir?/subdir(NY1)")).toHaveLength(1);
  });

  it("searches breadth first", () => {
    expect(g("glob.tmp/**/a(Y1)")).toEqual(["glob.tmp/a"]);
  });

  it("respects the other qualifiers", () => {
    expect(g("glob.tmp/dir*(NY1.)")).toHaveLength(0);
  });

  it("needs a count", () => {
    expect(() => g("glob.tmp/*(Y)")).toThrow(ZshPatternError);
  });
});

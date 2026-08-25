import { mkdirSync, mkdtempSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  glob,
  globSync,
  NoMatchError,
  ZshPatternError,
  type GlobOptions,
  type SyncFsAdapter,
} from "../src/index.js";

let tree: string;
const EXT = { extendedGlob: true } as const;

beforeAll(() => {
  tree = mkdtempSync(join(tmpdir(), "zsh-glob-"));
  for (const dir of ["src", "src/nested", "docs", "empty"]) mkdirSync(join(tree, dir));
  writeFileSync(join(tree, "readme.md"), "readme");
  writeFileSync(join(tree, ".hidden"), "x");
  writeFileSync(join(tree, "a.ts"), "a");
  writeFileSync(join(tree, "b.ts"), "bb");
  writeFileSync(join(tree, "big.bin"), "x".repeat(5000));
  writeFileSync(join(tree, "src/index.ts"), "index");
  writeFileSync(join(tree, "src/nested/deep.ts"), "deep");
  writeFileSync(join(tree, "docs/guide.md"), "guide");
  symlinkSync("src", join(tree, "link-to-src"));
  symlinkSync("nowhere", join(tree, "broken"));
  // A fixed old timestamp, for the time qualifiers.
  const old = new Date("2020-01-01T00:00:00Z");
  utimesSync(join(tree, "readme.md"), old, old);
});

afterAll(() => rmSync(tree, { recursive: true, force: true }));

const g = (pattern: string, options: GlobOptions = {}) =>
  globSync(pattern, { cwd: tree, extendedGlob: true, nullGlob: true, ...options });

describe("filename generation", () => {
  it("expands a simple pattern in sorted order", () => {
    expect(g("*.ts")).toEqual(["a.ts", "b.ts"]);
  });

  it("matches a leading dot only when asked", () => {
    expect(g("*")).not.toContain(".hidden");
    expect(g(".*")).toEqual([".hidden"]);
    expect(g("*", { globDots: true })).toContain(".hidden");
    expect(g("*(D)")).toContain(".hidden");
  });

  it("never returns . or ..", () => {
    expect(g("*", { globDots: true })).not.toContain(".");
    expect(g("*", { globDots: true })).not.toContain("..");
  });

  it("walks path segments", () => {
    expect(g("src/*.ts")).toEqual(["src/index.ts"]);
    expect(g("*/*.md")).toEqual(["docs/guide.md"]);
  });

  it("recurses with **/", () => {
    expect(g("**/*.ts")).toEqual(["a.ts", "b.ts", "src/index.ts", "src/nested/deep.ts"]);
  });

  it("recurses with the general (pat/)# form", () => {
    expect(g("(*/)#*.ts")).toEqual(g("**/*.ts"));
    // `##` requires at least one directory.
    expect(g("(*/)##*.ts")).toEqual(["src/index.ts", "src/nested/deep.ts"]);
  });

  it("does not descend through symlinks for **/ but does for ***/", () => {
    expect(g("**/nested/*.ts")).toEqual(["src/nested/deep.ts"]);
    expect(g("***/nested/*.ts")).toEqual([
      "link-to-src/nested/deep.ts",
      "src/nested/deep.ts",
    ]);
  });

  it("treats **.ts as plain *.ts unless GLOB_STAR_SHORT is set", () => {
    expect(g("**.ts")).toEqual(["a.ts", "b.ts"]);
    expect(g("**.ts", { globStarShort: true })).toEqual(g("**/*.ts"));
  });

  it("excludes with a top level ~, which sees the whole path", () => {
    // `/` is not special inside an exclusion, so `src/*` covers everything
    // below `src`, exactly as in zsh.
    expect(g("**/*.ts~src/*")).toEqual(["a.ts", "b.ts"]);
    expect(g("**/*.ts~*nested*")).toEqual(["a.ts", "b.ts", "src/index.ts"]);
  });

  it("returns absolute paths for an absolute pattern", () => {
    expect(g(`${tree}/*.ts`)).toEqual([`${tree}/a.ts`, `${tree}/b.ts`]);
    expect(g("*.ts", { absolute: true })).toEqual([`${tree}/a.ts`, `${tree}/b.ts`]);
  });

  it("leaves a pattern with nothing to match alone", () => {
    expect(g("plain.txt")).toEqual(["plain.txt"]);
  });

  it("checks that a literal final segment exists", () => {
    // A symlinked directory is followed by an ordinary pattern segment.
    expect(g("*/index.ts")).toEqual(["link-to-src/index.ts", "src/index.ts"]);
    expect(g("*/missing.ts")).toEqual([]);
  });
});

describe("no matches", () => {
  it("throws under NOMATCH, which is the default", () => {
    expect(() => globSync("*.nope", { cwd: tree, extendedGlob: true })).toThrow(NoMatchError);
  });

  it("returns nothing under NULL_GLOB", () => {
    expect(g("*.nope")).toEqual([]);
    expect(globSync("*.nope(N)", { cwd: tree, extendedGlob: true })).toEqual([]);
  });

  it("returns the pattern itself when NOMATCH is unset", () => {
    expect(globSync("*.nope", { cwd: tree, extendedGlob: true, noMatch: false })).toEqual([
      "*.nope",
    ]);
  });
});

describe("glob qualifiers", () => {
  it("selects by file type", () => {
    expect(g("*(/)")).toEqual(["docs", "empty", "src"]);
    expect(g("*(.)")).toEqual(["a.ts", "b.ts", "big.bin", "readme.md"]);
    expect(g("*(@)")).toEqual(["broken", "link-to-src"]);
    // With `-` the qualifier describes the target, so this finds broken links.
    expect(g("*(-@)")).toEqual(["broken"]);
    expect(g("*(/^F)")).toEqual(["empty"]);
  });

  it("combines qualifiers with AND and, using a comma, with OR", () => {
    expect(g("*(.L+4000)")).toEqual(["big.bin"]);
    expect(g("*(/,@)")).toEqual(["broken", "docs", "empty", "link-to-src", "src"]);
  });

  it("understands the (#q...) form", () => {
    expect(g("*(#q.)")).toEqual(g("*(.)"));
    // Several (#q...) groups may be chained; they are ANDed together.
    expect(g("*(#q.)(#qL-3)")).toEqual(["a.ts", "b.ts"]);
  });

  it("compares sizes with units", () => {
    expect(g("*(.Lk+4)")).toEqual(["big.bin"]);
    expect(g("*(.Lk-4)")).toEqual(["a.ts", "b.ts", "readme.md"]);
  });

  it("compares times against a reference point", () => {
    const now = new Date("2020-01-11T00:00:00Z").getTime();
    expect(g("*(.m+5)", { now })).toEqual(["readme.md"]);
    expect(g("*(.m-5)", { now })).toEqual(["a.ts", "b.ts", "big.bin"]);
  });

  it("sorts by the chosen key", () => {
    expect(g("*(.oL)")).toEqual(["a.ts", "b.ts", "readme.md", "big.bin"]);
    expect(g("*(.OL)")).toEqual(["big.bin", "readme.md", "b.ts", "a.ts"]);
    // `^` flips the direction too.
    expect(g("*(.^oL)")).toEqual(g("*(.OL)"));
  });

  it("takes a slice with a subscript", () => {
    expect(g("*(.OL[1,2])")).toEqual(["big.bin", "readme.md"]);
    expect(g("*(.OL[-1])")).toEqual(["a.ts"]);
  });

  it("stops early with Y", () => {
    expect(g("*(.Y2)")).toHaveLength(2);
  });

  it("marks directories and file types", () => {
    expect(g("*(/M)")).toEqual(["docs/", "empty/", "src/"]);
    expect(g("s*(T)")).toEqual(["src/"]);
  });

  it("applies colon modifiers", () => {
    expect(g("**/*.ts(:t)")).toEqual(["a.ts", "b.ts", "deep.ts", "index.ts"]);
    expect(g("*.ts(:r)")).toEqual(["a", "b"]);
    expect(g("src/*.ts(:h)")).toEqual(["src"]);
    expect(g("*.ts(:s/a/A/)")).toEqual(["A.ts", "b.ts"]);
  });

  it("prepends and appends words with P", () => {
    expect(g("*.ts(P:-f:)")).toEqual(["-f", "a.ts", "-f", "b.ts"]);
    expect(g("*.ts(P:pre:^P:post:)")).toEqual(["pre", "a.ts", "post", "pre", "b.ts", "post"]);
  });

  it("runs the e qualifier through a hook", () => {
    const seen: string[] = [];
    expect(
      g("*(.e:keep:)", {
        qualifierHooks: {
          evaluate: (code, ctx) => {
            seen.push(code);
            return ctx.name.endsWith(".ts");
          },
        },
      }),
    ).toEqual(["a.ts", "b.ts"]);
    expect(new Set(seen)).toEqual(new Set(["keep"]));
  });

  it("sorts through a hook for oe", () => {
    expect(
      g("*.ts(oe:invert:)", {
        qualifierHooks: {
          sortKey: (_code, ctx) =>
            [...ctx.name].map((c) => String.fromCharCode(0xff - c.charCodeAt(0))).join(""),
        },
      }),
    ).toEqual(["b.ts", "a.ts"]);
  });

  it("explains itself when shell code has no hook", () => {
    expect(() => g("*(e:code:)")).toThrow(/supply a 'qualifierHooks.evaluate' function/);
  });

  it("rejects an unknown qualifier", () => {
    expect(() => g("*(ü)")).toThrow(ZshPatternError);
  });
});

describe("options", () => {
  it("needs EXTENDED_GLOB for ^, ~ and #", () => {
    expect(globSync("*.ts~a*", { cwd: tree, nullGlob: true })).toEqual([]);
    expect(g("*.ts~a*")).toEqual(["b.ts"]);
  });

  it("supports ksh style groups", () => {
    expect(globSync("@(a|b).ts", { cwd: tree, kshGlob: true, nullGlob: true })).toEqual([
      "a.ts",
      "b.ts",
    ]);
    expect(globSync("!(a|b|big).*", { cwd: tree, kshGlob: true, nullGlob: true })).toEqual([
      "readme.md",
    ]);
  });

  it("matches case insensitively when CASE_GLOB is off", () => {
    expect(g("*.TS")).toEqual([]);
    expect(g("*.TS", { caseGlob: false })).toEqual(["a.ts", "b.ts"]);
  });

  it("sorts numerically with NUMERIC_GLOB_SORT", () => {
    const dir = mkdtempSync(join(tmpdir(), "zsh-glob-num-"));
    for (const name of ["f1", "f2", "f10"]) writeFileSync(join(dir, name), "");
    expect(globSync("f*", { cwd: dir })).toEqual(["f1", "f10", "f2"]);
    expect(globSync("f*", { cwd: dir, numericGlobSort: true })).toEqual(["f1", "f2", "f10"]);
    expect(globSync("f*(n)", { cwd: dir })).toEqual(["f1", "f2", "f10"]);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("the asynchronous API", () => {
  it("returns the same list as globSync", async () => {
    const [sync, async] = [g("**/*.ts"), await glob("**/*.ts", { cwd: tree, extendedGlob: true })];
    expect(async).toEqual(sync);
  });

  it("reports no matches the same way", async () => {
    await expect(glob("*.nope", { cwd: tree })).rejects.toThrow(NoMatchError);
  });
});

describe("a custom filesystem", () => {
  it("is used instead of node:fs", () => {
    const dirent = (name: string, dir: boolean) => ({
      name,
      isDirectory: () => dir,
      isSymbolicLink: () => false,
    });
    const fakeFs: SyncFsAdapter = {
      readdir: (path) =>
        path === "/virtual"
          ? [dirent("one.txt", false), dirent("two.txt", false), dirent("sub", true)]
          : path === "/virtual/sub"
            ? [dirent("three.txt", false)]
            : null,
      lstat: () => null,
      stat: () => null,
    };
    expect(globSync("**/*.txt", { cwd: "/virtual", fs: fakeFs, ...EXT })).toEqual([
      "one.txt",
      "sub/three.txt",
      "two.txt",
    ]);
  });
});

describe("a closure at the start of a filename", () => {
  // zsh compiles `X#` over a single character (`?`, `[...]`, one literal) to
  // P_ONEHASH rather than the general branching form, and that path refuses
  // the closure outright when it stands before a leading dot instead of
  // falling back on matching nothing.  So `?#.hidden` does not match
  // `.hidden`, while the grouped `(?)#.hidden` does.  Every expectation here
  // was taken from the zsh built in ./zsh.
  let dots: string;

  beforeAll(() => {
    dots = mkdtempSync(join(tmpdir(), "zsh-glob-dots-"));
    for (const name of [".hidden", "a.hidden", ".foo"]) writeFileSync(join(dots, name), "");
  });

  afterAll(() => rmSync(dots, { recursive: true, force: true }));

  const cases: [string, string[]][] = [
    ["?#.hidden", ["a.hidden"]],
    ["?##.hidden", ["a.hidden"]],
    ["[a]#.hidden", ["a.hidden"]],
    ["[a]##.hidden", ["a.hidden"]],
    ["*.hidden", ["a.hidden"]],
    ["?#.foo", []],
    // Grouped, so the closure is compiled as a branch and may match nothing.
    ["(?)#.hidden", [".hidden", "a.hidden"]],
    ["([a])#.hidden", [".hidden", "a.hidden"]],
    // A number range is not one of the simple operands, and a literal is not
    // a wildcard, so neither is held back by the dot.
    ["<->#.hidden", [".hidden"]],
    ["a#.hidden", [".hidden", "a.hidden"]],
  ];

  for (const [pattern, expected] of cases) {
    it(`${pattern} matches ${expected.join(", ") || "nothing"}`, () => {
      expect(globSync(pattern, { cwd: dots, ...EXT, nullGlob: true })).toEqual(expected);
    });
  }
});

/**
 * A backslash in a pattern quotes the character after it, which is the job
 * zsh's lexer does before `patcompile` ever sees the word -- so this package,
 * which is handed the raw word, has to do it here.
 *
 * The expectations are what `zsh -f -c 'echo sub\/*.txt'` produces, not what
 * `${~var}` produces: parameter expansion sets the pattern characters live
 * without performing quote removal, so a backslash in a variable stays in the
 * word as a character.  A library taking a pattern string is the former.
 */
describe("backslash quoting", () => {
  let quoted: string;

  beforeAll(() => {
    quoted = mkdtempSync(join(tmpdir(), "zsh-glob-quote-"));
    mkdirSync(join(quoted, "sub"));
    writeFileSync(join(quoted, "sub", "b.txt"), "");
    writeFileSync(join(quoted, "a.txt"), "");
    writeFileSync(join(quoted, "star*name"), "");
  });

  afterAll(() => rmSync(quoted, { recursive: true, force: true }));

  const cases: [string, string[]][] = [
    // A quoted `/` still separates path segments: no filename may contain one.
    ["sub\\/b.txt", ["sub/b.txt"]],
    ["sub\\/*.txt", ["sub/b.txt"]],
    ["*\\/b.txt", ["sub/b.txt"]],
    ["s*b\\/b.txt", ["sub/b.txt"]],
    // A quoted wildcard is an ordinary character.
    ["star\\*name", ["star*name"]],
    ["star*name", ["star*name"]],
    ["a\\.txt", ["a.txt"]],
  ];

  for (const [pattern, expected] of cases) {
    it(`${pattern} matches ${expected.join(", ")}`, () => {
      expect(globSync(pattern, { cwd: quoted, ...EXT, nullGlob: true })).toEqual(expected);
    });
  }
});

/**
 * A `?` is a wildcard, so during filename generation it may not match the
 * leading `.` of a name -- the same rule `*` and the bracket forms follow.
 * The fast path for fixed width patterns used to answer these without
 * consulting it, so `?dot.txt` matched `.dot.txt` and `????.txt` matched it
 * too.  Every expectation was taken from the zsh built from ./zsh.
 */
describe("a leading dot is matched only by a literal dot", () => {
  let dots: string;

  beforeAll(() => {
    dots = mkdtempSync(join(tmpdir(), "zsh-glob-lead-"));
    for (const name of [".dot.txt", "café.txt", "plain.txt"]) {
      writeFileSync(join(dots, name), "");
    }
  });

  afterAll(() => rmSync(dots, { recursive: true, force: true }));

  const cases: [string, string[]][] = [
    ["?dot.txt", []],
    ["????.txt", ["café.txt"]],
    ["*dot.txt", []],
    ["[.]dot.txt", []],
    ["[!x]dot.txt", []],
    ["?????.txt", ["plain.txt"]],
    // A literal dot spells it out, so it matches.
    [".dot.txt", [".dot.txt"]],
    ["?.dot.txt", []],
  ];

  for (const [pattern, expected] of cases) {
    it(`${pattern} matches ${expected.join(", ") || "nothing"}`, () => {
      expect(globSync(pattern, { cwd: dots, nullGlob: true })).toEqual(expected);
    });
  }

  it("GLOB_DOTS lifts the rule for ? as it does for the rest", () => {
    const opts = { cwd: dots, nullGlob: true, globDots: true };
    expect(globSync("?dot.txt", opts)).toEqual([".dot.txt"]);
    expect(globSync("????.txt", opts)).toEqual([".dot.txt", "café.txt"]);
  });
});

/**
 * `haswilds` decides whether a word is a pattern at all, and it runs "before
 * zpc_special has been set up" -- so `case Inang` has no SH_GLOB test, unlike
 * `case Inpar` which has one.  A `<1-2>` therefore makes the word a pattern
 * even under SH_GLOB, where the operator itself is inert: the pattern spells
 * only its own text, matches nothing, and reports no matches instead of being
 * handed back.
 */
describe("SH_GLOB and a numeric range", () => {
  let sh: string;

  beforeAll(() => {
    sh = mkdtempSync(join(tmpdir(), "zsh-glob-sh-"));
    writeFileSync(join(sh, "plain.txt"), "");
  });

  afterAll(() => rmSync(sh, { recursive: true, force: true }));

  it("a word whose only operator is <...> is still a pattern", () => {
    expect(() => globSync("file<1-2>.txt", { cwd: sh, shGlob: true })).toThrow(NoMatchError);
    expect(globSync("file<1-2>.txt", { cwd: sh, shGlob: true, nullGlob: true })).toEqual([]);
  });

  it("and one with no operator at all is not", () => {
    expect(globSync("plain.txt", { cwd: sh, shGlob: true })).toEqual(["plain.txt"]);
  });

  it("a star still makes a pattern, as it always did", () => {
    expect(() => globSync("nope*.txt", { cwd: sh, shGlob: true })).toThrow(NoMatchError);
  });

  it("a ksh group does not, since SH_GLOB stops the paren becoming a token", () => {
    // `zshtokenize` leaves `(` alone under SH_GLOB, so `haswilds` never sees
    // the Inpar its ksh arm tests for.
    expect(globSync("!(f)", { cwd: sh, shGlob: true, kshGlob: true })).toEqual(["!(f)"]);
  });
});

/**
 * `insert()` writes the type mark at `news[strlen(s)]` without looking at what
 * is already there, so a path that already ends in a slash gains a second one.
 * Verified against the zsh built from ./zsh.
 */
describe("MARK_DIRS appends unconditionally", () => {
  let marked: string;

  beforeAll(() => {
    marked = mkdtempSync(join(tmpdir(), "zsh-glob-mark-"));
    mkdirSync(join(marked, "sub", "deep"), { recursive: true });
    mkdirSync(join(marked, "empty"));
    writeFileSync(join(marked, "f.txt"), "");
    symlinkSync("sub", join(marked, "slink"));
  });

  afterAll(() => rmSync(marked, { recursive: true, force: true }));

  const run = (pattern: string) =>
    globSync(pattern, { cwd: marked, ...EXT, nullGlob: true, markDirs: true }).sort();

  it("doubles the slash a pattern already ended with", () => {
    expect(run("**/")).toEqual(["empty//", "sub//", "sub/deep//"]);
    expect(run("*/")).toEqual(["empty//", "slink//", "sub//"]);
  });

  it("but adds only one where the pattern ended without", () => {
    expect(run("*(/)")).toEqual(["empty/", "sub/"]);
    // The mark comes from an `lstat`, so a symlink to a directory is not one:
    // `*/` above matched `slink` because the trailing slash resolved it, and
    // the mark was then appended to a path that already ended in one.
    expect(run("*")).toEqual(["empty/", "f.txt", "slink", "sub/"]);
  });
});

import { describe, expect, it } from "vitest";
import { compile, globSync, match, NoMatchError, ZshPatternError } from "../src/index.js";
import { virtualFs } from "./helpers/virtual-fs.js";

const EXT = { extendedGlob: true } as const;

/** Every way a pattern can be malformed, and what happens then. */
describe("bad patterns", () => {
  const bad: [string, RegExp][] = [
    ["(foo", /unmatched '\('/],
    ["#foo", /nothing to repeat/],
    ["(#c2)foo", /nothing to repeat/],
    ["a###", /no more than two '#'/],
    ["(#z)a", /unknown globbing flag/],
    ["(#a)a", /'\(#a\)' needs a number/],
    ["(#a255)a", /at most 254 errors/],
    ["(#i", /unterminated globbing flags/],
    ["a(#c2", /unterminated '\(#c\.\.\.\)'/],
    ["(#se)a", /must appear on their own/],
    ["(#qfoo", /unterminated glob qualifier/],
  ];

  for (const [pattern, reason] of bad) {
    it(`rejects ${pattern}`, () => {
      let err: unknown;
      try {
        match("x", pattern, EXT);
      } catch (caught) {
        err = caught;
      }
      expect(err, `${pattern} should be refused`).toBeInstanceOf(ZshPatternError);
      // zsh says this and no more, so neither does `message`.
      expect((err as ZshPatternError).message).toBe(`bad pattern: ${pattern}`);
      // What was actually wrong is kept, out of the way, in `detail`.
      expect((err as ZshPatternError).detail).toMatch(reason);
    });
  }

  it("reports the pattern and the position", () => {
    try {
      match("x", "(foo", EXT);
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(ZshPatternError);
      expect((err as ZshPatternError).pattern).toBe("(foo");
      expect((err as ZshPatternError).position).toBeGreaterThan(0);
    }
  });

  it("still reports a bad pattern when matching, even with BAD_PATTERN unset", () => {
    // `BAD_PATTERN` is consulted only in Src/glob.c, in filename generation:
    // a malformed pattern used for matching is always an error.
    for (const [pattern] of bad) {
      expect(() => match(pattern, pattern, { ...EXT, badPattern: false })).toThrow(
        ZshPatternError,
      );
    }
  });

  it("falls back to a literal word when globbing with BAD_PATTERN unset", () => {
    for (const [pattern] of bad) {
      expect(globSync(pattern, { ...EXT, badPattern: false, cwd: "/" })).toEqual([pattern]);
    }
  });

  it("but a bad glob qualifier is an error whatever BAD_PATTERN says", () => {
    // `zglob` parses the qualifiers and reports their errors before it ever
    // calls `parsepat`, and the option is only consulted when *that* fails.
    for (const pattern of ["*(z)", "*(f+q)", "*(onon)", "*(om[])", "*(Y)"]) {
      const opts = { ...EXT, bareGlobQual: true, badPattern: false, cwd: "/" };
      expect(() => globSync(pattern, opts), pattern).toThrow(ZshPatternError);
    }
  });

  it("does not invent errors for a count operator zsh accepts", () => {
    // "missing number treated as zero", and there is no check that the range
    // runs the right way -- `(#c3,1)` compiles and simply matches nothing.
    expect(match("", "a(#c)", EXT)).toBe(true);
    expect(match("a", "a(#c)", EXT)).toBe(false);
    expect(match("aaa", "a(#c3,1)", EXT)).toBe(false);
    // A missing maximum is infinity, and a missing minimum is zero.
    expect(match("a", "a(#c1,)", EXT)).toBe(true);
    expect(match("aa", "a(#c,2)", EXT)).toBe(true);
  });

  it("takes a lone [ as an ordinary word when globbing, never when matching", () => {
    // A `[` normally opens a bracket expression and has to be closed, so
    // `x[`, `a[b` and `[abc` are all bad patterns in the shell.  The one
    // exception is a pattern that is nothing but `[`.
    // "`[' and `]' are legal even if bad patterns are usually not" applies to
    // `haswilds()`, which gates globbing; compiling `[` still fails.
    expect(globSync("[", { ...EXT, cwd: "/" })).toEqual(["["]);
    for (const bad of ["[", "[abc", "x[", "a[b"]) {
      expect(() => match(bad, bad, EXT)).toThrow(ZshPatternError);
    }
    // `[]` closes on that first bracket, giving a class that matches nothing.
    expect(match("[]", "[]", EXT)).toBe(false);
    expect(match("x", "[]x", EXT)).toBe(false);
  });

  it("accepts what only EXTENDED_GLOB makes special as plain text", () => {
    expect(match("#foo", "#foo")).toBe(true);
    expect(match("a###", "a###")).toBe(true);
    expect(match("^bar", "^bar")).toBe(true);
    expect(match("a~b", "a~b")).toBe(true);
  });

  it("takes a lone < as an ordinary character, but never an unmatched )", () => {
    expect(match("a<b", "a<b", EXT)).toBe(true);
    expect(match("a<b>c", "a<b>c", EXT)).toBe(true);
    expect(match("1<2", "1<2", EXT)).toBe(true);
    // Compiling `a)b` is an error; as a *glob* it is an ordinary word, because
    // `haswilds()` gates filename generation and does not count Outpar.
    expect(() => match("a)b", "a)b", EXT)).toThrow(ZshPatternError);
    expect(globSync("a)b", { ...EXT, cwd: "/" })).toEqual(["a)b"]);
  });

  it("escapes an operator with a backslash", () => {
    expect(match("*", "\\*", EXT)).toBe(true);
    expect(match("a*b", "a\\*b", EXT)).toBe(true);
    expect(match("axb", "a\\*b", EXT)).toBe(false);
    expect(match("(", "\\(", EXT)).toBe(true);
    expect(match("a\\", "a\\")).toBe(true);
  });
});

describe("errors from filename generation", () => {
  const fs = virtualFs({ "/v": { one: {}, sub: { type: "dir" } }, "/v/sub": { two: {} } });
  const g = (pattern: string, options = {}) =>
    globSync(pattern, { cwd: "/v", fs, extendedGlob: true, ...options });

  it("throws NoMatchError with the pattern on it", () => {
    try {
      g("*.nope");
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(NoMatchError);
      expect((err as NoMatchError).pattern).toBe("*.nope");
    }
  });

  it("refuses a / inside a group", () => {
    // zsh reports a pattern it cannot compile as `bad pattern: <word>`; the
    // reason is in `detail`.
    expect(() => g("(a/b|c)")).toThrow("bad pattern: (a/b|c)");
    expect(() => g("(a/b/)#")).toThrow("bad pattern: (a/b/)#");
  });

  it("passes a pattern error out of a segment", () => {
    expect(() => g("sub/(unclosed")).toThrow(ZshPatternError);
  });

  it("survives a directory it cannot read", () => {
    const broken = virtualFs({ "/v": { sub: { type: "dir" } } }); // no listing for /v/sub
    expect(globSync("sub/*", { cwd: "/v", fs: broken, nullGlob: true })).toEqual([]);
    expect(globSync("*/*", { cwd: "/v", fs: broken, nullGlob: true })).toEqual([]);
  });

  it("drops a candidate whose stat fails", () => {
    const noStat = { ...fs, lstat: () => null, stat: () => null };
    expect(globSync("*(.)", { cwd: "/v", fs: noStat, nullGlob: true })).toEqual([]);
  });
});

describe("the compile cache", () => {
  it("returns the same object for the same inputs", () => {
    expect(compile("a*", EXT)).toBe(compile("a*", EXT));
    expect(compile("a*", EXT)).not.toBe(compile("a*", { kshGlob: true }));
  });

  it("keeps the source and the qualifiers on the pattern", () => {
    const pattern = compile("*.c(#q.)", EXT);
    expect(pattern.source).toBe("*.c(#q.)");
    expect(pattern.qualifiers).toBe(".");
    expect(compile("*.c", EXT).qualifiers).toBeNull();
    expect(pattern.options.extendedGlob).toBe(true);
  });

  it("reports no match rather than throwing from exec and search", () => {
    expect(compile("a*", EXT).exec("zzz")).toBeNull();
    expect(compile("a*", EXT).search("zzz")).toBeNull();
    expect(compile("a*", EXT).matchStart("zzz")).toBeNull();
    expect(compile("a*", EXT).matchEnd("zzz")).toBeNull();
  });
});

/**
 * `if (kshchar && (hash || count)) return 0` in `patcomppiece` -- "too much at
 * once doesn't currently work".  `kshchar` is set for every one of `@( *( +(
 * ?( !(`, and to -1 for a bare `*` ("used as a sign that we can't have #'s"),
 * so none of them may be followed by a closure.  Grouping lifts the
 * restriction, because then the closure applies to the group.
 *
 * Each of these was checked against the zsh built from ./zsh.
 */
describe("a closure may not follow a star or a ksh glob operator", () => {
  const EXTK = { extendedGlob: true, kshGlob: true } as const;

  for (const pattern of [
    "*#",
    "*##",
    "*(#c2,3)",
    "**#",
    "a*#b",
    "@(a|b)#",
    "!(a)#",
    "*(a)#",
    "+(a)#",
    "?(a)#",
    "@(a)(#c2,3)",
  ]) {
    it(`${pattern} is a bad pattern`, () => {
      expect(() => compile(pattern, EXTK)).toThrow(ZshPatternError);
    });
  }

  for (const pattern of ["(*)#", "(*)##", "?#", "[a]#", "<1-3>#", "@(a)", "*"]) {
    it(`${pattern} is not`, () => {
      expect(() => compile(pattern, EXTK)).not.toThrow();
    });
  }
});

/**
 * The three checks `zglob` makes on a qualifier list that this package used to
 * skip, and the two errors it used to invent.  Every expectation was taken
 * from the zsh built from ./zsh.
 */
describe("glob qualifier errors", () => {
  const OPTS = { extendedGlob: true, bareGlobQual: true, cwd: "/" } as const;
  const run = (pattern: string) => globSync(pattern, OPTS);

  it("refuses a sort key given twice", () => {
    // "if (gf_sorts & t) zerr("doubled sort specifier")".  The direction is
    // not part of the key, so `oLOL` is doubled too.
    expect(() => run("*(onon)")).toThrow(/doubled sort specifier/);
    expect(() => run("*(oLOL)")).toThrow(/doubled sort specifier/);
    expect(() => run("*(-oLoL)")).toThrow(/doubled sort specifier/);
  });

  it("but `-` gives a key a different identity, so that pair is allowed", () => {
    // The follow-links sense shifts the type of a key that has to stat.
    expect(() => run("*(oL-oL)")).not.toThrow();
    expect(() => run("*(oLon)")).not.toThrow();
  });

  it("refuses more than MAX_SORTS specifiers", () => {
    // Only `oe` may repeat, so reaching twelve takes twelve of them -- and
    // `oe` runs shell code, which this package asks the caller to supply.
    const withHook = { ...OPTS, qualifierHooks: { sortKey: () => "" } };
    const twelve = "oe:x:".repeat(12);
    expect(() => globSync(`*(${twelve})`, withHook)).not.toThrow();
    expect(() => globSync(`*(${twelve}oe:x:)`, withHook)).toThrow(
      /too many glob sort specifiers/,
    );
  });

  it("refuses a short circuit count that will not fit an int", () => {
    expect(() => run("*(Y2147483647)")).not.toThrow();
    expect(() => run("*(Y2147483648)")).toThrow(/value too big/);
    expect(() => run("*(Y99999999999999999999)")).toThrow(/value too big/);
  });
});

import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { globSync, match, ZshPatternError } from "../src/index.js";
import { virtualFs } from "./helpers/virtual-fs.js";

/**
 * `parsepat` peels one leading `(#...)` off the whole word before
 * `parsecomplist` ever sees it, "so that they don't form a bogus path
 * component".  Two things follow, and this package used to get both wrong.
 *
 * Every expectation here was taken from the zsh built from ./zsh.
 */
let tree: string;
const EXT = { extendedGlob: true, nullGlob: true } as const;

beforeAll(() => {
  tree = mkdtempSync(join(tmpdir(), "zsh-glob-flags-"));
  mkdirSync(join(tree, "sub", "deep"), { recursive: true });
  for (const f of ["a", "a.txt", "B.TXT", "sub/s1.txt", "sub/deep/d1.txt"]) {
    writeFileSync(join(tree, f), "");
  }
  symlinkSync("sub", join(tree, "slink"));
});

afterAll(() => rmSync(tree, { recursive: true, force: true }));

const run = (pattern: string, extra = {}) =>
  globSync(pattern, { cwd: tree, ...EXT, ...extra }).sort();

describe("a leading globbing flag does not eat the globstar", () => {
  it("(#i)**/ still recurses, and matches case insensitively", () => {
    expect(run("(#i)**/*.txt")).toEqual(["B.TXT", "a.txt", "sub/deep/d1.txt", "sub/s1.txt"]);
  });

  it("(#i)***/ likewise, following the symlink", () => {
    expect(run("(#i)***/*.txt")).toEqual([
      "B.TXT",
      "a.txt",
      "slink/deep/d1.txt",
      "slink/s1.txt",
      "sub/deep/d1.txt",
      "sub/s1.txt",
    ]);
  });

  it("but only the first group is peeled, so a second one does eat it", () => {
    // `(#i)(#l)**/` is `(#i)(#l)*/`: one directory level, no recursion.
    expect(run("(#i)(#l)**/*.txt")).toEqual(["slink/s1.txt", "sub/s1.txt"]);
  });

  it("and a flag that is not at the front never had the chance", () => {
    expect(run("sub/(#i)**/*.txt")).toEqual(["sub/deep/d1.txt"]);
  });

  it("the flags reach every component, not just the first", () => {
    expect(run("(#i)SUB/*.TXT")).toEqual(["sub/s1.txt"]);
  });

  it("a peeled group is still checked", () => {
    // "*assertp && (*strp)[1] != Outpar": an assertion must be alone.
    expect(() => run("(#se)a")).toThrow(ZshPatternError);
  });
});

describe("a leading (#s) or (#e) asserts nothing when globbing", () => {
  // `parsepat` collects the assertion into a local it then never reads.  In
  // plain matching it still asserts -- `[[ a = (#e)a ]]` is false -- and that
  // path does not come through here.
  it("(#e) at the front is dropped", () => {
    expect(run("(#e)a")).toEqual(["a"]);
    expect(run("(#e)*").length).toBeGreaterThan(1);
  });

  it("(#s) at the front is dropped too, which is a no-op anyway", () => {
    expect(run("(#s)a")).toEqual(["a"]);
  });
});

describe("a word that is only a root and a qualifier", () => {
  // This used to be a TypeError: the word leaves no path components at all.
  it("/(/) is the root directory", () => {
    expect(globSync("/(/)", { ...EXT, bareGlobQual: true })).toEqual(["/"]);
    expect(globSync("/(N)", { ...EXT, bareGlobQual: true })).toEqual(["/"]);
  });

  it("and a component of nothing but flags is an empty name", () => {
    // Which is a directory only through the slash that follows it.
    expect(run("(#l)(#l)/")).toEqual(["/"]);
    expect(run("(#l)(#l)")).toEqual([]);
  });
});

/**
 * Globbing flags away from the front of the pattern.  `patcompbranch` has
 * three cases for a flag group and the corpus only ever exercised the first:
 * at the very start it goes into the header, in the middle it becomes a
 * `P_GFLAGS` node, and at the very end it emits nothing at all, being left
 * "for the next Patprog in the chain to pick up".
 *
 * Every expectation was taken from the zsh built from ./zsh.
 */
describe("a globbing flag that is not at the front", () => {
  let files: string;

  beforeAll(() => {
    files = mkdtempSync(join(tmpdir(), "zsh-glob-midflag-"));
    mkdirSync(join(files, "sub"));
    for (const f of ["a.txt", "ab.txt", "link.txt", "sub/x", "sub/yy"]) {
      writeFileSync(join(files, f), "");
    }
  });

  afterAll(() => rmSync(files, { recursive: true, force: true }));

  const run = (pattern: string) =>
    globSync(pattern, { cwd: files, extendedGlob: true, nullGlob: true }).sort();

  const cases: [string, string[]][] = [
    ["(#i)*a.txt(#a1)", ["a.txt"]],
    ["*[a-z](#a1)[a-z].txt", ["ab.txt", "link.txt"]],
    ["(#e)a*[a-z](#a1)", ["a.txt", "ab.txt"]],
    // A flag group at the very end of the word has no effect at all, so this
    // stays a two character pattern and never reaches `sub`.
    ["(#e)(#i)??(#a1)", []],
    ["??(#a1)", []],
    // With a leading group it does apply, and one error absorbs the third
    // character.
    ["(#a1)??", ["sub"]],
    // A `/` is more of the word, so the group is no longer at the end.
    ["??(#a1)/x", ["sub/x"]],
    ["??(#a1)/", ["sub/"]],
  ];

  for (const [pattern, expected] of cases) {
    it(`${pattern} matches ${expected.join(", ") || "nothing"}`, () => {
      expect(run(pattern)).toEqual(expected);
    });
  }
});

describe("a flag group that changes nothing", () => {
  // "Only one string in a PAT_PURES, so now done": a pattern of nothing but
  // literal text is compared as a plain string, and only its first run is
  // kept.  A flag group with no effect emits no node, so it splits the text
  // into two runs while leaving it a pure string, and the second is lost.
  const EXT = { extendedGlob: true } as const;

  it("truncates an otherwise wholly literal pattern", () => {
    expect(match("a", "a(#a0)b", EXT)).toBe(true);
    expect(match("ab", "a(#a0)b", EXT)).toBe(false);
  });

  it("but a group that does change something emits a node, and is fine", () => {
    expect(match("ab", "a(#i)b", EXT)).toBe(true);
    expect(match("aB", "a(#i)b", EXT)).toBe(true);
    expect(match("a", "a(#i)b", EXT)).toBe(false);
    expect(match("ab", "a(#a1)b", EXT)).toBe(true);
  });

  it("and anything that is not literal text keeps the pattern whole", () => {
    expect(match("ab", "a(#a0)b*", EXT)).toBe(true);
    expect(match("ab", "a(#a0)[b]", EXT)).toBe(true);
    expect(match("a", "a(#a0)[b]", EXT)).toBe(false);
  });
});

/**
 * `^` and `~` are both exclusions, and the flags they see are not the flags in
 * force where they are written.
 *
 * Every expectation was taken from the zsh built from ./zsh.
 */
describe("exclusions and the flags they see", () => {
  const EXT = { extendedGlob: true } as const;
  const m = (s: string, p: string) => match(s, p, EXT);

  it("approximation is off inside a ^ exclusion, as it is inside a ~ one", () => {
    // `(#a1)^ab` is `(#a1)(*~ab)`: the `ab` is matched exactly, so `ac` is not
    // excluded, and the star absorbs the odd character instead.
    expect(m("ac", "(#a1)^ab")).toBe(true);
    expect(m("ab", "(#a1)^ab")).toBe(true);
    // Asked for again inside the exclusion, it applies.
    expect(m("ac", "^(#a1)ab")).toBe(false);
    expect(m("ab", "^(#a1)ab")).toBe(false);
  });

  it("but a case flag does reach it", () => {
    expect(m("aB", "(#i)^ab")).toBe(false);
    expect(m("aB", "^ab")).toBe(true);
  });

  it("unless it was set inside the group the ^ is in", () => {
    // Inside parentheses the exclusion is compiled through `patcompswitch`,
    // and comes out matching with the flags the group was entered with.
    expect(m("aB", "((#i)^ab)")).toBe(true);
    expect(m("aaB", "(a(#i)^ab)")).toBe(true);
    // From outside the group it applies as usual.
    expect(m("aB", "(#i)(^ab)")).toBe(false);
    expect(m("aaB", "(#i)(a^ab)")).toBe(false);
  });

  it("an exclusion is not retried at an end another alternative reached", () => {
    // P_EXCSYNC: "if we already matched from here, this time we fail".  Both
    // alternatives run into the same node, so `^b` cannot re-use the end that
    // `^a` was excluded at.
    expect(m("a", "(^a|^b)")).toBe(true);
    expect(m("a", "(^a|^b)~c")).toBe(false);
    expect(m("b", "(^a|^b)~c")).toBe(true);
    expect(m("d", "(^a|^b)~c")).toBe(true);
  });

  it("an exclusion may spend errors reaching the end the branch reached", () => {
    expect(m("abc", "(#a2)abc~(#a2)b")).toBe(false);
    expect(m("abc", "(#a2)abc~b")).toBe(true);
  });
});

/**
 * A group restores the flags it was entered with by emitting a node that puts
 * them back -- but only "if gfchanged", that is if compiling its branch left
 * them different.  An exclusion clears the error budget at compile time and
 * nothing restores it, so a group whose branch contains a *nested* exclusion
 * can come out looking unchanged, emit no restoring node, and leave the budget
 * it set in force after itself.
 *
 * Only the budget: an exclusion clears `patglobflags & 0xff` and nothing else,
 * so a case flag never leaks this way.  And only a nested one: the group's own
 * exclusion is compiled after `gfchanged` has already been decided.
 */
describe("a group that does not put its flags back", () => {
  const EXT = { extendedGlob: true } as const;
  const m = (s: string, p: string) => match(s, p, EXT);

  it("leaks the budget past a group holding a nested exclusion", () => {
    // `c` absorbs the trailing `d` with the budget the group set.
    expect(m("abcd", "((#a2)(a~b)c)")).toBe(true);
    // Without the exclusion the restore is emitted and the budget is gone.
    expect(m("abcd", "((#a2)(a)c)")).toBe(false);
    expect(m("abcd", "((#a2)ac)")).toBe(false);
  });

  it("but the group's own exclusion is decided too late to count", () => {
    expect(m("aB", "((#a1)a~b)")).toBe(false);
  });

  it("and a case flag never leaks, only the budget", () => {
    expect(m("ab", "((#i)A~z)B")).toBe(false);
    expect(m("ab", "((#i)A~z)b")).toBe(true);
  });
});

/**
 * A run of globbing flag groups with nothing else can come to two different
 * things, and only compiling tells them apart.  `patcompbranch` has three
 * cases: a group at the very start goes into the header, one at the very end
 * is left "for the next Patprog in the chain", and anything in between is
 * emitted as a `P_GFLAGS` node -- but only "if oldglobflags != patglobflags",
 * since a group that changes nothing has "No effect".
 *
 * With no node at all the pattern is `PAT_PURES` holding an empty string, and
 * zsh compares it as one: no flag reaches it, so it matches only `""`.  One
 * node is enough to stop that, and then the flags are in force when the end
 * is reached, so an error can absorb a character.
 */
describe("a run of flag groups", () => {
  const EXT = { extendedGlob: true } as const;
  const m = (p: string) => match("a", p, EXT);

  it("matches nothing when it compiles to no node", () => {
    expect(m("(#a1)")).toBe(false);
    expect(m("(#a1)(#a1)")).toBe(false);
    expect(m("(#a1)(#a1)(#a1)(#a1)")).toBe(false);
  });

  it("but matches a character once one group in the middle is emitted", () => {
    // The `(#i)` changes something and is neither first nor last.
    expect(m("(#a1)(#i)(#a1)")).toBe(true);
    expect(m("(#i)(#a1)(#a1)(#a1)")).toBe(true);
    expect(m("(#a1)(#a1)(#a1)(#i)(#a1)")).toBe(true);
  });

  it("and an assertion is a node whatever else is there", () => {
    expect(m("(#a1)(#e)")).toBe(true);
    expect(m("(#a1)(#s)")).toBe(true);
  });

  it("which the globber sees the same way, one group further along", () => {
    // `parsepat` peels the first group before the components are split, so
    // the group after it is the one at `patstart` there.
    const files = { "/t": { a: {} } };
    const run = (p: string) =>
      globSync(p, { cwd: "/t", extendedGlob: true, nullGlob: true, fs: virtualFs(files) });
    expect(run("(#a1)(#a1)(#a1)(#i)(#a1)")).toEqual(["a"]);
    expect(run("(#a1)(#i)(#a1)")).toEqual([]);
    expect(run("(#i)(#a1)(#a1)(#a1)")).toEqual([]);
    expect(run("(#a1)(#a1)(#a1)(#a1)")).toEqual([]);
  });
});

import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  compile,
  glob,
  globSync,
  match,
  nodeAsyncFs,
  nodeSyncFs,
  NoMatchError,
  ZshPatternError,
} from "../src/index.js";
import { virtualFs } from "./helpers/virtual-fs.js";

let tree: string;

beforeAll(() => {
  tree = mkdtempSync(join(tmpdir(), "zsh-int-"));
  mkdirSync(join(tree, "sub"));
  writeFileSync(join(tree, "a.txt"), "a");
  writeFileSync(join(tree, "sub/b.txt"), "bb");
  writeFileSync(join(tree, "we(i)rd"), "");
  writeFileSync(join(tree, "weird"), "");
  writeFileSync(join(tree, "star*name"), "");
  symlinkSync("..", join(tree, "sub/up")); // a loop for ***/ to survive
});

afterAll(() => rmSync(tree, { recursive: true, force: true }));

describe("the asynchronous API", () => {
  it("applies qualifiers, which need stats", async () => {
    expect(await glob("*(.)", { cwd: tree })).toEqual([
      "a.txt", "star*name", "we(i)rd", "weird",
    ]);
    expect(await glob("*(/)", { cwd: tree })).toEqual(["sub"]);
    expect(await glob("*(-@)", { cwd: tree, nullGlob: true })).toEqual([]);
  });

  it("sorts by a key that needs stats", async () => {
    expect(await glob("**/*.txt(.OL)", { cwd: tree, extendedGlob: true })).toEqual([
      "sub/b.txt",
      "a.txt",
    ]);
  });

  it("follows symlinks asynchronously when a qualifier asks it to", async () => {
    expect(await glob("sub/*(-/)", { cwd: tree, nullGlob: true })).toEqual(["sub/up"]);
    expect(await glob("***/b.txt", { cwd: tree, extendedGlob: true, nullGlob: true })).toContain(
      "sub/b.txt",
    );
  });

  it("returns nothing for a directory it cannot read", async () => {
    expect(await glob("nowhere/*", { cwd: tree, nullGlob: true })).toEqual([]);
  });

  it("checks existence of a literal segment, so a missing file is no match", async () => {
    await expect(glob("*/missing.txt", { cwd: tree })).rejects.toThrow(NoMatchError);
    expect(await glob("sub/b.txt(#q.)", { cwd: tree, extendedGlob: true })).toEqual(["sub/b.txt"]);
    // A word with nothing to match is passed straight through, as in the shell.
    expect(await glob("sub/missing.txt", { cwd: tree })).toEqual(["sub/missing.txt"]);
  });

  it("reports a bad pattern the same way as globSync", async () => {
    await expect(glob("(unclosed", { cwd: tree, extendedGlob: true })).rejects.toThrow(
      ZshPatternError,
    );
  });
});

describe("the node filesystem adapters", () => {
  it("return null instead of throwing", () => {
    const sync = nodeSyncFs();
    expect(sync.readdir(join(tree, "nowhere"))).toBeNull();
    expect(sync.lstat(join(tree, "nowhere"))).toBeNull();
    expect(sync.stat(join(tree, "nowhere"))).toBeNull();
    expect(sync.lstat(join(tree, "a.txt"))?.isFile()).toBe(true);
  });

  it("return null instead of rejecting", async () => {
    const async = nodeAsyncFs();
    expect(await async.readdir(join(tree, "nowhere"))).toBeNull();
    expect(await async.lstat(join(tree, "nowhere"))).toBeNull();
    expect(await async.stat(join(tree, "nowhere"))).toBeNull();
    expect((await async.stat(join(tree, "sub")))?.isDirectory()).toBe(true);
  });
});

describe("escaping in a filename generation pattern", () => {
  const g = (pattern: string) =>
    globSync(pattern, { cwd: tree, extendedGlob: true, nullGlob: true });

  it("takes an escaped operator literally", () => {
    expect(g("star\\*name")).toEqual(["star*name"]);
    expect(g("we\\(i\\)rd")).toEqual(["we(i)rd"]);
    expect(g("star\\*n*")).toEqual(["star*name"]);
  });

  it("still separates segments at an escaped slash, since no name holds one", () => {
    expect(g("sub\\/b.txt")).toEqual(["sub/b.txt"]);
  });

  it("keeps a trailing group that is not a qualifier list as part of the pattern", () => {
    // `(i|x)` holds a `|`, so it is an alternation rather than a qualifier
    // list, and matches the file called `weird`.
    expect(g("we(i|x)rd")).toEqual(["weird"]);
    // So is a group holding `~` while EXTENDED_GLOB is on.
    expect(g("we(ird~x)")).toEqual(["weird"]);
    // A trailing group that could be either is read as qualifiers.
    expect(g("we*(.)")).toEqual(["we(i)rd", "weird"]);
  });
});

describe("recursion limits", () => {
  it("does not loop through a symlink cycle with ***/", () => {
    const found = globSync("***/b.txt", { cwd: tree, extendedGlob: true, nullGlob: true });
    expect(found).toContain("sub/b.txt");
    expect(found.every((path) => path.split("/").length < 10)).toBe(true);
  });

  it("stops at maxDepth", () => {
    const deep = mkdtempSync(join(tmpdir(), "zsh-deep-"));
    let path = deep;
    for (let i = 0; i < 6; i++) {
      path = join(path, "d");
      mkdirSync(path);
    }
    writeFileSync(join(path, "found.txt"), "");
    expect(globSync("**/found.txt", { cwd: deep, extendedGlob: true, nullGlob: true })).toEqual([
      "d/d/d/d/d/d/found.txt",
    ]);
    expect(
      globSync("**/found.txt", { cwd: deep, extendedGlob: true, nullGlob: true, maxDepth: 3 }),
    ).toEqual([]);
    rmSync(deep, { recursive: true, force: true });
  });

  it("skips . and .. even when the filesystem lists them", () => {
    const withDots = {
      readdir: () => [
        { name: ".", isDirectory: () => true, isSymbolicLink: () => false },
        { name: "..", isDirectory: () => true, isSymbolicLink: () => false },
        { name: "real", isDirectory: () => false, isSymbolicLink: () => false },
      ],
      lstat: () => null,
      stat: () => null,
    };
    expect(globSync("*", { cwd: "/v", fs: withDots, globDots: true, nullGlob: true })).toEqual([
      "real",
    ]);
    expect(globSync("**/*", { cwd: "/v", fs: withDots, globDots: true, nullGlob: true })).toEqual([
      "real",
    ]);
  });
});

describe("odds and ends", () => {
  it("takes ) literally only when the word is not a pattern", () => {
    // zsh accepts `a)b` and `)x` as ordinary words, but rejects `*)` and
    // `(a|b))`: once the word is a pattern, an unmatched `)` is an error.
    expect(globSync("weird)", { cwd: tree, nullGlob: true })).toEqual(["weird)"]);
    expect(() => globSync("*)", { cwd: tree, nullGlob: true })).toThrow(ZshPatternError);
    expect(() => globSync("(a|b))", { cwd: tree, extendedGlob: true })).toThrow(ZshPatternError);
  });

  it("handles an escape inside a recursive closure", () => {
    expect(globSync("(sub\\x/)#b.txt", { cwd: tree, extendedGlob: true, nullGlob: true })).toEqual(
      [],
    );
  });

  it("sorts by depth where one path is a prefix of another", () => {
    expect(globSync("**/*(od)", { cwd: tree, extendedGlob: true, nullGlob: true })[0]).toMatch(
      /^sub\//,
    );
    // `dir/` is a prefix of `dir/sub/`, the case zsh's depth comparison has a
    // special adjustment for.
    const nested = mkdtempSync(join(tmpdir(), "zsh-depth-"));
    mkdirSync(join(nested, "dir/sub"), { recursive: true });
    expect(globSync("**/(#qod)", { cwd: nested, extendedGlob: true, nullGlob: true })).toEqual([
      "dir/sub/",
      "dir/",
    ]);
    rmSync(nested, { recursive: true, force: true });
  });

  it("marks a type it does not recognise with ?", () => {
    const odd = {
      readdir: () => [{ name: "thing", isDirectory: () => false, isSymbolicLink: () => false }],
      lstat: () => ({
        isDirectory: () => false, isFile: () => false, isSymbolicLink: () => false,
        isBlockDevice: () => false, isCharacterDevice: () => false, isFIFO: () => false,
        isSocket: () => false,
        mode: 0o644, uid: 0, gid: 0, nlink: 1, size: 0, dev: 0, ino: 1,
        atimeMs: 0, mtimeMs: 0, ctimeMs: 0,
      }),
      stat: () => null,
    };
    expect(globSync("*(T)", { cwd: "/v", fs: odd, nullGlob: true })).toEqual(["thing?"]);
  });

  it("nests brackets inside a qualifier delimiter", () => {
    expect(
      globSync("*(#qe(a(b)c))", {
        cwd: tree,
        extendedGlob: true,
        nullGlob: true,
        qualifierHooks: { evaluate: (code) => code === "a(b)c" },
      }),
    ).toHaveLength(5);
  });

  it("keeps compiling after the pattern cache fills up", () => {
    for (let i = 0; i < 520; i++) expect(match(`f${i}`, `f${i}*`)).toBe(true);
  });
});

describe("numeric sorting", () => {
  const fs = virtualFs({
    "/v": { "f2": {}, "f10": {}, "f1": {}, "f10b": {}, "f2b": {}, "g1": {} },
  });
  const g = (pattern: string, options = {}) =>
    globSync(pattern, { cwd: "/v", fs, nullGlob: true, ...options });

  it("compares embedded numbers as numbers", () => {
    expect(g("f*")).toEqual(["f1", "f10", "f10b", "f2", "f2b"]);
    expect(g("f*", { numericGlobSort: true })).toEqual(["f1", "f2", "f2b", "f10", "f10b"]);
  });

  it("falls back to the characters around the numbers", () => {
    expect(g("*", { numericGlobSort: true })).toEqual([
      "f1", "f2", "f2b", "f10", "f10b", "g1",
    ]);
  });
});

describe("flags that only affect other flags", () => {
  const EXT = { extendedGlob: true } as const;

  it("switches backreferences and match references off again", () => {
    expect(compile("(#b)(a)(#B)(b)", EXT).exec("ab")?.groups).toEqual(["a"]);
    expect(match("ab", "(#m)a(#M)b", EXT)).toBe(true);
  });

  it("parses (#u) and (#U) and carries on", () => {
    expect(match("é", "(#u)?", EXT)).toBe(true);
    expect(match("é", "(#U)?", EXT)).toBe(true);
  });

  it("accepts the ksh spelling of a count", () => {
    expect(match("aaa", "a@(#c3)", { ...EXT, kshGlob: true })).toBe(true);
    expect(match("aa", "a@(#c3)", { ...EXT, kshGlob: true })).toBe(false);
  });

  it("accepts the ksh spelling of globbing flags", () => {
    expect(match("ABC", "@(#i)abc", { ...EXT, kshGlob: true })).toBe(true);
  });
});

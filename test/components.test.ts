import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { globSync } from "../src/index.js";
import { virtualFs, type VirtualTree } from "./helpers/virtual-fs.js";

/**
 * A glob is a list of components joined by one `/` each, and an empty
 * component is a real one: it matches the empty name and contributes its own
 * slash.  A leading empty component is what makes a path absolute.
 *
 * Every expectation was taken from the zsh built from ./zsh.
 */
let tree: string;

beforeAll(() => {
  tree = mkdtempSync(join(tmpdir(), "zsh-glob-comp-"));
  mkdirSync(join(tree, "sub", "deep"), { recursive: true });
  mkdirSync(join(tree, "empty"));
  writeFileSync(join(tree, "a"), "");
  for (const f of ["a.txt", "b.txt", "c.txt", "sub/x.txt"]) writeFileSync(join(tree, f), "");
});

afterAll(() => rmSync(tree, { recursive: true, force: true }));

const run = (pattern: string) =>
  globSync(pattern, { cwd: tree, extendedGlob: true, nullGlob: true }).sort();

describe("a closure that matches nothing leaves the rest absolute", () => {
  // `**\/` may match zero components, and then the empty component after it is
  // the first one, so the path starts at the root -- where these do not exist.
  const cases: [string, string[]][] = [
    ["**//sub", []],
    ["***//sub", []],
    ["**//a.txt", []],
    ["**//x.txt", ["sub//x.txt"]],
    // With one slash there is no empty component and the path stays relative.
    ["**/sub", ["sub"]],
    ["**/a.txt", ["a.txt"]],
    ["**/x.txt", ["sub/x.txt"]],
  ];

  for (const [pattern, expected] of cases) {
    it(`${pattern} gives ${expected.join(" ") || "nothing"}`, () => {
      expect(run(pattern)).toEqual(expected);
    });
  }
});

describe("an assertion is not a flag", () => {
  // `(#s)` and `(#e)` are "handled as a normal node", so a component holding
  // one has something in it and is not the empty component that a group of
  // plain flags compiles to.  With an empty body an error can still be spent
  // on the subject, so `(#a1)(#e)` matches any one character name.
  it("(#aN)(#e) matches a one character name", () => {
    expect(run("(#a1)(#e)")).toEqual(["a"]);
    expect(run("(#a1)(#a1)(#e)")).toEqual(["a"]);
    expect(run("(#a2)(#e)")).toEqual(["a"]);
    expect(run("(#a1)(#s)")).toEqual(["a"]);
  });

  it("while the same flags with no assertion are an empty component", () => {
    expect(run("(#a1)(#a1)")).toEqual([]);
    expect(run("(#i)(#i)/sub")).toEqual([]);
  });

  it("and without a budget the anchor only matches the empty name", () => {
    expect(run("(#e)")).toEqual([]);
  });
});

describe("a component of nothing but flags is an empty component", () => {
  it("so it makes the path absolute, as an empty component does", () => {
    // `(#i)(#i)/sub` is `/sub` once the first group is peeled and the second
    // compiles to an empty pure string.
    expect(run("(#i)(#i)/sub")).toEqual([]);
    expect(run("(#i)/sub")).toEqual([]);
  });

  it("and the flags themselves still apply", () => {
    expect(run("(#i)(#i)A.TXT")).toEqual(["a.txt"]);
  });
});

describe("a redundant flag group does not truncate a pattern under one that is active", () => {
  // "It's much simpler to turn off pure string mode for any case-insensitive
  // or approximate matching": a run compiled while one of those is in force is
  // not a pure string, so both runs survive.
  it("keeps both runs when a case flag is in force", () => {
    expect(run("(#i)a.txt(#i).txt")).toEqual([]);
    expect(run("(#i)a(#i).txt")).toEqual(["a.txt"]);
  });
});

describe("empty components in front of a globstar", () => {
  // The closure may take no directory at all, but the empty components
  // written before it are components in their own right and still contribute
  // their slashes.
  it("survive when the closure takes nothing", () => {
    expect(run("sub//**/")).toEqual(["sub//", "sub//deep/"]);
    expect(run("sub//**/deep")).toEqual(["sub//deep"]);
  });

  it("and one slash still behaves as it did", () => {
    expect(run("sub/**/")).toEqual(["sub/", "sub/deep/"]);
    expect(run("**/")).toEqual(["empty/", "sub/", "sub/deep/"]);
  });
});

describe("a top level exclusion stays in the component it belongs to", () => {
  // zsh keeps it in that component's own program, where it can interact with
  // an exclusion inside the branch; pulling it out to test separately loses
  // that.  `*^` matches every non-empty name and `~a.txt` excludes only one,
  // yet together they match nothing.
  it("so ^ and ~ in one component combine", () => {
    expect(run("*^~a.txt")).toEqual([]);
    expect(run("(*^)~a.txt")).toEqual([]);
  });

  it("while each alone behaves as before", () => {
    expect(run("*^a.txt")).toEqual(["a", "a.txt", "b.txt", "c.txt", "empty", "sub"]);
    expect(run("*~a.txt")).toEqual(["a", "b.txt", "c.txt", "empty", "sub"]);
  });

  it("and an exclusion spanning components still applies to the path", () => {
    expect(run("sub/*~*x*")).toEqual(["sub/deep"]);
    expect(run("sub/*~*z*")).toEqual(["sub/deep", "sub/x.txt"]);
  });
});

/**
 * A slash run can make what follows absolute, and what follows may itself be a
 * closure -- which must then walk from the root.  Checked on a virtual
 * filesystem so the root is a handful of entries rather than the machine's.
 */
describe("a closure after a slash run walks from the root", () => {
  const vtree: VirtualTree = {
    "/": { one: { type: "dir" }, two: { type: "dir" } },
    "/one": { deep: { type: "dir" } },
    "/one/deep": { f: {} },
    "/two": {},
    "/cwd": { here: { type: "dir" } },
    "/cwd/here": {},
  };

  const run = (pattern: string) =>
    globSync(pattern, {
      cwd: "/cwd",
      extendedGlob: true,
      nullGlob: true,
      fs: virtualFs(vtree),
    }).sort();

  it("lists the root rather than the working directory", () => {
    // The empty component after the closure makes the rest absolute, so the
    // second closure starts at `/` -- not at `/cwd`, which is what it did
    // while the recursive branch was still resolving against the prefix alone.
    // `here//` is the other branch: the first closure took a directory, so
    // that side stayed relative and the empty component kept its slash.
    expect(run("**//**/")).toEqual(["/", "/one/", "/one/deep/", "/two/", "here//"]);
  });

  it("and a plain component after the run is absolute too", () => {
    expect(run("**//one")).toEqual(["/one"]);
    expect(run("**//here")).toEqual([]);
  });

  it("while one slash keeps it relative", () => {
    expect(run("**/here")).toEqual(["here"]);
  });
});

import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { globSync } from "../src/index.js";
import { canSymlink, trySymlink } from "./helpers/platform.js";

/**
 * `parsecomplist` recurses past each `/`, so a run of slashes is
 * a run of components, each matching the empty name and contributing a slash
 * of its own.  The run therefore survives into the result: `sub//x` stays
 * `sub//x`, and so does `*\/\/x` once the star has matched.
 *
 * Taken from the zsh built from ./zsh.
 */
let tree: string;

beforeAll(() => {
  tree = mkdtempSync(join(tmpdir(), "zsh-glob-sep-"));
  mkdirSync(join(tree, "sub"));
  mkdirSync(join(tree, "empty"));
  writeFileSync(join(tree, "sub", "s1.txt"), "");
  trySymlink("sub", join(tree, "slink"));
});

afterAll(() => rmSync(tree, { recursive: true, force: true }));

const run = (pattern: string) =>
  globSync(pattern, { cwd: tree, extendedGlob: true, nullGlob: true }).sort();

// The tree has a symlink in it, and these expectations name it.
describe.skipIf(!canSymlink)("a run of slashes is kept", () => {
  const cases: [string, string[]][] = [
    ["sub//s1.txt", ["sub//s1.txt"]],
    ["sub//", ["sub//"]],
    ["sub///s1.txt", ["sub///s1.txt"]],
    ["sub//*", ["sub//s1.txt"]],
    // The star used to collapse the run.
    ["*//", ["empty//", "slink//", "sub//"]],
    ["*//*.txt", ["slink//s1.txt", "sub//s1.txt"]],
    ["*///", ["empty///", "slink///", "sub///"]],
    ["su*//s1.txt", ["sub//s1.txt"]],
    // And one slash still behaves as it always did.
    ["*/", ["empty/", "slink/", "sub/"]],
    ["sub/s1.txt", ["sub/s1.txt"]],
    ["**/", ["empty/", "sub/"]],
  ];

  for (const [pattern, expected] of cases) {
    it(`${pattern} gives ${expected.join(" ") || "nothing"}`, () => {
      expect(run(pattern)).toEqual(expected);
    });
  }

  it("a closure that consumed nothing joins one slash fewer", () => {
    // `**\/` reports nothing for the zero-directory case, because joining a
    // single empty component gives the empty string; `**\/\/` joins two and
    // gives "/".
    expect(run("**//")).toEqual(["/", "empty//", "sub//"]);
    expect(run("**///")).toEqual(["//", "empty///", "sub///"]);
  });

  it("an absolute pattern keeps its leading run", () => {
    const roots = globSync("//*", { nullGlob: true });
    expect(roots.length).toBeGreaterThan(0);
    expect(roots.every((p) => p.startsWith("//") && !p.startsWith("///"))).toBe(true);
  });
});

/**
 * `zreaddir` converts each name from "UTF-8-MAC" to "UTF-8" with `iconv` on
 * Apple platforms, so a decomposed name is composed before it is matched or
 * reported.  It changes what matches, not just the bytes: a name stored as
 * `e` + U+0301 is ten characters to zsh and eleven on disk.
 */
describe("directory entry names are composed", () => {
  let nfd: string;
  const decomposed = "éclair.txt";

  beforeAll(() => {
    nfd = mkdtempSync(join(tmpdir(), "zsh-glob-nfd-"));
    writeFileSync(join(nfd, decomposed), "");
  });

  afterAll(() => rmSync(nfd, { recursive: true, force: true }));

  const withNfc = (pattern: string, nfcNames: boolean) =>
    globSync(pattern, { cwd: nfd, extendedGlob: true, nullGlob: true, nfcNames });

  it("only matters where the filesystem kept the name decomposed", () => {
    // A filesystem that composes on the way in leaves nothing to test.
    expect(readdirSync(nfd)[0].normalize("NFD")).toBe(decomposed);
  });

  it("composed, one ? covers the accented letter", () => {
    expect(withNfc("?clair.txt", true)).toEqual(["éclair.txt"]);
    expect(withNfc("[[:alpha:]]clair.txt", true)).toEqual(["éclair.txt"]);
  });

  it("and a bare e is no longer exposed to a range", () => {
    expect(withNfc("[a-z]*", true)).toEqual([]);
    expect(withNfc("??clair.txt", true)).toEqual([]);
  });

  it("turned off, the name is matched as the bytes hold it", () => {
    expect(withNfc("?clair.txt", false)).toEqual([]);
    expect(withNfc("??clair.txt", false)).toEqual([decomposed]);
    expect(withNfc("[a-z]*", false)).toEqual([decomposed]);
  });
});

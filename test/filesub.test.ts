import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { expandWordsSync, globSync } from "../src/index.js";
import { asPattern } from "./helpers/platform.js";
import { expandFilename, type FileExpansionEnv } from "../src/filesub.js";
import { ZshPatternError } from "../src/errors.js";
import { resolveOptions, type ZshOptionsInput } from "../src/options.js";

/**
 * Filename expansion, checked against what a real zsh answered.
 *
 * The shell was put in a known state -- `cd a; cd b; pushd c` -- and asked for
 * every form; `dirs` then read `/tmp/zgt/c /tmp/zgt/b`, which is the current
 * directory followed by the stack proper.  The stack passed in here is that
 * list without its head, because `~0` is the current directory and is not on
 * the stack at all.
 */
const ENV: FileExpansionEnv = {
  home: "/Users/me",
  cwd: "/tmp/zgt/c",
  oldpwd: "/tmp/zgt/b",
  dirStack: ["/tmp/zgt/b"],
};

const g = (word: string, env: FileExpansionEnv = ENV, opts: ZshOptionsInput = {}) =>
  expandFilename(word, resolveOptions(opts), env);

describe("filename expansion", () => {
  it("expands the three that name a directory outright", () => {
    expect(g("~")).toBe("/Users/me");
    expect(g("~/x")).toBe("/Users/me/x");
    expect(g("~+")).toBe("/tmp/zgt/c");
    expect(g("~+/x")).toBe("/tmp/zgt/c/x");
    expect(g("~-")).toBe("/tmp/zgt/b");
    expect(g("~-/x")).toBe("/tmp/zgt/b/x");
  });

  // Counting from the near end is one ahead of the array, because `~0` is the
  // current directory and the stack does not hold it.
  it("counts the directory stack from either end", () => {
    expect(g("~0")).toBe("/tmp/zgt/c");
    expect(g("~1")).toBe("/tmp/zgt/b");
    expect(g("~+1")).toBe("/tmp/zgt/b");
    expect(g("~-0")).toBe("/tmp/zgt/b");
    expect(g("~-1")).toBe("/tmp/zgt/c");
  });

  it("reports a stack that does not go that far", () => {
    expect(() => g("~2/x")).toThrow("not enough directory stack entries.");
  });

  // Three digits is past what the number form accepts, so it becomes a name.
  it("reads more than two digits as a name, not a number", () => {
    expect(() => g("~123")).toThrow("no such user or named directory: 123");
    expect(g("~123", { ...ENV, namedDirs: () => "/dir" })).toBe("/dir");
  });

  it("looks up a named directory, and says so when there is none", () => {
    expect(g("~proj/src", { ...ENV, namedDirs: (n) => (n === "proj" ? "/w/proj" : null) })).toBe(
      "/w/proj/src",
    );
    expect(() => g("~nobody")).toThrow("no such user or named directory: nobody");
  });

  it("asks the dynamic hook for ~[...]", () => {
    const env = { ...ENV, dynamicDirs: (n: string) => (n === "g" ? "/git" : null) };
    expect(g("~[g]/src", env)).toBe("/git/src");
    expect(() => g("~[nope]", env)).toThrow("no directory expansion: ~[nope]");
  });

  it("stops the form at a slash or a qualifier, and nowhere else", () => {
    expect(g("~+(.)")).toBe("/tmp/zgt/c(.)");
    // Not a form at all: `~=` is left alone, and `~` elsewhere is the
    // exclusion operator, which this stage must not touch.
    expect(g("~=")).toBe("~=");
    expect(g("*.c~*test*")).toBe("*.c~*test*");
    expect(g("a=b")).toBe("a=b");
  });

  it("expands = to the command it names", () => {
    const env = { ...ENV, commandPath: (n: string) => (n === "ls" ? "/bin/ls" : null) };
    expect(g("=ls", env)).toBe("/bin/ls");
    expect(() => g("=nosuchcmd", env)).toThrow("nosuchcmd not found");
    // The whole word is the command name: a slash does not end it.
    expect(() => g("=ls/x", env)).toThrow("ls/x not found");
    expect(() => g("==", env)).toThrow("= not found");
  });

  it("leaves = alone under NO_EQUALS, and for =(...)", () => {
    const env = { ...ENV, commandPath: () => "/bin/ls" };
    expect(g("=ls", env, { equals: false })).toBe("=ls");
    // `=(...)` is process substitution, which this is not.
    expect(g("=(foo)", env)).toBe("=(foo)");
  });

  // Every one of these is a NOMATCH report; without it the word stands.
  it("leaves the word alone instead of reporting under NO_NOMATCH", () => {
    expect(g("~nobody", ENV, { noMatch: false })).toBe("~nobody");
    expect(g("~2", ENV, { noMatch: false })).toBe("~2");
    expect(g("=nosuchcmd", ENV, { noMatch: false })).toBe("=nosuchcmd");
  });

  it("reports as an expansion fault, with zsh's wording and nothing else", () => {
    try {
      g("~nobody");
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(ZshPatternError);
      expect((err as ZshPatternError).kind).toBe("expansion");
      expect((err as ZshPatternError).message).toBe("no such user or named directory: nobody");
    }
  });
});

describe("filename expansion reaching the globber", () => {
  let tree: string;
  beforeAll(() => {
    tree = mkdtempSync(join(tmpdir(), "zsh-fsub-"));
    mkdirSync(join(tree, "src"));
    writeFileSync(join(tree, "src", "a.ts"), "");
    writeFileSync(join(tree, "src", "b.ts"), "");
  });
  afterAll(() => rmSync(tree, { recursive: true, force: true }));

  it("globs what the tilde expanded to", () => {
    const home = asPattern(tree);
    expect(globSync("~/src/*.ts", { fileExpansion: { home } })).toEqual([
      `${home}/src/a.ts`,
      `${home}/src/b.ts`,
    ]);
    // A qualifier still ends the form and is still applied.
    expect(globSync("~/src/*(.)", { fileExpansion: { home } })).toEqual([
      `${home}/src/a.ts`,
      `${home}/src/b.ts`,
    ]);
  });

  it("leaves the word alone unless asked", () => {
    expect(globSync("~/src/*.ts", { nullGlob: true })).toEqual([]);
  });

  // The word-level API does it by default, as the shell does.
  it("expands braces then tildes, in that order, for a whole word", () => {
    const home = asPattern(tree);
    expect(
      expandWordsSync(["~/src/{a,b}.ts"], { fileExpansion: { home } }),
    ).toEqual([`${home}/src/a.ts`, `${home}/src/b.ts`]);
  });
});

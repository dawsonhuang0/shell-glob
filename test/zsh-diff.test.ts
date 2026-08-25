import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { globSync } from "../src/index.js";

/**
 * Differential test: every pattern is expanded by the real zsh and by this
 * package, and the two lists must agree.  Skipped where zsh is not installed.
 */
/**
 * Prefer the zsh built from the source in ./zsh, which is what this package was
 * ported from; fall back to whatever zsh is on PATH.
 */
const ZSH = (() => {
  const built = fileURLToPath(new URL("../zsh/Src/zsh", import.meta.url));
  for (const candidate of [built, "zsh"]) {
    try {
      execFileSync(candidate, ["--version"], { stdio: "pipe" });
      return candidate;
    } catch {
      // try the next one
    }
  }
  return null;
})();
const zshAvailable = ZSH !== null;

let tree: string;

beforeAll(() => {
  if (!zshAvailable) return;
  tree = mkdtempSync(join(tmpdir(), "zsh-glob-"));
  for (const dir of ["dir1", "dir2", "dir3", "dir3/subdir", "dir4"]) {
    mkdirSync(join(tree, dir));
  }
  const files = [
    "a", "b", "c", ".hidden", "big.txt", "lex.c", "lex.h", "parse.c", "README",
    "dir1/a", "dir1/b", "dir1/c", "dir2/a", "dir2/b", "dir3/z.txt",
    "dir3/subdir/x.txt", "dir3/subdir/y.md", "file10", "file2", "file1",
  ];
  for (const [i, file] of files.entries()) {
    writeFileSync(join(tree, file), "x".repeat(i));
  }
  symlinkSync("dir1", join(tree, "linkdir"));
  symlinkSync("nowhere", join(tree, "broken"));
});

afterAll(() => {
  if (tree) rmSync(tree, { recursive: true, force: true });
});

function zshGlob(pattern: string): string[] {
  const out = execFileSync(
    ZSH!,
    ["-fc", `setopt extendedglob nullglob; cd -- "$1"; print -rl -- ${pattern}`, "zsh", tree],
    { encoding: "utf8" },
  );
  return out.split("\n").filter((line) => line.length > 0);
}

const patterns = [
  "*",
  "*.txt",
  "*.[ch]",
  "?",
  "[a-c]",
  "dir<1-3>",
  "dir*/[ab]",
  "dir*/*",
  "**/*.txt",
  "**/*",
  "***/*.txt",
  "(dir*/)#*.txt",
  "(dir*/)##*.txt",
  "*~dir*",
  "*~*.txt~*.c",
  "^dir*",
  "^*.txt",
  "*.*~(lex|parse).[ch]",
  "dir3/**/*",
  ".*",
  "*(D)",
  "*(D.)",
  "*(/)",
  "*(.)",
  "*(@)",
  "*(-@)",
  "*(/^F)",
  "*(*)",
  "*(#q.)",
  "*(.N)",
  "*(L+5)",
  "*(L-5)",
  "*(.on)",
  "*(.On)",
  "*(.oL)",
  "*(.OL)",
  "*(.oL[1,2])",
  "*(.[1,3])",
  "*(.[-1])",
  "*(:t)",
  "*(.:r)",
  "**/*.txt(:t)",
  "dir1/*(:h)",
  "*(.:s/a/A/)",
  "*(M)",
  "*(/M)",
  "*(T)",
  "*(.P:-f:)",
  "*(nOn)",
  "file<->",
  "file<2-10>",
  "(#i)README",
  "(#i)*.TXT",
  "*(#q/)",
  "dir[12]/(a|b)",
  "d*/**/*.txt",
  "**.txt",
  "*/",
  "dir*/",
  "(*/)#",
  "(*/)##",
  "**/",
  "dir3/**/",
  "*(:h)",
  "**/*(:h2)",
  "**/*(:t2)",
  "*/a",
  "**/*.txt~dir3/*",
  "***/x.txt",
  "*(.oL)",
  "*(.om)",
  "**/*(odon)",
  "**/*.txt~*subdir*(:t)",
  "*(.mh-2)",
  "*(.mh+2)",
  "*(.md-1)",
  "*(f644)",
  "*(.f644:t)",
  "**/*(Odon)",
];

describe.skipIf(!zshAvailable)("matches real zsh", () => {
  for (const pattern of patterns) {
    it(`expands ${pattern}`, () => {
      const expected = zshGlob(pattern);
      const actual = globSync(pattern, { cwd: tree, extendedGlob: true, nullGlob: true });
      expect(actual).toEqual(expected);
    });
  }
});

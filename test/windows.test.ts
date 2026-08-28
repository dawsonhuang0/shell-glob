import { describe, expect, it } from "vitest";
import { globSync, type GlobDirent, type SyncFsAdapter } from "../src/index.js";

/**
 * Windows path conventions.
 *
 * A pattern always separates its components with `/`, here as everywhere
 * else: `\` is the escape character, so `C:\temp\*.txt` would read `\*` as a
 * literal asterisk rather than as a separator and a star. What varies is the
 * filesystem either side of the pattern -- the `cwd` handed in and the
 * absolute paths handed back -- and on Windows that means drive letters and
 * UNC shares.
 *
 * These run against a filesystem of their own, since the tests themselves run
 * on whatever host happens to be to hand.
 */
type Tree = Record<string, Record<string, "dir" | "file">>;

const TREE: Tree = {
  "C:/": { proj: "dir", Windows: "dir" },
  "C:/proj": { src: "dir", "A.TXT": "file", "b.txt": "file" },
  "C:/proj/src": { "i.ts": "file" },
  "//srv/share": { "f.txt": "file" },
};

/** Answers to either separator, and with or without a trailing slash. */
function windowsFs(tree: Tree, log?: string[]): SyncFsAdapter {
  const dirent = (name: string, kind: "dir" | "file"): GlobDirent => ({
    name,
    isDirectory: () => kind === "dir",
    isSymbolicLink: () => false,
  });
  return {
    readdir(path) {
      log?.push(path);
      const key = path.replace(/\\/g, "/");
      const dir = tree[key] ?? tree[key.replace(/\/+$/, "")];
      return dir ? Object.entries(dir).map(([n, k]) => dirent(n, k)) : null;
    },
    lstat: () => null,
    stat: () => null,
  };
}

const run = (pattern: string, extra: Record<string, unknown> = {}) =>
  globSync(pattern, {
    cwd: "C:\\proj",
    fs: windowsFs(TREE),
    windowsPaths: true,
    nullGlob: true,
    ...extra,
  });

describe("Windows paths", () => {
  it("takes a cwd written with backslashes", () => {
    expect(run("*.txt")).toEqual(["b.txt"]);
    expect(run("src/*.ts")).toEqual(["src/i.ts"]);
    expect(run("*.txt", { cwd: "C:/proj" })).toEqual(["b.txt"]);
  });

  it("reads a drive letter as the start of an absolute path", () => {
    // Without this the drive is taken for a directory name and joined onto
    // the cwd, which is how `C:/proj/*.txt` came to look in `C:/proj/C:/proj`.
    expect(run("C:/proj/*.txt")).toEqual(["C:/proj/b.txt"]);
    expect(run("C:/proj/src/*.ts")).toEqual(["C:/proj/src/i.ts"]);
  });

  it("reads the drive root, whose trailing slash is part of it", () => {
    // `C:/` must not be trimmed to `C:`, which names the working directory of
    // drive C rather than its root -- the same reason `/` is left alone.
    expect(run("C:/*").sort()).toEqual(["C:/Windows", "C:/proj"]);
    expect(run("C:/")).toEqual(["C:/"]);
  });

  it("reads a UNC share", () => {
    expect(run("//srv/share/*.txt")).toEqual(["//srv/share/f.txt"]);
    expect(run("*.txt", { cwd: "\\\\srv\\share" })).toEqual(["f.txt"]);
  });

  it("hands back paths spelled the way the pattern was", () => {
    // One spelling, so a result reads like the pattern that produced it and
    // two paths for one file compare equal.
    const log: string[] = [];
    const out = globSync("src/*.ts", {
      cwd: "C:\\proj",
      fs: windowsFs(TREE, log),
      windowsPaths: true,
      absolute: true,
    });
    expect(out).toEqual(["C:/proj/src/i.ts"]);
    expect(log.every((p) => !p.includes("\\"))).toBe(true);
  });

  it("leaves `C:` alone where the host is not Windows", () => {
    // A directory really called `C:` is an ordinary name on a Unix host, so
    // the rule is not applied there.
    const unix: Tree = { "/w": { "C:": "dir" }, "/w/C:": { "f.txt": "file" } };
    const opts = { cwd: "/w", fs: windowsFs(unix), nullGlob: true };
    expect(globSync("C:/*.txt", { ...opts, windowsPaths: false })).toEqual(["C:/f.txt"]);
  });

  it("matches case the way the pattern spells it, whatever the volume does", () => {
    // zsh compares against the names `readdir` returns, so a case-insensitive
    // filesystem does not make globbing case-insensitive.  Checked against
    // the real zsh on a case-insensitive volume.
    expect(run("*.txt")).toEqual(["b.txt"]);
    expect(run("*.TXT")).toEqual(["A.TXT"]);
    expect(run("*.txt", { caseGlob: false }).sort()).toEqual(["A.TXT", "b.txt"]);
  });

  it("keeps `\\` as the escape character in a pattern", () => {
    // Which is why a pattern cannot use it as a separator.
    const t: Tree = { "C:/proj": { "a*b": "file", axb: "file" } };
    const o = { cwd: "C:/proj", fs: windowsFs(t), windowsPaths: true, nullGlob: true };
    expect(globSync("a\\*b", o)).toEqual(["a*b"]);
    expect(globSync("a*b", o).sort()).toEqual(["a*b", "axb"]);
  });
});

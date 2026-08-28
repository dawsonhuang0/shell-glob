import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Whether this host lets an unprivileged process create a symbolic link.
 *
 * Windows does not, unless Developer Mode is on or the process is elevated,
 * and it reports that as `EPERM` from `symlink` itself rather than as
 * something you can ask about in advance.  So this asks by trying once.
 *
 * The tests that need a link in the tree are skipped where it comes back
 * false, which is the same thing `harvested-globs.test.ts` already does for a
 * host without `mkfifo`: a platform missing a feature should say so, not fail
 * as though the code were wrong.
 */
export const canSymlink: boolean = (() => {
  // So that the without-symlinks path can be exercised on a host that does
  // have them, which is the only way to check it from a Unix machine.
  if (typeof process !== "undefined" && process.env.ZG_NO_SYMLINK) return false;
  let dir: string | null = null;
  try {
    dir = mkdtempSync(join(tmpdir(), "zg-symlink-probe-"));
    symlinkSync("target", join(dir, "link"));
    return true;
  } catch {
    return false;
  } finally {
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
})();

/**
 * Creates a symbolic link where the host allows one, and reports whether it
 * did.  A caller that only wants the link present may ignore the answer; one
 * that asserts on it should be skipped by `canSymlink`.
 */
export function trySymlink(target: string, path: string): boolean {
  if (!canSymlink) return false;
  try {
    symlinkSync(target, path);
    return true;
  } catch {
    return false;
  }
}

/**
 * A host path written the way a *pattern* has to spell it.
 *
 * `mkdtempSync` hands back a native path, and on Windows that means
 * backslashes -- which are escapes in a pattern, not separators.  A test that
 * builds a pattern or an expected result from one has to convert it, exactly
 * as a caller would.
 */
export function asPattern(path: string): string {
  return path.replace(/\\/g, "/");
}

/** True where the host has Unix user and group ids at all. */
export const hasUnixIds: boolean = typeof process !== "undefined" && typeof process.getuid === "function";

/**
 * Whether this host can create a named pipe.
 *
 * Windows has no `mkfifo`, so a tree built there is missing the FIFO the
 * recorded expectations were captured from.  This is probed when the module
 * loads rather than while building the tree, because `it.skipIf` is evaluated
 * as a file is collected -- before any `beforeAll` has run.
 */
export const canFifo: boolean = (() => {
  if (typeof process !== "undefined" && process.env.ZG_NO_FIFO) return false;
  let dir: string | null = null;
  try {
    dir = mkdtempSync(join(tmpdir(), "zg-fifo-probe-"));
    execFileSync("mkfifo", [join(dir, "fifo")], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  } finally {
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
})();

/**
 * Whether this host allows a filename containing `*`.
 *
 * Windows reserves `< > : " | ? *` in a path component and refuses them from
 * `open` itself, so the tests for escaping a literal `*` in a pattern have
 * nothing to match there.  Every other name the suite builds is legal on both.
 */
export const canOddFilenames: boolean = (() => {
  if (typeof process !== "undefined" && process.env.ZG_NO_ODD_NAMES) return false;
  let dir: string | null = null;
  try {
    dir = mkdtempSync(join(tmpdir(), "zg-oddname-probe-"));
    writeFileSync(join(dir, "star*name"), "");
    return true;
  } catch {
    return false;
  } finally {
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
})();

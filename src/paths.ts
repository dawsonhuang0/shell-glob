import * as nodePath from "node:path";

/**
 * The one place this package knows about the host's path conventions.
 *
 * A glob pattern always separates its components with `/`, on every platform.
 * It has to: `\` is the escape character, so `C:\temp\*.txt` would read the
 * `\*` as a literal asterisk rather than as a separator and a star. zsh
 * settles it the same way, and so does every other glob library.
 *
 * What does vary is the filesystem either side of the pattern -- the `cwd`
 * handed to the globber, and the absolute paths it returns. Those are the
 * host's, and on Windows that means drive letters and UNC shares.
 *
 * Only `isAbsolute` is taken from `node:path`. Nothing here joins or
 * normalises through it: `join` and `normalize` collapse `a//b` to `a/b` and
 * resolve `a/../b` to `b`, and this package must do neither. An empty path
 * component is a real component in zsh -- `sub//x` keeps its run -- and `..`
 * is an ordinary directory entry to be matched, not an instruction.
 */

/** Windows path rules, which are the default only on Windows. */
export function windowsPathsByDefault(): boolean {
  return typeof process !== "undefined" && process.platform === "win32";
}

/**
 * Is this an absolute path?  Exactly what `path.win32` or `path.posix` says,
 * so `C:/foo`, `C:\foo`, `\\server\share` and `\foo` are absolute on Windows
 * while `C:foo` -- relative to the working directory of drive C -- is not.
 */
export function isAbsolutePath(path: string, windows: boolean): boolean {
  return (windows ? nodePath.win32 : nodePath.posix).isAbsolute(path);
}

/**
 * The part of a path that roots it, and so cannot be trimmed away: `/`, or on
 * Windows a drive (`C:/`) or a UNC share (`//server/share/`).  Empty for a
 * relative path.
 *
 * Everything here is fed `toPosix` output, so only the forward slash spelling
 * has to be recognised.
 */
export function pathRoot(path: string, windows: boolean): string {
  return (windows ? nodePath.win32 : nodePath.posix).parse(path).root;
}

/**
 * A path with `\` written as `/`.
 *
 * Windows accepts either separator, so this changes nothing about which file
 * is meant; it keeps one spelling in play, so that a result reads the way the
 * pattern that produced it does, and two paths for one file compare equal.
 */
export function toPosix(path: string): string {
  return path.includes("\\") ? path.replace(/\\/g, "/") : path;
}

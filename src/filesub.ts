import * as nodeFs from "node:fs";
import { ZshPatternError } from "./errors.js";
import type { ZshOptions } from "./options.js";

/**
 * Filename expansion: the `~` and `=` forms, following `filesubstr` and
 * `equalsubstr` in `Src/subst.c`.
 *
 * This is the stage between brace expansion and globbing, and unlike either of
 * them it needs to know things about the world outside the word -- a home
 * directory, a directory stack, where a command lives.  Everything it needs is
 * supplied rather than discovered, so the result stays a pure function of its
 * inputs and a virtual filesystem can be tested against.  The defaults come
 * from the process only when nothing was passed.
 *
 * Only a `~` or `=` at the very start of a word is a candidate, which is what
 * keeps `*.c~*test*` an exclusion and `a=b` an ordinary word.
 */

/** What the outside world has to say, for the forms that need to ask. */
export interface FileExpansionEnv {
  /** `~`; the process's home directory when not given. */
  home?: string;
  /** `~+`, and `~0`.  The globber's `cwd` when not given. */
  cwd?: string;
  /** `~-`; `$OLDPWD` when not given, and `cwd` when there is no such thing. */
  oldpwd?: string;
  /**
   * `~1`, `~+1`, `~-1`: the directory stack, most recent first, as `$dirstack`
   * holds it.  The current directory is not part of it, being `~0`.
   */
  dirStack?: string[];
  /** `PUSHD_MINUS`: swap what `~+n` and `~-n` count from. */
  pushdMinus?: boolean;
  /** `~name`: a named directory, or a user's home.  Nothing resolves without it. */
  namedDirs?: (name: string) => string | null | undefined;
  /** `~[name]`: what the `zsh_directory_name` hook would answer. */
  dynamicDirs?: (name: string) => string | null | undefined;
  /** `=name`: where a command lives.  A `PATH` search when not given. */
  commandPath?: (name: string) => string | null | undefined;
}

/**
 * `isend`: what may follow the `~` form and still leave it one.  The `(` is
 * there for a glob qualifier, so `~/src/*(.)` expands and then globs.
 *
 * zsh also ends the form at `:` while expanding the right hand side of an
 * assignment; there are no assignments here, so that case cannot arise.
 */
function isEnd(ch: string | undefined): boolean {
  return ch === undefined || ch === "/" || ch === "(";
}

const isDigit = (ch: string | undefined): boolean => ch !== undefined && ch >= "0" && ch <= "9";

/** `IUSER`: the characters a user or named directory may be spelled with. */
function userEnd(word: string, from: number): number {
  let i = from;
  while (i < word.length && /[A-Za-z0-9_.-]/.test(word[i])) i++;
  return i;
}

function fail(detail: string, word: string, opts: ZshOptions): never | undefined {
  // Every one of these is reported only under NOMATCH; without it the word is
  // simply left as it stands.
  if (!opts.noMatch) return undefined;
  throw new ZshPatternError(detail, word, 0, "expansion");
}

/**
 * `dstackent`: an entry of the directory stack, counted from whichever end
 * `ch` names.  `~0` is the current directory and is not on the stack, so the
 * numbering from the near end is one ahead of the array.
 */
function stackEntry(
  ch: string,
  val: number,
  env: FileExpansionEnv,
  cwd: string,
  word: string,
  opts: ZshOptions,
): string | undefined {
  const stack = env.dirStack ?? [];
  const backwards = ch === (env.pushdMinus ? "+" : "-");
  if (!backwards) {
    if (val === 0) return cwd;
    const entry = stack[val - 1];
    if (entry !== undefined) return entry;
  } else {
    const index = stack.length - 1 - val;
    if (index >= 0) return stack[index];
    // Counting back exactly past the oldest entry lands on the current
    // directory; further than that is an error.
    if (index === -1) return cwd;
  }
  return fail("not enough directory stack entries.", word, opts);
}

/**
 * A `PATH` search, used when nothing better was supplied.  Exported because
 * the `:c` modifier is the same lookup: zsh calls `equalsubstr` for both.
 */
export function defaultCommandPath(name: string): string | null {
  const runnable = (path: string): boolean => {
    try {
      const st = nodeFs.statSync(path);
      return st.isFile() && (st.mode & 0o111) !== 0;
    } catch {
      return false;
    }
  };
  // A name with a slash in it names one place and is not searched for.  It is
  // still checked: `=ls/x` is an error, not the word `ls/x`.
  if (name.includes("/")) return runnable(name) ? name : null;
  const path = typeof process !== "undefined" ? process.env.PATH : undefined;
  if (!path) return null;
  for (const dir of path.split(":")) {
    const full = (dir === "" ? "." : dir) + "/" + name;
    if (runnable(full)) return full;
  }
  return null;
}

/**
 * Expands the `~` or `=` at the head of a word, or returns it unchanged.
 *
 * Nothing here touches the rest of the word: what comes after the form is
 * carried across as it stands, so a pattern keeps its operators and is
 * compiled afterwards exactly as it would have been.
 */
export function expandFilename(word: string, opts: ZshOptions, env: FileExpansionEnv = {}): string {
  const cwd = env.cwd ?? ".";

  if (word[0] === "=") {
    // `=(...)` is process substitution, which is not this.
    if (!opts.equals || word.length < 2 || word[1] === "(") return word;
    const end = word.indexOf("(") < 0 ? word.length : word.indexOf("(");
    const name = word.slice(1, end);
    const found = (env.commandPath ?? defaultCommandPath)(name);
    if (found === null || found === undefined) {
      fail(`${name} not found`, word, opts);
      return word;
    }
    return found + word.slice(end);
  }

  if (word[0] !== "~" || word[1] === "=") return word;

  // `~`, `~+`, `~-`: the three that name a directory outright.
  if (isEnd(word[1])) {
    return (env.home ?? defaultHome()) + word.slice(1);
  }
  if (word[1] === "+" && isEnd(word[2])) return cwd + word.slice(2);
  if (word[1] === "-" && isEnd(word[2])) {
    return (env.oldpwd ?? defaultOldPwd() ?? cwd) + word.slice(2);
  }

  // `~[name]`: whatever the zsh_directory_name hook makes of it.
  if (word[1] === "[") {
    const close = word.indexOf("]", 2);
    if (close >= 0) {
      const name = word.slice(2, close);
      const dir = env.dynamicDirs?.(name);
      if (dir === null || dir === undefined) {
        fail(`no directory expansion: ~[${name}]`, word, opts);
        return word;
      }
      return dir + word.slice(close + 1);
    }
  }

  // `~1`, `~+1`, `~-2`: an entry of the directory stack.  The digits are
  // limited to two, which is what keeps `~123` a name rather than a number.
  let i = 1;
  if (word[i] === "+" || word[i] === "-") i++;
  const digitsFrom = i;
  while (isDigit(word[i])) i++;
  if (
    word[1] !== " " &&
    word[1] !== "\t" &&
    i > digitsFrom &&
    isEnd(word[i]) &&
    (!isDigit(word[1]) || i < 4)
  ) {
    const val = Number(word.slice(digitsFrom, i));
    const entry = stackEntry(word[1] === "-" ? "-" : "+", val, env, cwd, word, opts);
    return entry === undefined ? word : entry + word.slice(i);
  }

  // `~name`: a named directory, or a user.
  const end = userEnd(word, 1);
  if (end > 1 && isEnd(word[end])) {
    const name = word.slice(1, end);
    const dir = env.namedDirs?.(name);
    if (dir === null || dir === undefined) {
      fail(`no such user or named directory: ${name}`, word, opts);
      return word;
    }
    return dir + word.slice(end);
  }

  return word;
}

function defaultHome(): string {
  if (typeof process === "undefined") return "";
  return process.env.HOME ?? "";
}

function defaultOldPwd(): string | undefined {
  if (typeof process === "undefined") return undefined;
  return process.env.OLDPWD;
}

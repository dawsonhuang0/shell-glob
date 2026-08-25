/**
 * Shell options that affect pattern matching and filename generation.
 *
 * The defaults mirror a bare `zsh -f`: `EXTENDED_GLOB` and `KSH_GLOB` are off,
 * `BARE_GLOB_QUAL`, `CASE_GLOB`, `NOMATCH` and `MULTIBYTE` are on.  Most people
 * porting a zsh pattern want `{ extendedGlob: true }`.
 */
export interface ZshOptions {
  /** `GLOB`: perform filename generation at all. Unset leaves the word alone. */
  glob: boolean;
  /** `EXTENDED_GLOB`: enable `^`, `~`, `#`, `##` and the `(#...)` flag syntax. */
  extendedGlob: boolean;
  /** `KSH_GLOB`: enable `@(...)`, `*(...)`, `+(...)`, `?(...)`, `!(...)`. */
  kshGlob: boolean;
  /** `SH_GLOB`: bare parentheses are not grouping operators (`<x-y>` is off too). */
  shGlob: boolean;
  /** `GLOB_DOTS`: a leading `.` no longer has to be matched explicitly. */
  globDots: boolean;
  /** `NULL_GLOB`: a pattern with no matches expands to nothing instead of erroring. */
  nullGlob: boolean;
  /** `NOMATCH`: error when a pattern has no matches (ignored if `nullGlob`). */
  noMatch: boolean;
  /** `CASE_GLOB`: when off, filename generation is case insensitive. */
  caseGlob: boolean;
  /**
   * `CASE_PATHS`: with `caseGlob` off, restrict the case insensitivity to the
   * path components that actually contain globbing characters, leaving plain
   * components case sensitive.  Has no effect on a case insensitive
   * filesystem, exactly as in zsh.
   */
  casePaths: boolean;
  /**
   * `CSH_NULL_GLOB`: a pattern with no matches is removed rather than being an
   * error, overriding `noMatch`.  In the shell it is an error only when every
   * pattern in the command failed; that is a whole-command judgement, so a
   * single expansion here just returns nothing and the caller decides.
   */
  cshNullGlob: boolean;
  /** `NUMERIC_GLOB_SORT`: sort names with embedded numbers numerically. */
  numericGlobSort: boolean;
  /** `GLOB_STAR_SHORT`: `**.c` means `**\/*.c`. */
  globStarShort: boolean;
  /** `MARK_DIRS`: append a trailing `/` to directories produced by globbing. */
  markDirs: boolean;
  /** `LIST_TYPES`-style marks, used by the `T` glob qualifier. */
  listTypes: boolean;
  /** `BARE_GLOB_QUAL`: a trailing `(...)` is a list of glob qualifiers. */
  bareGlobQual: boolean;
  /** `BAD_PATTERN`: error on a malformed pattern instead of treating it literally. */
  badPattern: boolean;
  /** `MULTIBYTE`: `?` and friends match whole code points rather than code units. */
  multibyte: boolean;
  /** `POSIX_IDENTIFIERS`: `[:IDENT:]` covers only ASCII, not any alphanumeric. */
  posixIdentifiers: boolean;
}

export const defaultOptions: ZshOptions = {
  glob: true,
  extendedGlob: false,
  kshGlob: false,
  shGlob: false,
  globDots: false,
  nullGlob: false,
  noMatch: true,
  caseGlob: true,
  casePaths: false,
  cshNullGlob: false,
  numericGlobSort: false,
  globStarShort: false,
  markDirs: false,
  listTypes: false,
  bareGlobQual: true,
  badPattern: true,
  multibyte: true,
  posixIdentifiers: false,
};

export type ZshOptionsInput = Partial<ZshOptions>;

export function resolveOptions(opts?: ZshOptionsInput): ZshOptions {
  return opts ? { ...defaultOptions, ...opts } : defaultOptions;
}

/**
 * Per-pattern globbing flags, set with `(#i)`, `(#l)`, `(#b)` and so on.
 * They are lexically scoped: a flag applies to the text on its right up to the
 * end of the enclosing group, exactly as zsh scopes them.
 */
export interface GlobFlags {
  /** `(#i)` case insensitive, `(#I)` turns it back off. */
  ignoreCase: boolean;
  /** `(#l)`: lower case in the pattern matches either case in the string. */
  lcMatchUc: boolean;
  /** `(#b)`: parenthesised groups are recorded as backreferences. */
  backref: boolean;
  /** `(#m)`: record the whole matched string as `MATCH`/`MBEGIN`/`MEND`. */
  matchRef: boolean;
  /** `(#aN)`: the number of errors allowed when matching approximately. */
  approx: number;
}

export const noFlags: GlobFlags = {
  ignoreCase: false,
  lcMatchUc: false,
  backref: false,
  matchRef: false,
  approx: 0,
};

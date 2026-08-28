/**
 * The two errors filename generation can raise, worded exactly as zsh words
 * them.  `message` is the text zsh prints after its `zsh:LINE:` prefix and
 * nothing else; what this package worked out about the fault is in `detail`.
 *
 * Every one of these exits the shell with status 1: `zerr()` sets `errflag`,
 * and `execlist` turns that into `lastval = 1` unless a status was set
 * already.  There is no glob error with a status of its own.
 */

/**
 * Thrown for a malformed word.
 *
 * zsh reports a pattern it cannot compile as `bad pattern: <word>` and says no
 * more; a glob qualifier gets a message of its own, such as
 * `unknown file attribute: z`.
 */
export class ZshPatternError extends Error {
  /** The whole word, as zsh prints it -- quoting removed. */
  readonly pattern: string;
  /** Where in it the fault was found. */
  readonly position: number;
  /**
   * Which half of the word was at fault.  zsh parses the glob qualifiers
   * first and reports their errors there and then; only a failure to compile
   * the pattern itself reaches the `BAD_PATTERN` test, which is why `*(z)` is
   * an error even with the option unset while `*(` is not.
   *
   * `unsupported` is not zsh's: it marks the few things this package will not
   * do, such as running the shell code an `e` qualifier holds.  zsh would
   * simply run it, so there is no message of its own to copy.
   */
  readonly kind: "pattern" | "qualifier" | "unsupported" | "expansion";
  /**
   * What was actually wrong -- `unmatched '['`, and so on.  zsh does not print
   * this, so it is kept apart from `message` rather than folded into it.
   */
  readonly detail: string;

  constructor(
    detail: string,
    pattern: string,
    position: number,
    kind: "pattern" | "qualifier" | "unsupported" | "expansion" = "pattern",
  ) {
    // A qualifier names its own fault; a pattern is only ever reported as
    // being a bad one.  An `unsupported` fault is this package's own and has
    // no zsh wording to borrow, so it says what it means.
    super(kind === "pattern" ? `bad pattern: ${pattern}` : detail);
    this.name = "ZshPatternError";
    this.pattern = pattern;
    this.position = position;
    this.kind = kind;
    this.detail = detail;
  }

  /**
   * The same fault reported against the whole word.  A pattern is compiled one
   * path component at a time, but zsh names the word it came from.
   */
  withWord(word: string): ZshPatternError {
    if (this.kind === "qualifier" || word === this.pattern) return this;
    return new ZshPatternError(this.detail, word, this.position, this.kind);
  }
}

/**
 * Thrown when a word matched nothing and neither `nullGlob` nor
 * `noMatch: false` applies.
 *
 * `NOMATCH` names the word; `CSH_NULL_GLOB`, which judges a whole command,
 * says only `no match`.
 */
export class NoMatchError extends Error {
  readonly pattern: string;

  constructor(pattern: string, { whole = false } = {}) {
    super(whole ? "no match" : `no matches found: ${pattern}`);
    this.name = "NoMatchError";
    this.pattern = pattern;
  }
}

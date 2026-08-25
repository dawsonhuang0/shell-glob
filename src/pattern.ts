import type { Node, ParsedPattern } from "./ast.js";
import {
  defaultSettings,
  Matcher,
  unitsSlice,
  type MatchResult,
  type MatchSettings,
  type Units,
} from "./matcher.js";
import { resolveOptions, type ZshOptions, type ZshOptionsInput } from "./options.js";
import { parsePattern } from "./parser.js";

/** A successful match, with the same information zsh exposes via `(#b)`/`(#m)`. */
export interface PatternMatch {
  /** The matched text. */
  match: string;
  /** Zero-based index of the first matched character. */
  index: number;
  /** Zero-based index just past the last matched character. */
  endIndex: number;
  /** `$match`: the text captured by each `(#b)` group, `""` if it did not match. */
  groups: string[];
  /** `$mbegin`: one-based start index of each group, `-1` if it did not match. */
  mbegin: number[];
  /** `$mend`: one-based end index of each group, `-1` if it did not match. */
  mend: number[];
  /** Errors consumed by approximate matching, if `(#a)` was used. */
  errors: number;
}

export interface PatternSettings {
  /** Value of `IFS`, used by `[[:IFS:]]`. Defaults to `" \t\n\0"`. */
  ifs?: string;
  /** Value of `WORDCHARS`, used by `[[:WORD:]]`. */
  wordChars?: string;
  /** File globbing: a leading `.` must be matched explicitly. Set by the globber. */
  noLeadingDot?: boolean;
  /**
   * Match without regard to case.  `CASE_GLOB` is a filename generation
   * option, so the globber sets this per segment; it does not apply to
   * `[[ str = pat ]]`, where zsh stays case sensitive whatever `CASE_GLOB` is.
   */
  ignoreCase?: boolean;
  /**
   * More of the word follows this pattern, as it does for every path component
   * but the last.  zsh leaves the globbing flags at the very end of a pattern
   * "for the next Patprog in the chain to pick up", so where nothing follows
   * they never take effect: `??(#a1)` does not match `sub`, while
   * `??(#a1)/x` matches `sub/x`.  Set by the globber.
   */
  moreFollows?: boolean;
  /**
   * Skip the native shortcuts for the shapes that reduce to one string
   * operation, and answer everything through the matcher.
   *
   * They are meant to be indistinguishable, and `test/fast-path.test.ts`
   * checks that over the whole corpus -- but they are the one place where
   * speed could cost an answer, so there is a way to turn them off.
   */
  noFastPath?: boolean;
  /**
   * Length of a header group prepended to the pattern -- one the globber
   * peeled off the front of the word and put back on each component.  `patstart`
   * really points just past it, so the group after it is the one zsh folds
   * into the header rather than emitting.
   */
  headerPrefix?: number;
}

/**
 * A compiled zsh pattern.
 *
 * ```ts
 * const p = compile("(#b)(*).c", { extendedGlob: true });
 * p.exec("readme.c")?.groups; // ["readme"]
 * ```
 */
export class ZshPattern {
  readonly source: string;
  readonly options: ZshOptions;
  /** Text of a trailing `(#q...)` glob qualifier, ignored when matching. */
  readonly qualifiers: string | null;
  /**
   * The pattern compiled to no nodes, so zsh holds it as an empty string and
   * compares it as one -- `(#a1)` matches only `""`.
   */
  readonly isPureEmpty: boolean;

  private readonly parsed: ParsedPattern;
  private readonly settings: MatchSettings;

  constructor(source: string, options?: ZshOptionsInput, settings: PatternSettings = {}) {
    this.source = source;
    this.options = resolveOptions(options);
    this.parsed = compileSource(
      source,
      this.options,
      settings.moreFollows ?? false,
      settings.headerPrefix ?? 0,
    );
    this.qualifiers = this.parsed.qualifiers;
    this.isPureEmpty = this.parsed.pureEmpty;
    this.settings = {
      ...defaultSettings,
      multibyte: this.options.multibyte,
      ignoreCase: settings.ignoreCase ?? false,
      noLeadingDot: settings.noLeadingDot ?? false,
      ifs: settings.ifs ?? defaultSettings.ifs,
      wordChars: settings.wordChars ?? defaultSettings.wordChars,
      posixIdentifiers: this.options.posixIdentifiers,
    };
    this.shared = new Matcher(this.parsed, this.settings);
    this.fastTest = settings.noFastPath ? null : buildFastTest(this.parsed, this.settings);
  }

  /**
   * A native check for the shapes that dominate real use -- a plain word,
   * `*suffix`, `prefix*`, `*inner*` -- which JavaScript answers with one string
   * operation instead of a walk through the matcher.  Null when the pattern is
   * anything else.
   */
  private readonly fastTest: ((str: string) => boolean | null) | null;

  /**
   * One matcher per compiled pattern.  It carries per-match state, which
   * `match` resets, so reusing it saves an allocation on every test; it is not
   * re-entrant, which matters only if a replacement callback re-enters the
   * same compiled pattern.
   */
  private readonly shared: Matcher;

  private matcher(): Matcher {
    return this.shared;
  }

  /** Does the pattern match the whole string, as in `[[ str = pat ]]`? */
  test(str: string): boolean {
    if (this.fastTest !== null) {
      const quick = this.fastTest(str);
      if (quick !== null) return quick;
    }
    return this.matcher().match(str) !== null;
  }

  /** Match the whole string and report the captured groups. */
  exec(str: string): PatternMatch | null {
    const m = this.matcher();
    const res = m.match(str);
    return res && buildMatch(m.split(str), res);
  }

  /**
   * Match a prefix of the string, as in `${str#pat}` (shortest) and
   * `${str##pat}` (longest).  Returns the index just past the match.
   */
  matchStart(str: string, { longest = false } = {}): number | null {
    const m = this.matcher();
    const chars = m.split(str);
    // Try prefixes shortest first, or longest first for the `##` form.
    for (let i = 0; i <= chars.length; i++) {
      const to = longest ? chars.length - i : i;
      if (m.match(chars, { to })) return to;
    }
    return null;
  }

  /**
   * Match a suffix of the string, as in `${str%pat}` (shortest) and
   * `${str%%pat}` (longest).  Returns the index where the match starts.
   */
  matchEnd(str: string, { longest = false } = {}): number | null {
    const m = this.matcher();
    const chars = m.split(str);
    const starts = longest
      ? Array.from({ length: chars.length + 1 }, (_, i) => i)
      : Array.from({ length: chars.length + 1 }, (_, i) => chars.length - i);
    for (const start of starts) {
      if (m.match(chars, { from: start })) return start;
    }
    return null;
  }

  /** Leftmost, longest match anywhere in the string, as used by `${str/pat/repl}`. */
  search(str: string): PatternMatch | null {
    const m = this.matcher();
    const res = m.search(str);
    return res && buildMatch(m.split(str), res);
  }

  /** Replace the first match, or every match with `{ global: true }`. */
  replace(
    str: string,
    replacement: string | ((m: PatternMatch) => string),
    { global = false } = {},
  ): string {
    const m = this.matcher();
    const chars = m.split(str);
    let out = "";
    let i = 0;
    let lastEnd = -1;
    while (i <= chars.length) {
      const res = m.match(chars, { from: i, anchorEnd: false, longest: true });
      // An empty match directly after a replacement is skipped, so that
      // `${aaa//a#/X}` yields `X` rather than `XX`.
      if (!res || (res.end === i && i === lastEnd)) {
        if (i < chars.length) out += chars[i];
        i++;
        continue;
      }
      const built = buildMatch(chars, res);
      out += typeof replacement === "string" ? replacement : replacement(built);
      if (!global) return out + unitsSlice(chars, res.end, chars.length);
      lastEnd = res.end;
      if (res.end === i) {
        if (i < chars.length) out += chars[i];
        i++;
      } else {
        i = res.end;
      }
    }
    return out;
  }
}

/**
 * Recognises the handful of pattern shapes that reduce to a single string
 * operation.  Anything with flags, approximation, exclusions, alternation or
 * captures is left to the matcher.
 */
function buildFastTest(
  parsed: ParsedPattern,
  settings: MatchSettings,
): ((str: string) => boolean | null) | null {
  // Without MULTIBYTE a unit is a byte, which JavaScript's string operations
  // do not agree with: `*\xa9` matches the second byte of `é`, where
  // `endsWith` sees one character.
  if (!settings.multibyte) return null;
  if (parsed.approx > 0 || parsed.ngroups > 0 || settings.ignoreCase) return null;
  if (parsed.root.branches.length !== 1) return null;
  const [branch] = parsed.root.branches;
  if (branch.excludes.length > 0) return null;

  // Case insensitivity is handled by lowering both sides, which is what
  // `(#i)` and `NO_CASE_GLOB` amount to for a literal run.
  let fold: boolean = settings.ignoreCase;
  const plain = (node: Node): string | null => {
    if (node.kind !== "str") return null;
    const { ignoreCase, lcMatchUc, approx, backref, matchRef } = node.flags;
    if (lcMatchUc || approx > 0 || backref || matchRef) return null;
    if (ignoreCase) fold = true;
    else if (fold) return null; // a mix of folded and exact runs
    return node.text;
  };
  const isStar = (node: Node) => node.kind === "star";
  const seq = branch.seq;

  // Literals and `?` only: the length is fixed, so this is a length check and
  // a character comparison at each literal position.
  if (seq.length > 0 && seq.every((n) => n.kind === "str" || n.kind === "any")) {
    const pieces: { at: number; text: string }[] = [];
    let width = 0;
    let ok = true;
    for (const node of seq) {
      if (node.kind === "any") {
        if (node.flags.approx > 0) {
          ok = false;
          break;
        }
        width += 1;
        continue;
      }
      const text = plain(node);
      if (text === null) {
        ok = false;
        break;
      }
      pieces.push({ at: width, text });
      width += [...text].length;
    }
    if (ok) {
      const parts = fold ? pieces.map((p) => ({ ...p, text: p.text.toLowerCase() })) : pieces;
      const total = width;
      // A `?` is a wildcard, so during filename generation it may not match the
      // leading `.` of a name -- the rule the matcher applies to every wildcard
      // node.  A literal first piece spells the dot out, and is allowed.
      const leadingWild = settings.noLeadingDot && seq[0].kind === "any";
      return (str) => {
        // `?` counts code points, so a string with an astral character cannot
        // be measured by its UTF-16 length: leave those to the matcher.
        if (SURROGATE_PAIR.test(str)) return null;
        if (str.length !== total) return false;
        if (leadingWild && str.startsWith(".")) return false;
        const subject = fold ? str.toLowerCase() : str;
        for (const part of parts) {
          if (!subject.startsWith(part.text, part.at)) return false;
        }
        return true;
      };
    }
  }

  // A leading `.` has to be matched explicitly during filename generation, so
  // a shape that *starts* with `*` must refuse one.  A shape starting with a
  // literal is fine: `.=*` matches `.=foo`, because the dot is spelled out.
  const dotOk = settings.noLeadingDot
    ? (str: string) => !str.startsWith(".")
    : () => true;

  const lower = (text: string) => (fold ? text.toLowerCase() : text);
  const subjectOf = (str: string) => (fold ? str.toLowerCase() : str);

  if (seq.length === 1 && isStar(seq[0])) return (str) => dotOk(str);
  if (seq.length === 2 && isStar(seq[0])) {
    const text = plain(seq[1]);
    if (text === null) return null;
    const want = lower(text);
    return (str) => subjectOf(str).endsWith(want) && dotOk(str);
  }
  if (seq.length === 2 && isStar(seq[1])) {
    const text = plain(seq[0]);
    if (text === null) return null;
    const want = lower(text);
    // The first character comes from the literal, so a leading `.` is explicit.
    return (str) => subjectOf(str).startsWith(want);
  }
  if (seq.length === 3 && isStar(seq[0]) && isStar(seq[2])) {
    const text = plain(seq[1]);
    if (text === null) return null;
    const want = lower(text);
    return (str) => subjectOf(str).includes(want) && dotOk(str);
  }
  return null;
}

/** A high surrogate means the string carries an astral character. */
const SURROGATE_PAIR = /[\uD800-\uDBFF]/;

function buildMatch(chars: Units, res: MatchResult): PatternMatch {
  const groups: string[] = [];
  const mbegin: number[] = [];
  const mend: number[] = [];
  for (const cap of res.captures) {
    if (cap) {
      groups.push(unitsSlice(chars, cap.start, cap.end));
      mbegin.push(cap.start + 1);
      mend.push(cap.end);
    } else {
      groups.push("");
      mbegin.push(-1);
      mend.push(-1);
    }
  }
  return {
    match: unitsSlice(chars, res.start, res.end),
    index: res.start,
    endIndex: res.end,
    groups,
    mbegin,
    mend,
    errors: res.errors,
  };
}

/**
 * `BAD_PATTERN` is consulted only in Src/glob.c, in filename generation: a
 * malformed pattern used for matching is always an error, whatever the option
 * says.  The globber applies the fallback itself, in `planGlob`.
 */
function compileSource(
  source: string,
  options: ZshOptions,
  moreFollows: boolean,
  headerPrefix: number,
): ParsedPattern {
  return parsePattern(source, options, moreFollows, headerPrefix);
}

const cache = new Map<string, ZshPattern>();

/** Patterns already compiled under a given options object, and under none. */
const identityCache = new WeakMap<ZshOptionsInput, Map<string, ZshPattern>>();
const plainCache = new Map<string, ZshPattern>();
let lastOptions: ZshOptionsInput | undefined;

/** Compile a pattern, reusing a cached result for identical inputs. */
export function compile(
  pattern: string,
  options?: ZshOptionsInput,
  settings?: PatternSettings,
): ZshPattern {
  // Keyed on the options object itself where it can be: serialising the
  // options costs several times the lookup it keys, and the same object comes
  // back call after call.  It is read as immutable, which is what passing it
  // to a memoised function already implies.
  let byPattern: Map<string, ZshPattern> | undefined;
  let seenBefore = false;
  if (settings === undefined) {
    if (options === undefined) {
      byPattern = plainCache;
    } else {
      // A caller that writes the options out at the call site hands over a
      // fresh object every time; remembering those would be so much litter,
      // so an object earns its own table only by turning up twice.
      seenBefore = options === lastOptions;
      // Not even looked up until then: asking a `WeakMap` about an object it
      // has never seen is what stamps an identity on it, and that costs more
      // than the miss saves.
      if (seenBefore) byPattern = identityCache.get(options);
      else lastOptions = options;
    }
    const hit = byPattern?.get(pattern);
    if (hit !== undefined) return hit;
  }

  const key = JSON.stringify([pattern, options ?? null, settings ?? null]);
  let compiled = cache.get(key);
  if (!compiled) {
    compiled = new ZshPattern(pattern, options, settings);
    if (cache.size > 500) cache.clear();
    cache.set(key, compiled);
  }
  if (byPattern === undefined && seenBefore && options !== undefined) {
    byPattern = new Map();
    identityCache.set(options, byPattern);
  }
  if (byPattern !== undefined) {
    if (byPattern.size > 500) byPattern.clear();
    byPattern.set(pattern, compiled);
  }
  return compiled;
}

/** Does `str` match `pattern` in full, as `[[ str = pattern ]]` would? */
export function match(str: string, pattern: string, options?: ZshOptionsInput): boolean {
  return compile(pattern, options).test(str);
}

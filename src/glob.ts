import { NoMatchError, ZshPatternError } from "./errors.js";
import { isAbsolutePath, pathRoot, toPosix, windowsPathsByDefault } from "./paths.js";
import {
  lstat,
  nodeAsyncFs,
  nodeSyncFs,
  readdir,
  readdirAll,
  readdirOrdered,
  runAsync,
  runSync,
  stat,
  type AsyncFsAdapter,
  type FsGenerator,
  type GlobDirent,
  type GlobStats,
  type SyncFsAdapter,
} from "./fs.js";
import { applyModifier } from "./modifiers.js";
import { resolveOptions, type ZshOptions, type ZshOptionsInput } from "./options.js";
import { ZshPattern } from "./pattern.js";
import {
  emptyQualifiers,
  parseQualifiers,
  type QualContext,
  type QualifierHooks,
  type Qualifiers,
  type SortSpec,
} from "./qualifiers.js";

export interface GlobOptions extends ZshOptionsInput {
  /** Directory the pattern is resolved against. Defaults to `process.cwd()`. */
  cwd?: string;
  /** Return absolute paths even for a relative pattern. */
  absolute?: boolean;
  /** Filesystem for `globSync`; defaults to `node:fs`. */
  fs?: SyncFsAdapter;
  /** Filesystem for `glob`; defaults to `node:fs/promises`. */
  fsAsync?: AsyncFsAdapter;
  /** Implementations for the qualifiers that would otherwise run shell code. */
  qualifierHooks?: QualifierHooks;
  /** Reference time for the `a`, `m` and `c` qualifiers. Defaults to now. */
  now?: number;
  /**
   * Compose directory entry names to NFC before matching them.
   *
   * `zreaddir` does this on Apple platforms and nowhere else -- it converts
   * each name from "UTF-8-MAC" to "UTF-8" with `iconv`, keeping the original
   * if that fails -- so a name stored decomposed matches a composed pattern
   * and comes back composed.  It is the reason `?clair.txt` finds a file whose
   * name begins with `e` and a combining acute: zsh sees ten characters where
   * the bytes hold eleven.
   *
   * Defaults to true on darwin, as zsh's `#ifdef __APPLE__` does.  It is safe
   * there because the filesystem is normalisation insensitive, so the composed
   * name still opens the file; on a filesystem that is not, the two are
   * different names, which is why zsh does not do this anywhere else.
   */
  nfcNames?: boolean;
  /**
   * Read `cwd` and absolute patterns by Windows' rules: a drive letter or a
   * UNC share begins an absolute path, and `\` is accepted as a separator
   * *in a path* -- never in a pattern, where it is the escape character.
   *
   * Defaults to true on Windows and false elsewhere, so a directory named
   * `C:` on a Unix host is still an ordinary name.
   */
  windowsPaths?: boolean;
  /** Guard against symlink loops while recursing with `***\/`. */
  maxDepth?: number;
}

interface LiteralSegment {
  type: "literal";
  text: string;
}

interface PatternSegment {
  type: "pattern";
  pattern: ZshPattern;
}

/** `**\/`, `***\/`, `(pat/)#` and `(pat/)##`. */
interface RecurseSegment {
  type: "recurse";
  /** Pattern each directory name must match; `null` means any. */
  pattern: ZshPattern | null;
  min: number;
  followLinks: boolean;
}

type Segment = LiteralSegment | PatternSegment | RecurseSegment;

interface Plan {
  segments: Segment[];
  /**
   * The separator that goes *before* each segment, and one more for the end.
   * Normally "/", but a run of slashes in the pattern is kept: zsh compiles
   * `sub//x` to three components, the middle one matching the empty name and
   * contributing a slash of its own, so the run survives into the result.
   * `seps[0]` is "/" only for an absolute pattern.
   */
  seps: string[];
  /** The slashes a trailing `/` stands for: "/" normally, "//" for `sub//`. */
  trailingSep: string;
  /** Top level `~` exclusions, tested against the whole path. */
  exclusions: ZshPattern[];
  qualifiers: Qualifiers;
  absolute: boolean;
  options: ZshOptions;
  /** A trailing `/`: only directories match, and the slash is kept. */
  trailingSlash: boolean;
  /** True when the word contains nothing that needs matching. */
  trivial: boolean;
  source: string;
}

interface Candidate {
  path: string;
  dirent: GlobDirent | null;
}

/** Expand a zsh filename generation pattern. */
export function globSync(pattern: string, options: GlobOptions = {}): string[] {
  const plan = planGlob(pattern, options);
  const fs = options.fs ?? nodeSyncFs();
  const ctx = makeContext(options, false);
  const candidates = runSync(walk(plan, ctx), fs);
  return runSync(finish(plan, ctx, candidates), fs);
}

/** Expand a zsh filename generation pattern, reading the filesystem asynchronously. */
export async function glob(pattern: string, options: GlobOptions = {}): Promise<string[]> {
  const plan = planGlob(pattern, options);
  const fs = options.fsAsync ?? nodeAsyncFs();
  const ctx = makeContext(options, true);
  const candidates = await runAsync(walk(plan, ctx), fs);
  return runAsync(finish(plan, ctx, candidates), fs);
}

/**
 * Expands a whole command's worth of words, which is what `CSH_NULL_GLOB`
 * needs: it deletes a pattern that matched nothing, and reports an error only
 * when every pattern in the command matched nothing.  Words that are not
 * patterns are passed through and do not count towards that judgement.
 *
 * Without `cshNullGlob` this is just each word expanded in turn.
 */
export function expandWordsSync(words: string[], options: GlobOptions = {}): string[] {
  const opt = resolveOptions(options);
  if (!opt.cshNullGlob) return words.flatMap((word) => globSync(word, options));

  const perWord = words.map((word) => {
    const plan = planGlob(word, options);
    if (plan.trivial) return { isPattern: false, result: [word] };
    const result = globSync(word, { ...options, cshNullGlob: false, nullGlob: true });
    return { isPattern: true, result };
  });

  const patterns = perWord.filter((entry) => entry.isPattern);
  if (patterns.length > 0 && patterns.every((entry) => entry.result.length === 0)) {
    throw new NoMatchError(words.join(" "), { whole: true });
  }
  return perWord.flatMap((entry) => entry.result);
}

interface Context {
  cwd: string;
  absolute: boolean;
  now: number;
  maxDepth: number;
  hooks: QualifierHooks;
  /**
   * True when the driver can serve several reads at once, which only the
   * asynchronous one can.  Reading a level ahead costs the synchronous driver
   * the same syscalls in the same order and buys it nothing, so it does not.
   */
  parallel: boolean;
  /**
   * `Yn` is in play, so the walk must see directories in the order the
   * filesystem gives them rather than the sorted order `fs.readdir` returns,
   * and may stop as soon as it has enough.
   */
  ordered: boolean;
  /** `Yn`: how many candidates to collect, or `Infinity`. */
  wanted: number;
  /** Compose directory entry names to NFC; see `GlobOptions.nfcNames`. */
  nfc: boolean;
  /** Read paths by Windows' rules; see `GlobOptions.windowsPaths`. */
  windows: boolean;
  /** Directories on the current descent, to stop `***\/` looping. */
  seen: Set<string>;
  /**
   * Directory listings already read during this expansion.  A recursive glob
   * visits the same directory once for the closure and once for the segment
   * that follows it, so without this every directory is read twice.
   */
  listings: Map<string, GlobDirent[] | null>;
}

function makeContext(options: GlobOptions, parallel: boolean): Context {
  const windows = options.windowsPaths ?? windowsPathsByDefault();
  return {
    parallel,
    windows,
    ordered: false,
    wanted: Infinity,
    nfc:
      options.nfcNames ??
      (typeof process !== "undefined" && process.platform === "darwin"),
    cwd: toPosix(options.cwd ?? (typeof process !== "undefined" ? process.cwd() : "/")),
    absolute: options.absolute ?? false,
    now: options.now ?? Date.now(),
    maxDepth: options.maxDepth ?? 64,
    hooks: options.qualifierHooks ?? {},
    seen: new Set(),
    listings: new Map(),
  };
}

// --------------------------------------------------------------------- plan

/**
 * Compiled plans, keyed by the word and the options that shape it.  Expanding
 * the same glob repeatedly is the normal case, and parsing it again each time
 * was the largest cost after reading the directories.
 */
const planCache = new Map<string, Plan>();

function planGlob(source: string, options: GlobOptions): Plan {
  // The parts of the options that change how the word compiles.  The rest --
  // `cwd`, the filesystem, the hooks -- are applied when the plan is walked.
  const key = `${source}\u0000${JSON.stringify([
    options.glob, options.extendedGlob, options.kshGlob, options.shGlob,
    options.globDots, options.caseGlob, options.casePaths, options.bareGlobQual,
    options.badPattern, options.multibyte, options.posixIdentifiers,
    options.globStarShort, options.nullGlob, options.noMatch, options.cshNullGlob,
    options.markDirs, options.listTypes, options.numericGlobSort,
    options.qualifierHooks === undefined,
  ])}`;
  const cached = planCache.get(key);
  if (cached) return cached;
  const plan = buildPlan(source, options);
  if (planCache.size > 500) planCache.clear();
  planCache.set(key, plan);
  return plan;
}

function buildPlan(source: string, options: GlobOptions): Plan {
  const opt = resolveOptions(options);
  if (!opt.glob) {
    // Without GLOB there is no filename generation: the word stands as it is.
    return {
      segments: [{ type: "literal", text: unescape(source, opt) }],
      seps: [""],
      trailingSep: "",
      trailingSlash: false,
      exclusions: [],
      qualifiers: emptyQualifiers(),
      absolute: false,
      options: opt,
      trivial: true,
      source,
    };
  }
  if (!hasWilds(source, opt)) {
    // `haswilds()` decides, before anything else, whether the word is a
    // pattern at all (Src/glob.c: `if (unset(GLOBOPT) || !haswilds(ostr) ...)`).
    // If it is not, the word is left exactly as it is -- no qualifiers, no
    // exclusions, no check that it exists.
    return {
      segments: [{ type: "literal", text: unescape(source, opt) }],
      seps: [""],
      trailingSep: "",
      trailingSlash: false,
      exclusions: [],
      qualifiers: emptyQualifiers(),
      absolute: false,
      options: opt,
      trivial: true,
      source,
    };
  }
  try {
    return compilePlan(source, options, opt);
  } catch (err) {
    // A pattern is compiled one path component at a time, but zsh reports the
    // word it came from: `sub/[a` is "bad pattern: sub/[a".  Quoting is gone
    // by then, so `[a\ b` is reported as `[a b`.
    if (err instanceof ZshPatternError && err.kind === "pattern") {
      err = err.withWord(unescape(source, opt));
    }
    // Only a failure to compile the *pattern* reaches the BAD_PATTERN test:
    // `zglob` parses the qualifiers first and reports their errors there and
    // then, well before `parsepat` is called.  So `*(z)` is an error whatever
    // the option says, while `*(` is left alone as an ordinary word.
    if (err instanceof ZshPatternError && err.kind === "pattern" && !opt.badPattern) {
      // With BAD_PATTERN unset zsh does not report a malformed word: it stops
      // treating it as a pattern and leaves it alone, so it passes through as
      // an ordinary word.  This covers a bad glob qualifier too, which is
      // parsed after the pattern itself.
      return {
        segments: [{ type: "literal", text: unescape(source, opt) }],
        seps: [""],
      trailingSep: "",
        trailingSlash: false,
        exclusions: [],
        qualifiers: emptyQualifiers(),
        absolute: false,
        options: opt,
        trivial: true,
        source,
      };
    }
    throw err;
  }
}

function compilePlan(source: string, options: GlobOptions, opt: ZshOptions): Plan {
  // zsh peels the qualifiers off the end of the whole word first, then
  // compiles what is left as a pattern, exclusions and all.
  const { base: withoutQualifiers, qualifierText } = extractQualifiers(source, opt);
  // zsh keeps a top level `~` inside the last component's own program, where
  // it is a `P_EXCLUDP` that gets the path so far put in front of it.  Pulling
  // it out to be tested separately gives the same answer whenever the two
  // cannot interact -- but they do interact, through the sync node that stops
  // an exclusion being retried at an end the branch already reached, so
  // `*^~a.txt` matches nothing while `*^` and `~a.txt` apart would.  Where the
  // whole word is one component there is no path to put in front, so it is
  // compiled as it stands and the interaction survives.
  let { base, exclusions } = hasSlashOutsideBrackets(withoutQualifiers)
    ? splitExclusions(withoutQualifiers, opt)
    : { base: withoutQualifiers, exclusions: [] as string[] };

  const qualifiers = qualifierText === null
    ? emptyQualifiers()
    : parseQualifiers(qualifierText, source, options.qualifierHooks ?? {});

  const globDots = opt.globDots || qualifiers.globDots;
  const patternOptions: ZshOptionsInput = { ...options, globDots };
  // CASE_GLOB belongs to filename generation, so it is applied here rather
  // than by the pattern compiler.
  const settings = { noLeadingDot: !globDots, ignoreCase: !opt.caseGlob };

  // `parsepat` peels one leading `(#...)` off the whole word before it looks
  // at the path at all, "so that they don't form a bogus path component".
  // That is why `(#i)**/` still recurses while `sub/(#i)**/` does not, and it
  // is why only the first group is peeled: `(#i)(#l)**/` does not recurse.
  const peel = peelLeadingFlags(base, opt);
  const flagPrefix = peel.flags;
  if (peel.body !== null) {
    // The group still has to be a valid one: `(#se)` is a bad pattern, since
    // "*assertp && (*strp)[1] != Outpar" requires an assertion to be alone.
    // Compiling it reports that in the same way any other bad pattern is.
    new ZshPattern(`(#${peel.body})`, patternOptions, settings);
  }
  base = peel.base;

  const absolute = base.startsWith("/");
  // `foo*/` matches directories only, and reports them with the slash.
  // Whether the word ends in an empty component, which is what a trailing `/`
  // is; `trailingSep` below says how many.
  let trailingSlash = base.length > 1 && base.endsWith("/");
  // The leading `/` of an absolute pattern is not a prefix but an empty first
  // component, which is what makes the joined path start with a slash.
  const rawSegments = splitSegments(base, opt);
  const segments: Segment[] = [];

  // A run of slashes is a run of empty components: zsh compiles `sub//x` to
  // three, the middle one matching the empty name and contributing a slash of
  // its own.  They can only ever match, so instead of walking them the run is
  // remembered here and put back when a path is built.
  // Which raw component is the last one with anything in it: the globbing
  // flags at the end of *that* are the ones with nothing after them.
  let lastText = -1;
  for (let i = 0; i < rawSegments.length; i++) if (rawSegments[i] !== "") lastText = i;

  /** Does this component compile to nothing, and so stand for an empty name? */
  const compilesEmpty = (text: string): boolean => {
    // Only a run of flag groups can come to nothing, and this compiles the
    // component to find out, so it is worth not reaching for anything else.
    if (!/^(\(#[^)]*\))+$/.test(text)) return false;
    try {
      return new ZshPattern(flagPrefix + text, patternOptions, {
        ...settings,
        headerPrefix: flagPrefix.length,
      }).isPureEmpty;
    } catch {
      // Malformed: leave it to the ordinary path, which reports it.
      return false;
    }
  };

  const seps: string[] = [];
  // The separator that goes before the next component.  Component zero has one
  // too; it is simply not printed, so an extra empty component in front of it
  // is what an absolute path is made of.
  let pending = "/";
  let filled = 0;
  const flush = () => {
    for (let k = filled; k < segments.length; k++) seps[k] = k === filled ? pending : "/";
    if (segments.length > filled) pending = "/";
    filled = segments.length;
  };

  for (let i = 0; i < rawSegments.length; i++) {
    const text = rawSegments[i];
    // A component that compiles to no nodes at all is the empty pure string,
    // and so is the empty component between two slashes.  Whether a run of
    // flag groups comes to that is not something the text can be read for: a
    // group in the middle that changes something is emitted as a node, so
    // `(#a1)(#i)(#a1)` is empty and `(#a1)(#a1)(#i)(#a1)` is not.
    if (text === "" || (opt.extendedGlob && compilesEmpty(text))) {
      flush();
      pending += "/";
      continue;
    }
    flush();
    const isLast = i === rawSegments.length - 1;
    // A trailing `/` is more of the word, so `??(#a1)/` still approximates.
    const segSettings =
      i < lastText || trailingSlash ? { ...settings, moreFollows: true } : settings;

    // `**/` and `***/`, plus the GLOB_STAR_SHORT forms `**.c` and `***.c`.
    const stars = /^(\*\*\*?)(.*)$/.exec(text);
    if (stars && (stars[2] === "" ? !isLast : opt.globStarShort)) {
      segments.push({
        type: "recurse",
        pattern: null,
        min: 0,
        followLinks: stars[1] === "***",
      });
      if (stars[2] !== "") {
        segments.push({
          type: "pattern",
          pattern: new ZshPattern(`${flagPrefix}*${stars[2]}`, patternOptions, segSettings),
        });
      }
      continue;
    }

    // `(pat/)#` and `(pat/)##`, of which `**/` is the shorthand.  The group
    // ends the path segment itself, so `(dir*/)#*.txt` is two segments.
    let rest = text;
    if (opt.extendedGlob) {
      for (;;) {
        const closure = peelClosure(rest);
        if (!closure) break;
        if (closure.inner.includes("/")) {
          throw new ZshPatternError("'/' may not appear inside a group", source, 0);
        }
        segments.push({
          type: "recurse",
          pattern: new ZshPattern(flagPrefix + closure.inner, patternOptions, segSettings),
          min: closure.min,
          followLinks: false,
        });
        rest = closure.rest;
      }
      if (rest === "") continue;
    }

    // Any `/` left here is inside a group or a bracket: a group may not hold
    // one, but `[^/]` is fine, since no filename can contain a slash anyway.
    if (hasSlashOutsideBrackets(rest)) {
      throw new ZshPatternError("'/' may not appear inside a group", source, 0);
    }

    // Flags peeled off the front are part of the component's pattern, so a
    // component that reads as plain text is only plain when there are none:
    // `(#a2)abcd` matches approximately, and `(#i)foo)` is still malformed.
    if (peel.body === null && isLiteral(rest, opt)) {
      // With NO_CASE_GLOB a plain component still has to be found case
      // insensitively, so it becomes a pattern; CASE_PATHS is what keeps such
      // components case sensitive.
      if (!opt.caseGlob && !opt.casePaths) {
        segments.push({
          type: "pattern",
          pattern: new ZshPattern(
            flagPrefix + quotePattern(unescape(rest, opt)),
            patternOptions,
            segSettings,
          ),
        });
      } else {
        segments.push({ type: "literal", text: unescape(rest, opt) });
      }
    } else {

      segments.push({
        type: "pattern",
        pattern: new ZshPattern(flagPrefix + rest, patternOptions, segSettings),
      });
    }
  }

  flush();
  // What is left over belongs to the trailing slash, which is a component of
  // its own: `sub/` ends in one empty component and `sub//` in two.
  const trailingSep = pending.slice(1);
  // `/` on its own is two empty components, and neither the test above nor
  // `rawSegments` calls that a trailing slash, but it is one.
  trailingSlash = trailingSep !== "";

  // Nothing reaching here is trivial: `haswilds` has already said this word is
  // a pattern, and the two earlier returns took the words it said were not.
  // A pattern is generated from the filesystem even when every operator in it
  // turned out to be inert -- `file<1-2>.txt` under SH_GLOB spells a name that
  // matches only itself, and reports no matches rather than passing through.
  const trivial = false;

  return {
    segments,
    seps,
    trailingSep,
    trailingSlash,
    // Inside an exclusion neither `/` nor a leading `.` is special.
    // No `flagPrefix` here: approximation is switched off inside an exclusion
    // unless it is asked for again there, and prefixing would undo that.
    exclusions: exclusions.map((ex) => new ZshPattern(ex, patternOptions, { noLeadingDot: false })),
    qualifiers,
    absolute,
    options: opt,
    trivial,
    source,
  };
}


/**
 * A leading `(pat/)#` or `(pat/)##`, the general form of `**\/`.  The trailing
 * slash inside the group is what separates it from the rest of the pattern.
 */
function peelClosure(text: string): { inner: string; min: number; rest: string } | null {
  if (!text.startsWith("(")) return null;
  let depth = 0;
  let close = -1;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === "\\") {
      i++;
      continue;
    }
    if (c === "(") depth++;
    else if (c === ")" && --depth === 0) {
      close = i;
      break;
    }
  }
  if (close < 0) return null;
  const inner = text.slice(1, close);
  if (!inner.endsWith("/")) return null;
  let i = close + 1;
  let hashes = 0;
  while (text[i] === "#") {
    hashes++;
    i++;
  }
  if (hashes === 0 || hashes > 2) return null;
  return { inner: inner.slice(0, -1), min: hashes === 2 ? 1 : 0, rest: text.slice(i) };
}

/** Split off top level `~` exclusions, which apply to the whole path. */
function splitExclusions(pattern: string, opt: ZshOptions): { base: string; exclusions: string[] } {
  if (!opt.extendedGlob) return { base: pattern, exclusions: [] };
  const parts: string[] = [];
  let current = "";
  let depth = 0;
  let inBracket = false;

  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === "\\") {
      current += c + (pattern[i + 1] ?? "");
      i++;
      continue;
    }
    if (inBracket) {
      current += c;
      if (c === "]") inBracket = false;
      continue;
    }
    if (c === "[") inBracket = true;
    else if (c === "(") depth++;
    else if (c === ")") depth--;
    else if (c === "~" && depth === 0) {
      const next = pattern[i + 1];
      if (next !== undefined && next !== "~" && next !== "|" && next !== ")") {
        parts.push(current);
        current = "";
        continue;
      }
    }
    current += c;
  }
  parts.push(current);
  return { base: parts[0], exclusions: parts.slice(1) };
}

/** Split a pattern into path segments at unquoted, top level slashes. */
function splitSegments(pattern: string, opt: ZshOptions): string[] {
  const segments: string[] = [];
  let current = "";
  let depth = 0;
  let inBracket = false;

  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === "\\") {
      // Quoting a `/` does not stop it separating path segments: no filename
      // can contain one, so `sub\/b.txt` is still `sub/b.txt`.
      if (pattern[i + 1] === "/" && depth === 0 && !inBracket) {
        segments.push(current);
        current = "";
        i++;
        continue;
      }
      current += c + (pattern[i + 1] ?? "");
      i++;
      continue;
    }
    if (inBracket) {
      current += c;
      if (c === "]") inBracket = false;
      continue;
    }
    if (c === "[") inBracket = true;
    else if (c === "(" && !opt.shGlob) depth++;
    else if (c === ")" && !opt.shGlob) depth--;
    else if (c === "/" && depth === 0) {
      segments.push(current);
      current = "";
      continue;
    }
    current += c;
  }
  segments.push(current);
  return segments;
}

/** Peel off a trailing `(#q...)` or bare `(...)` list of glob qualifiers. */
function extractQualifiers(
  pattern: string,
  opt: ZshOptions,
): { base: string; qualifierText: string | null } {
  // `checkglobqual()` in Src/glob.c looks for the Inpar/Outpar *tokens*, and
  // `zshtokenize()` never produces them under SH_GLOB, so neither the bare
  // `(...)` nor the `(#q...)` form is a qualifier list there.
  if (opt.shGlob) return { base: pattern, qualifierText: null };
  let base = pattern;
  let collected: string | null = null;

  for (;;) {
    if (!base.endsWith(")") || isEscaped(base, base.length - 1)) break;
    const open = findOpeningParen(base);
    if (open < 0) break;
    const inner = base.slice(open + 1, -1);

    if (opt.extendedGlob && inner.startsWith("#q")) {
      collected = collected === null ? inner.slice(2) : inner.slice(2) + collected;
      base = base.slice(0, open);
      continue;
    }
    // A trailing `(#...)` that is not `(#q...)` is a globbing flag or a count
    // operator, so it stays part of the pattern.
    if (opt.extendedGlob && inner.startsWith("#")) break;
    if (opt.bareGlobQual && isBareQualifier(inner, opt)) {
      collected = collected === null ? inner : inner + collected;
      base = base.slice(0, open);
    }
    break; // only one bare qualifier group is recognised
  }

  return { base, qualifierText: collected };
}

/**
 * A trailing group is a bare qualifier list unless it holds something that
 * makes it look like alternatives or exclusions instead.
 *
 * `checkglobqual` scans back to the opening parenthesis and clears the "bare"
 * flag on a `|`, on a `~` when EXTENDED_GLOB is on, and on a closing `)` --
 * the `case Outpar` there falls through into `case Bar`.  It is the closing
 * one that counts, not the opening, which matters only when they are not
 * balanced.  An explicit `(#q...)` is exempt and never reaches here.
 */
/**
 * Peels one leading `(#...)` group off a whole glob, as `parsepat` does before
 * calling `parsecomplist`, and returns it as a prefix to put back on every
 * path component -- `patglobflags` applies to the whole compile, not to the
 * first component.
 *
 * `(#s)` and `(#e)` are dropped.  `parsepat` collects them into a local it
 * then never reads, so a leading `(#e)` asserts nothing during filename
 * generation: `(#e)a` matches the file `a`.  In plain matching it still
 * asserts, and that path does not come through here.
 */
function peelLeadingFlags(
  base: string,
  opt: ZshOptions,
): { base: string; flags: string; body: string | null } {
  const none = { base, flags: "", body: null };
  if (!opt.extendedGlob || opt.shGlob) return none;
  let start = 0;
  if (base.startsWith("(#")) start = 2;
  else if (opt.kshGlob && base.startsWith("@(#")) start = 3;
  else return none;

  const close = base.indexOf(")", start);
  if (close === -1) return none;
  const body = base.slice(start, close);
  // `(#q...)` is a qualifier list and `(#c...)` a count operator; neither is a
  // set of globbing flags, and neither may open a word this way.
  if (body.startsWith("q") || body.startsWith("c")) return none;

  const kept = [...body].filter((c) => c !== "s" && c !== "e").join("");
  return { base: base.slice(close + 1), flags: kept === "" ? "" : `(#${kept})`, body };
}

function isBareQualifier(inner: string, opt: ZshOptions): boolean {
  for (let i = 0; i < inner.length; i++) {
    const c = inner[i];
    if (c === "\\") {
      i++;
      continue;
    }
    if (c === "|" || c === ")") return false;
    if (c === "~" && opt.extendedGlob) return false;
  }
  return true;
}

function findOpeningParen(text: string): number {
  let depth = 0;
  for (let i = text.length - 1; i >= 0; i--) {
    if (isEscaped(text, i)) continue;
    if (text[i] === ")") depth++;
    else if (text[i] === "(") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function isEscaped(text: string, index: number): boolean {
  let backslashes = 0;
  for (let i = index - 1; i >= 0 && text[i] === "\\"; i--) backslashes++;
  return backslashes % 2 === 1;
}

/** True if a `/` appears outside any `[...]` bracket expression. */
function hasSlashOutsideBrackets(text: string): boolean {
  let inBracket = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === "\\") {
      i++;
      continue;
    }
    if (inBracket) {
      if (c === "]") inBracket = false;
      continue;
    }
    if (c === "[") inBracket = true;
    else if (c === "/") return true;
  }
  return false;
}

/**
 * A port of `haswilds()` from Src/pattern.c: does this word contain a token
 * that makes it a pattern?  The list there is Inpar, Bar, Star, Inbrack,
 * Inang, Quest, Pound and Hat -- Tilde and Outpar are deliberately absent, so
 * `foo~bar` and `a)b` are ordinary words.
 */
function hasWilds(text: string, opt: ZshOptions): boolean {
  // "`[' and `]' are legal even if bad patterns are usually not."
  if (text === "[" || text === "]") return false;

  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === "\\") {
      i++;
      continue;
    }
    if (c === "*" || c === "?" || c === "[") return true;
    // `case Bar` has no SH_GLOB test in `haswilds`, but it needs none here:
    // under SH_GLOB neither the lexer nor `zshtokenize` ever turns a `|` into
    // one, so the token cannot reach it.
    if (c === "|" && !opt.shGlob) return true;
    // `case Inang` has no SH_GLOB test either, and here that is visible: the
    // lexer tokenizes `<1-2>` whatever SH_GLOB says, and `haswilds` runs
    // before the option decides what the operator means ("at this point
    // zpc_special has not been set up").  So the word counts as a pattern,
    // matches only itself, and reports no matches rather than passing through.
    if (c === "<" && /^<\d*-\d*>/.test(text.slice(i))) return true;
    if (opt.extendedGlob && (c === "#" || c === "^")) return true;
    if (c === "(") {
      // `case Inpar` tests the *token*, and under SH_GLOB neither the lexer nor
      // `zshtokenize` ever makes a `(` into one -- the ksh arm of that test is
      // written for a token that cannot arrive.  So a `(` counts only with
      // SH_GLOB off, where the ksh forms are what the arm is about.
      if (opt.shGlob) continue;
      if (!opt.kshGlob) return true;
      if (i === 0) return true;
      if ("?*+!@".includes(text[i - 1])) return true;
      return true;
    }
  }
  return false;
}

/** Does this segment contain anything that needs matching? */
function isLiteral(text: string, opt: ZshOptions): boolean {
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === "\\") {
      i++;
      continue;
    }
    if (c === "[") return false;
    if (c === "*" || c === "?" || c === "|") return false;
    if (!opt.shGlob && (c === "(" || c === "<")) return false;
    // `haswilds()` in Src/pattern.c lists exactly which tokens make a word a
    // pattern: Inpar, Bar, Star, Inbrack, Inang, Quest, Pound and Hat.  Tilde
    // is not among them, so `foo~bar` and `(foo~` are ordinary words.
    if (opt.extendedGlob && (c === "^" || c === "#")) return false;
  }
  return true;
}

/** Escapes every operator, so a literal string can be used as a pattern. */
function quotePattern(text: string): string {
  return text.replace(/[*?[\]()<>^#~|\\]/g, (c) => `\\${c}`);
}

function unescape(text: string, opt: ZshOptions): string {
  let out = "";
  for (let i = 0; i < text.length; i++) {
    if (text[i] === "\\" && i + 1 < text.length) {
      // `zshtokenize()` leaves the backslash in place before the characters
      // SH_GLOB exempts, so `\(` there is a backslash followed by a `(`.
      if (opt.shGlob && "(|)<".includes(text[i + 1])) {
        out += text[i];
        continue;
      }
      i++;
    }
    out += text[i];
  }
  return out;
}

// --------------------------------------------------------------------- walk

/**
 * Adds one component to the path built so far.  `null` means no component has
 * been added yet, and the separator before the first one is not printed -- so
 * any extra slashes it carries are the empty components that make a path
 * absolute.
 */
function joinPath(prefix: string | null, name: string, sep = "/"): string {
  if (prefix === null) return sep.slice(1) + name;
  return prefix + sep + name;
}

/** `readdir`, answered from this expansion's cache when it can be. */
function* listDir(ctx: Context, path: string): FsGenerator<GlobDirent[] | null> {
  const cached = ctx.listings.get(path);
  if (cached !== undefined) return cached;
  const entries = composeNames(ctx, ctx.ordered ? yield* readdirOrdered(path) : yield* readdir(path));
  ctx.listings.set(path, entries);
  return entries;
}

/** Only a name with a character outside ASCII can be decomposed. */
const NON_ASCII = /[^\x00-\x7f]/;

/**
 * `zreaddir`'s conversion, for the entries of one directory.  A name that is
 * already composed is returned untouched, which is nearly all of them.
 */
function composeNames(ctx: Context, entries: GlobDirent[] | null): GlobDirent[] | null {
  if (!ctx.nfc || entries === null) return entries;
  let changed = false;
  const out = entries.map((entry) => {
    if (!NON_ASCII.test(entry.name)) return entry;
    const name = entry.name.normalize("NFC");
    if (name === entry.name) return entry;
    changed = true;
    return {
      name,
      isDirectory: () => entry.isDirectory(),
      isSymbolicLink: () => entry.isSymbolicLink(),
    };
  });
  return changed ? out : entries;
}

function* walk(plan: Plan, ctx: Context): FsGenerator<Candidate[]> {
  const results: Candidate[] = [];
  if (plan.trivial) {
    // Nothing here needs matching, and zsh leaves such a word alone.
    const joined = plan.segments.map(segText).join("/");
    const path = plan.absolute ? `/${joined}` : joined;
    return [{ path: plan.trailingSlash ? `${path}/` : path, dirent: null }];
  }
  // `scanner` stops as soon as `shortcircuit == matchct`, so `Yn` is meant to
  // cut the walk short rather than to trim a finished list.  The count is only
  // safe to apply here when nothing downstream can reject a candidate; with
  // filtering qualifiers the walk runs on and `finish` does the counting.
  ctx.ordered = plan.qualifiers.limit !== null;
  // `matchct` counts files that were inserted, so a candidate that `finish`
  // goes on to reject must not be counted here.  Entries read from a
  // directory exist; a literal component is a name that may not, so the walk
  // runs to the end and `finish` does the counting.
  const lastSeg = plan.segments[plan.segments.length - 1];
  ctx.wanted =
    plan.qualifiers.limit !== null &&
    plan.qualifiers.groups.length === 0 &&
    lastSeg !== undefined &&
    lastSeg.type !== "literal"
      ? plan.qualifiers.limit
      : Infinity;
  // Reading a level ahead would read directories the short circuit means to
  // skip, and in the wrong order besides.
  if (ctx.parallel && !ctx.ordered) yield* prefetch(plan, ctx);
  yield* expand(plan, ctx, null, 0, null, results, 0);
  return results;
}

/**
 * Reads the directories the walk is about to want, one segment of the glob at
 * a time, so that a whole level of the tree goes to the driver as a single
 * batch.  The asynchronous driver issues such a batch at once, which is the
 * one thing a shell walking a tree cannot do; the walk below then finds the
 * listings already in hand.
 *
 * This only warms the cache -- what matches is still decided by the walk -- so
 * it applies exactly the tests the walk applies, and reads nothing the walk
 * would not have read itself.  `***\/` is the exception and stops the pass:
 * it follows symlinks, and the check that keeps that from looping holds only
 * along a single descent.
 */
function* prefetch(plan: Plan, ctx: Context): FsGenerator<void> {
  const last = plan.segments.length - 1;
  let frontier: (string | null)[] = [null];
  for (let index = 0; index <= last && frontier.length > 0; index++) {
    const seg = plan.segments[index];
    if (seg.type === "literal") {
      // A literal is not looked up; it just extends the path.
      frontier = frontier.map((prefix) => joinPath(prefix, seg.text, plan.seps[index]));
      continue;
    }
    if (seg.type === "recurse" && seg.followLinks) return;

    const listings = yield* readAll(ctx, frontier);
    if (index === last) return;

    if (seg.type === "pattern") {
      frontier = childDirectories(plan, seg, frontier, listings);
      continue;
    }
    // A `(pat/)#` may stop at any depth, so everything it can reach is a
    // prefix the next segment may be matched against.
    const reached = frontier.slice();
    let level = childDirectories(plan, seg, frontier, listings);
    for (let depth = 1; level.length > 0 && depth <= ctx.maxDepth; depth++) {
      const below = yield* readAll(ctx, level);
      reached.push(...level);
      level = childDirectories(plan, seg, level, below);
    }
    frontier = reached;
  }
}

/** Reads whatever of `paths` is not cached yet, in one batch, and returns all of them. */
function* readAll(ctx: Context, paths: (string | null)[]): FsGenerator<(GlobDirent[] | null)[]> {
  const missing: string[] = [];
  const wanted = new Set<string>();
  for (const path of paths) {
    const full = absolutePath(ctx, path);
    if (ctx.listings.has(full) || wanted.has(full)) continue;
    wanted.add(full);
    missing.push(full);
  }
  if (missing.length > 0) {
    const read = yield* readdirAll(missing);
    for (let i = 0; i < missing.length; i++) {
      ctx.listings.set(missing[i], composeNames(ctx, read[i]));
    }
  }
  return paths.map((path) => ctx.listings.get(absolutePath(ctx, path)) ?? null);
}

/**
 * The subdirectories of each path that the segment will descend into, under
 * the same tests the walk applies.  A symlink is not a directory as far as
 * `readdir` is concerned, so following one is left to the walk.
 */
function childDirectories(
  plan: Plan,
  seg: PatternSegment | RecurseSegment,
  paths: (string | null)[],
  listings: (GlobDirent[] | null)[],
): string[] {
  const out: string[] = [];
  const globDots = plan.qualifiers.globDots || plan.options.globDots;
  for (let i = 0; i < paths.length; i++) {
    const entries = listings[i];
    if (!entries) continue;
    for (const entry of entries) {
      if (entry.name === "." || entry.name === "..") continue;
      if (!entry.isDirectory()) continue;
      if (seg.pattern) {
        if (!seg.pattern.test(entry.name)) continue;
      } else if (!globDots && entry.name.startsWith(".")) {
        // `**\/` stands for `(*/)#`, and `*` skips names starting with a dot.
        continue;
      }
      out.push(joinPath(paths[i], entry.name));
    }
  }
  return out;
}

function segText(seg: Segment): string {
  return seg.type === "literal" ? seg.text : "";
}

function* expand(
  plan: Plan,
  ctx: Context,
  prefix: string | null,
  index: number,
  /** Directories still to be consumed by a `(pat/)##`; `null` on first entry. */
  minLeft: number | null,
  results: Candidate[],
  depth: number,
): FsGenerator<void> {
  if (index === plan.segments.length) {
    // A closure that matched no directories at all leaves nothing before the
    // trailing components, so joining them gives one slash fewer than there
    // are: `**\/` reports nothing for this case, while `**\/\/` reports "/".
    if (prefix === null) {
      const bare = plan.trailingSlash ? plan.trailingSep.slice(1) : "";
      if (bare !== "") results.push({ path: bare, dirent: null });
      return;
    }
    // Not trimmed: a trailing slash here is an empty component the pattern
    // asked for -- the `//` in `sub//**\/` when the closure took nothing --
    // and the components still to come add their own.
    const path = prefix;
    // The `/` inside `(*/)#` is part of what the closure consumed, so a path
    // produced by a closure keeps its trailing slash just as `**/` does.
    // A word that is nothing but a root and a qualifier -- `/(/)` -- leaves no
    // segments at all, and the root is the one candidate.
    const last = plan.segments[plan.segments.length - 1];
    if (plan.trailingSlash) results.push({ path: path + plan.trailingSep, dirent: null });
    else if (last?.type === "recurse") results.push({ path: `${path}/`, dirent: null });
    else results.push({ path, dirent: null });
    return;
  }
  if (depth > ctx.maxDepth) return;
  if (results.length >= ctx.wanted) return;

  const seg = plan.segments[index];
  const isLast = index === plan.segments.length - 1;

  switch (seg.type) {
    case "literal": {
      // The empty name is not a file, so it can only be a directory reached
      // through the slash that follows it.
      if (seg.text === "" && isLast && !plan.trailingSlash) return;
      const path = joinPath(prefix, seg.text, plan.seps[index]);
      if (!isLast) {
        yield* expand(plan, ctx, path, index + 1, null, results, depth);
      } else if (plan.trailingSlash) {
        const st = yield* stat(absolutePath(ctx, path));
        if (st?.isDirectory()) results.push({ path: path + plan.trailingSep, dirent: null });
      } else {
        results.push({ path, dirent: null });
      }
      return;
    }

    case "pattern": {
      const entries = yield* listDir(ctx, dirFor(ctx, prefix, plan.seps[index]));
      if (!entries) return;
      for (const entry of entries) {
        if (entry.name === "." || entry.name === "..") continue;
        if (!seg.pattern.test(entry.name)) continue;
        const path = joinPath(prefix, entry.name, plan.seps[index]);
        if (isLast && plan.trailingSlash) {
          if (yield* isDirectory(ctx, path, entry)) {
            results.push({ path: path + plan.trailingSep, dirent: entry });
          }
        } else if (isLast) {
          results.push({ path, dirent: entry });
          if (results.length >= ctx.wanted) return;
        } else if (yield* isDirectory(ctx, path, entry)) {
          yield* expand(plan, ctx, path, index + 1, null, results, depth);
        }
      }
      return;
    }

    case "recurse": {
      // `(pat/)##` has to consume at least one directory; `(pat/)#` may stop
      // here and carry straight on with the next segment.
      const needed = minLeft ?? seg.min;
      // The separator recorded for this segment goes in front of the first
      // directory the closure takes; the ones it takes after that are joined
      // by a single slash, being components of the closure rather than of the
      // pattern.  `minLeft` is null only on the way in.
      const sep = minLeft === null ? plan.seps[index] : "/";
      if (needed === 0) {
        // The closure took no directory, but any empty components written in
        // front of it are still components and still contribute their slashes:
        // `sub//**\/` gives `sub//` for this case, not `sub/`.
        const carried = sep.slice(1);
        const at = carried === "" ? prefix : joinPath(prefix, "", carried);
        yield* expand(plan, ctx, at, index + 1, null, results, depth);
      }

      // The separator for this level, which is the recorded one only on the
      // way in; the directories the closure takes after that are its own
      // components, joined by a single slash.
      const entries = yield* listDir(ctx, dirFor(ctx, prefix, sep));
      if (!entries) return;

      for (const entry of entries) {
        if (entry.name === "." || entry.name === "..") continue;
        if (entry.isSymbolicLink() && !seg.followLinks) continue;
        if (seg.pattern && !seg.pattern.test(entry.name)) continue;
        if (!seg.pattern && !plan.qualifiers.globDots && !plan.options.globDots) {
          // `**/` stands for `(*/)#`, and `*` skips names starting with a dot.
          if (entry.name.startsWith(".")) continue;
        }
        const path = joinPath(prefix, entry.name, sep);
        if (!(yield* isDirectory(ctx, path, entry))) continue;
        // `***\/` follows symlinks, so refuse to descend into a directory that
        // is already on the path we came down.
        let key: string | null = null;
        if (seg.followLinks) {
          key = yield* directoryKey(ctx, path);
          if (key === null || ctx.seen.has(key)) continue;
          ctx.seen.add(key);
        }
        // One directory consumed; the closure may match more.
        yield* expand(plan, ctx, path, index, Math.max(0, needed - 1), results, depth + 1);
        if (key !== null) ctx.seen.delete(key);
      }
      return;
    }
  }
}

function trimTrailingSlash(path: string, ctx: Context): string {
  if (!path.endsWith("/")) return path;
  // The separator that roots a path is part of it: trimming `C:/` to `C:`
  // would name the working directory of drive C rather than its root, just as
  // trimming `/` to `""` would name nothing at all.
  const root = pathRoot(path, ctx.windows);
  return path.length > root.length ? path.slice(0, -1) : path;
}

/**
 * The directory whose entries a segment is matched against.  The separator in
 * front of the segment belongs to it: any empty components it stands for are
 * already part of the path, and a leading one means the walk starts at the
 * root rather than at the working directory.
 */
function dirFor(ctx: Context, prefix: string | null, sep: string): string {
  const path = joinPath(prefix, "", sep);
  // The separator leaves a trailing slash behind; a real filesystem does not
  // mind, but a name is a name, and the listing cache keys on it.
  return absolutePath(ctx, trimTrailingSlash(path, ctx));
}

function absolutePath(ctx: Context, path: string | null): string {
  if (path === null || path === "") return ctx.cwd;
  if (isAbsolutePath(path, ctx.windows)) return toPosix(path);
  // The cwd already carries one spelling of its separators, so a single `/`
  // joins them -- Windows accepts it as readily as `\`.
  return ctx.cwd.endsWith("/") ? ctx.cwd + path : `${ctx.cwd}/${path}`;
}

function* isDirectory(ctx: Context, path: string, entry: GlobDirent): FsGenerator<boolean> {
  if (entry.isDirectory()) return true;
  if (!entry.isSymbolicLink()) return false;
  const st = yield* stat(absolutePath(ctx, path));
  return st !== null && st.isDirectory();
}

/** Identifies a directory by device and inode, so symlink loops terminate. */
function* directoryKey(ctx: Context, path: string): FsGenerator<string | null> {
  const st = yield* stat(absolutePath(ctx, path));
  return st ? `${st.dev}:${st.ino}` : null;
}

// ------------------------------------------------------------------- finish

function* finish(plan: Plan, ctx: Context, candidates: Candidate[]): FsGenerator<string[]> {
  const q = plan.qualifiers;
  if (plan.trivial) return candidates.map((c) => c.path);

  const needStat =
    q.groups.length > 0 ||
    q.needsStat ||
    q.listTypes ||
    q.markDirs ||
    plan.options.markDirs ||
    q.sorts.some((s) => s.key !== "n" && s.key !== "N" && s.key !== "d" && s.key !== "e");

  const kept: { path: string; ctx: QualContext }[] = [];

  for (const candidate of candidates) {
    if (plan.exclusions.some((ex) => ex.test(candidate.path))) continue;

    let lst: GlobStats | null = null;
    let stt: GlobStats | null = null;
    const full = absolutePath(ctx, candidate.path);

    if (needStat || candidate.dirent === null) {
      // A path that ends in a separator names a directory, so a link at the
      // end of it is followed rather than described: POSIX says `lstat` on
      // `slink/` reports what the link points at, and `*/` under MARK_DIRS
      // gets its second slash from that.  Windows does not follow the same
      // rule, so the resolution is asked for rather than assumed.
      lst = full.endsWith("/") ? yield* stat(full) : yield* lstat(full);
      // A path built only from literal segments has to be checked for existence.
      if (!lst) continue;
      if (q.needsStat) stt = lst.isSymbolicLink() ? yield* stat(full) : lst;
    }

    let emptyDir = false;
    if (q.needsReaddir && lst?.isDirectory()) {
      const entries = yield* readdir(full);
      emptyDir = !entries || entries.length === 0;
    }

    const qctx: QualContext = {
      path: candidate.path,
      fullPath: full,
      name: baseName(candidate.path, ctx),
      lstat: lst,
      stat: stt,
      emptyDir,
      now: ctx.now,
    };

    if (q.groups.length > 0 && !q.groups.some((group) => group.every((test) => test(qctx)))) {
      continue;
    }
    kept.push({ path: candidate.path, ctx: qctx });
    if (q.limit !== null && kept.length >= q.limit) break;
  }

  // zsh assembles the text it will produce -- type mark first, then the colon
  // modifiers -- before sorting, so the sort sees the final strings.
  const markDirs = q.markDirs || plan.options.markDirs;
  const listTypes = q.listTypes || plan.options.listTypes;
  const entries = kept.map((entry) => {
    let value = ctx.absolute ? absolutePath(ctx, entry.path) : entry.path;
    // `insert()` writes the mark at `news[strlen(s)]` without looking at what
    // is already there, so a path that ends in a slash gains a second one:
    // `**/` under MARK_DIRS gives `sub//`.
    if (listTypes) value += typeMark(entry.ctx.lstat);
    else if (markDirs && entry.ctx.lstat?.isDirectory()) value += "/";
    for (const modifier of q.modifiers) {
      value = applyModifier(value, modifier, ctx.cwd, ctx.windows);
    }
    return { value, ctx: entry.ctx };
  });

  // Without an explicit `o`/`O` the default is by name, or unsorted when the
  // `Y` short circuit is in play.
  const sorts: SortSpec[] =
    q.sorts.length > 0
      ? q.sorts
      : q.limit !== null
        ? [{ key: "N", desc: false }]
        : [{ key: "n", desc: false }];
  const numeric = q.numericSort || plan.options.numericGlobSort;

  const sortKeys = new Map<QualContext, string[]>();
  if (sorts.some((spec) => spec.key === "e")) {
    const hook = ctx.hooks.sortKey;
    if (!hook) {
      throw new ZshPatternError(
        "the 'oe' sort qualifier runs shell code; supply a 'qualifierHooks.sortKey' function to use it",
        plan.source,
        0,
        "unsupported",
      );
    }
    for (const entry of entries) {
      sortKeys.set(
        entry.ctx,
        sorts.filter((spec) => spec.key === "e").map((spec) => hook(spec.code ?? "", entry.ctx)),
      );
    }
  }

  if (!sorts.every((spec) => spec.key === "N")) {
    entries.sort((a, b) => {
      let execIndex = 0;
      for (const spec of sorts) {
        let r = 0;
        switch (spec.key) {
          case "n":
            r = compareNames(a.value, b.value, numeric);
            break;
          case "N":
            break;
          case "d":
            r = compareDepth(a.value, b.value); // subdirectories first
            break;
          case "L":
            r = (a.ctx.lstat?.size ?? 0) - (b.ctx.lstat?.size ?? 0);
            break;
          case "l":
            r = (a.ctx.lstat?.nlink ?? 0) - (b.ctx.lstat?.nlink ?? 0);
            break;
          case "a":
            r = (b.ctx.lstat?.atimeMs ?? 0) - (a.ctx.lstat?.atimeMs ?? 0); // youngest first
            break;
          case "m":
            r = (b.ctx.lstat?.mtimeMs ?? 0) - (a.ctx.lstat?.mtimeMs ?? 0);
            break;
          case "c":
            r = (b.ctx.lstat?.ctimeMs ?? 0) - (a.ctx.lstat?.ctimeMs ?? 0);
            break;
          case "e": {
            const ka = sortKeys.get(a.ctx)?.[execIndex] ?? "";
            const kb = sortKeys.get(b.ctx)?.[execIndex] ?? "";
            execIndex++;
            r = compareNames(ka, kb, numeric);
            break;
          }
        }
        if (r !== 0) return spec.desc ? -r : r;
      }
      return 0;
    });
  }

  // `[beg,end]`, using zsh's one-based subscripts that may count from the end.
  let selected = entries;
  if (q.subscript) {
    const n = selected.length;
    const index = (value: number): number => (value < 0 ? n + value : value - 1);
    // zsh subscripts are one based, so index 0 selects nothing at all.
    if (q.subscript.beg === 0) return [];
    const beg = index(q.subscript.beg);
    const end = q.subscript.end === null ? beg : index(q.subscript.end);
    selected = selected.slice(Math.max(0, beg), Math.max(0, end + 1));
  }

  if (selected.length === 0) {
    if (q.nullGlob || plan.options.nullGlob) return [];
    // CSH_NULL_GLOB removes an unmatched pattern and overrides NOMATCH, but
    // the shell still errors when every pattern in the command failed -- and a
    // single word is a command whose every pattern failed.  `expandWords`
    // applies the rule across a whole command.
    // CSH_NULL_GLOB is a judgement about a whole command, and says only
    // "no match"; `expandWordsSync` is what makes it.
    if (plan.options.cshNullGlob) throw new NoMatchError(plan.source, { whole: true });
    if (plan.options.noMatch) throw new NoMatchError(plan.source);
    return [plan.source];
  }

  const out: string[] = [];
  for (const entry of selected) {
    for (const prefix of q.prepend) out.push(prefix);
    out.push(entry.value);
    for (const suffix of q.append) out.push(suffix);
  }
  return out;
}

function baseName(path: string, ctx: Context): string {
  const trimmed = trimTrailingSlash(path, ctx);
  const i = trimmed.lastIndexOf("/");
  return i < 0 ? trimmed : trimmed.slice(i + 1);
}

/**
 * zsh's `GS_DEPTH` comparison: after the common prefix, whichever path still
 * has a directory separator in it is the deeper one and sorts first.
 */
function compareDepth(a: string, b: string): number {
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  let ai = i;
  let bi = i;
  if ((ai >= a.length || bi >= b.length) && ai > 0 && a[ai - 1] === "/") {
    ai--;
    bi--;
  }
  const hasSlash = (s: string, from: number): number => {
    if (from >= s.length) return 0;
    for (let j = from; j + 1 < s.length; j++) if (s[j] === "/") return 1;
    return 0;
  };
  return hasSlash(b, bi) - hasSlash(a, ai);
}

/** zsh's `file_type()`: the trailing character used by `T` and `MARK_DIRS`. */
function typeMark(st: GlobStats | null): string {
  if (!st) return "?";
  if (st.isBlockDevice()) return "#";
  if (st.isCharacterDevice()) return "%";
  if (st.isDirectory()) return "/";
  if (st.isFIFO()) return "|";
  if (st.isSymbolicLink()) return "@";
  if (st.isFile()) return (st.mode & 0o111) !== 0 ? "*" : " ";
  if (st.isSocket()) return "=";
  return "?";
}

/** zsh compares names byte by byte, or number by number under NUMERIC_GLOB_SORT. */
function compareNames(a: string, b: string, numeric: boolean): number {
  if (!numeric) return a < b ? -1 : a > b ? 1 : 0;
  const parts = /(\d+)/;
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    const ca = a[i];
    const cb = b[j];
    if (/\d/.test(ca) && /\d/.test(cb)) {
      const na = parts.exec(a.slice(i))![1];
      const nb = parts.exec(b.slice(j))![1];
      const diff = Number(na) - Number(nb);
      if (diff !== 0) return diff < 0 ? -1 : 1;
      i += na.length;
      j += nb.length;
      continue;
    }
    if (ca !== cb) return ca < cb ? -1 : 1;
    i++;
    j++;
  }
  return a.length - i - (b.length - j);
}

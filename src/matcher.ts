import type {
  AltNode,
  Branch,
  ClassNode,
  Node,
  NumRangeNode,
  ParsedPattern,
  RepeatNode,
  StrNode,
} from "./ast.js";
import type { GlobFlags } from "./options.js";

/**
 * The units of a subject: either the string itself, when each UTF-16 unit is
 * one unit of matching, or an array when it is not.  Both index the same way.
 */
export type Units = ArrayLike<string>;

/**
 * A high surrogate means the string carries at least one astral character.
 * A regexp rather than a hand-written loop: V8 compiles this one to a scan
 * that measures about twice as fast on names of the length filenames have.
 */
const HAS_SURROGATE_PAIR = /[\uD800-\uDBFF]/;

/** Joins a slice of units back into a string. */
export function unitsSlice(units: Units, from: number, to: number): string {
  return typeof units === "string"
    ? units.slice(from, to)
    : Array.prototype.slice.call(units, from, to).join("");
}

const EMPTY_CAPTURES: (Capture | null)[] = [];

/** Digits that always fit a double exactly, and the largest such value. */
const SAFE_DIGITS = 15;
const SAFE_LIMIT = 999999999999999n;

/** A continuation: given the position the current node stopped at, match the rest. */
type Cont = (pos: number) => boolean;

export interface MatchSettings {
  /** Split the subject into code points rather than UTF-16 code units. */
  multibyte: boolean;
  /** File globbing without `GLOB_DOTS`: a leading `.` must be matched literally. */
  noLeadingDot: boolean;
  /** `CASE_GLOB` unset: match case insensitively everywhere. */
  ignoreCase: boolean;
  /** Value of `IFS`, for `[[:IFS:]]`. */
  ifs: string;
  /** Value of `WORDCHARS`, for `[[:WORD:]]`. */
  wordChars: string;
  /** `POSIX_IDENTIFIERS`: restrict `[:IDENT:]` to ASCII. */
  posixIdentifiers: boolean;
}

export const defaultSettings: MatchSettings = {
  multibyte: true,
  noLeadingDot: false,
  ignoreCase: false,
  ifs: " \t\n\0",
  wordChars: "*?_-.[]~=/&;!#$%^(){}<>",
  posixIdentifiers: false,
};

export interface Capture {
  start: number;
  end: number;
}

export interface MatchArgs {
  /** Index to start matching at. */
  from?: number;
  /** Match against `chars[from, to)` only; `(#e)` fails at a truncated end. */
  to?: number;
  /** Require the match to reach the end of the subject. */
  anchorEnd?: boolean;
  /** Without `anchorEnd`, prefer the longest match over the shortest. */
  longest?: boolean;
}

/** Where a successful match started and stopped, plus any backreferences. */
export interface MatchResult {
  start: number;
  end: number;
  captures: (Capture | null)[];
  /** Number of errors used up by approximate matching. */
  errors: number;
}

/**
 * Backtracking matcher over the pattern AST, written in continuation passing
 * style so that `~` exclusions and closures backtrack the way `patmatch` does.
 */
export class Matcher {
  private chars: Units = "";
  /** Effective end of the subject; exclusions temporarily shorten it. */
  private end = 0;
  private len = 0;
  private captures: (Capture | null)[] = [];
  private errs = 0;
  /** True while matching against a subject that was truncated, so `(#e)` fails. */
  private notEnd = false;
  private noLeadingDot: boolean;
  /**
   * A literal's text split into units, kept per node: the same run is matched
   * over and over, including on every backtrack, and splitting it each time
   * was the largest allocation in a match.
   */
  private readonly literalUnits = new Map<StrNode, Units>();
  /** Per-sequence width bounds and `*` lookaheads, worked out once each. */
  private readonly seqInfos = new Map<Node[], SeqInfo>();
  /** The above for every branch of an alternation, so one lookup serves all. */
  private readonly altInfos = new Map<AltNode, SeqInfo[]>();
  /** One accept-or-not test per `[...]`, resolved once instead of per unit. */
  private readonly classTests = new Map<ClassNode, StarFilter>();
  /** `<x-y>` bounds as doubles, worked out once per range. */
  private readonly numRanges = new Map<NumRangeNode, { lo: number; hi: number }>();
  /**
   * zsh's `exactpos` and `exactend`: how far into a literal run the
   * approximation repairs have got.  Both outlive the attempt that set them,
   * which is what `matchExact` reproduces.
   */
  private exactpos: { run: StrNode; idx: number } | null = null;
  private exactend: StrNode | null = null;
  /** P_EXCSYNC marks, one set per level of nested exclusion. */
  private readonly excPool: Int32Array[] = [];
  private excDepth = 0;
  /** P_COUNT: the position each counted closure last tried an iteration at. */
  private readonly countPtr = new Map<RepeatNode, number>();
  /** P_WBRANCH: positions each open closure has already been entered at. */
  private readonly wbranchMemos = new Map<RepeatNode, WbranchState>();
  /**
   * True if any part of the pattern may match approximately.  Under
   * approximation a node can consume fewer units than it spells out, so the
   * width bounds below no longer hold and zsh drops its own lookahead too
   * (`!(patglobflags & 0xff)` in Src/pattern.c).
   */
  private readonly hasApprox: boolean;
  /** The largest error budget in force anywhere in the pattern. */
  private readonly maxApprox: number;
  /** The budget in force at the end of the pattern, for absorbing what is left over. */
  private readonly endApprox: number;
  /** `settings.multibyte`, read on every match. */
  private readonly multibyte: boolean;
  /** How far apart the ends of an anchored match may be. */
  private readonly spanMin: number;
  private readonly spanMax: number;
  /** The arguments of the `match` in progress, read by `done` below. */
  private anchorEnd = true;
  private longest = true;
  private best = -1;
  private bestCaptures: (Capture | null)[] = EMPTY_CAPTURES;
  private bestErrs = 0;

  constructor(
    private readonly parsed: ParsedPattern,
    private readonly settings: MatchSettings,
  ) {
    this.noLeadingDot = settings.noLeadingDot;
    this.multibyte = settings.multibyte;
    // A pattern with nothing in it but globbing flags never reaches
    // `patmatch`: zsh compiles it to a plain string, which is compared as one,
    // so no flag can reach it and `(#a1)` matches the empty string and nothing
    // else.  An empty *group* is a node, and `(#a1)()` does match `a`.
    // `PAT_PURES` with an empty string: compared with `strcmp`, so no flag
    // reaches it and no error can be spent absorbing anything.
    const nodeless = parsed.pureEmpty;
    // The most errors any one part of the pattern may spend.  `errsfound` in
    // zsh is capped by the flags in force where the failure happened, so this
    // bounds it wherever in the pattern the match is.
    this.endApprox = nodeless ? 0 : parsed.approx;
    this.maxApprox = nodeless ? 0 : Math.max(parsed.approx, altApprox(parsed.root));
    this.hasApprox = this.maxApprox > 0;
    // Both bounds widened by that budget: an error moves what the pattern
    // consumes by at most one unit either way, and a match may also absorb
    // trailing characters as errors.
    this.spanMin = Math.max(0, this.altMinWidth(parsed.root) - this.maxApprox);
    const most = this.altMaxWidth(parsed.root);
    this.spanMax = most === Infinity ? Infinity : most + this.maxApprox;
  }

  /**
   * Splits a string into the units this matcher counts.  With MULTIBYTE those
   * are code points; without it they are bytes, as in zsh -- so `?` matches
   * one byte of a UTF-8 character rather than the whole character.
   *
   * A string with no surrogate pair has one code point per UTF-16 unit, so it
   * is returned as itself: indexing it gives the same units an array would,
   * without allocating one per match.
   */
  split(s: string): Units {
    if (this.settings.multibyte) {
      return HAS_SURROGATE_PAIR.test(s) ? Array.from(s) : s;
    }
    const bytes: string[] = [];
    for (const ch of s) {
      const code = ch.charCodeAt(0);
      if (ch.length === 1 && code >= 0xdc80 && code <= 0xdcff) {
        // A byte that is not a character, held as `0xDC00 + byte`: it stands
        // for that one byte, not for the replacement character that encoding
        // a lone surrogate would produce.
        bytes.push(String.fromCharCode(code - 0xdc00));
        continue;
      }
      for (const b of new TextEncoder().encode(ch)) bytes.push(String.fromCharCode(b));
    }
    return bytes;
  }

  /**
   * Match `s` starting at `from`.
   *
   * `anchorEnd` requires the match to consume the whole subject, which is what
   * `[[ str = pat ]]` does; without it the shortest or longest match starting
   * at `from` is returned, as for `${str#pat}` and `${str##pat}`.
   */
  match(
    s: string | Units,
    { from = 0, to, anchorEnd = true, longest = true }: MatchArgs = {},
  ): MatchResult | null {
    // The overwhelmingly common subject is a string of plain characters,
    // which is its own unit array; testing for that here rather than inside
    // `split` keeps the call out of the path entirely.
    this.chars =
      typeof s !== "string"
        ? s
        : this.multibyte && !HAS_SURROGATE_PAIR.test(s)
          ? s
          : this.split(s);
    this.len = this.chars.length;
    this.end = to ?? this.len;
    // Matching against a prefix of the subject, so `(#e)` must not succeed.
    this.notEnd = this.end !== this.len;

    // "exactpos = exactend = NULL" before the one external call to patmatch.
    this.exactpos = null;
    this.exactend = null;

    if (anchorEnd) {
      // An anchored match has to consume everything between `from` and the
      // end, so a pattern that cannot span that distance need not be tried at
      // all.  `(#a3)aaaaaaaaaa` spans seven to thirteen units however it errs,
      // and is answered here for every subject outside that.
      const span = this.end - from;
      if (span < this.spanMin || span > this.spanMax) return null;
    }
    this.anchorEnd = anchorEnd;
    this.longest = longest;
    this.best = -1;
    this.bestCaptures = EMPTY_CAPTURES;
    this.bestErrs = 0;

    // Reused rather than reallocated: `test` throws the groups away, and a
    // match runs often enough for the allocation to show up as collection.
    if (this.captures.length === this.parsed.ngroups) this.captures.fill(null);
    else this.captures = new Array(this.parsed.ngroups).fill(null);
    this.errs = 0;
    const ok = this.matchAlt(this.parsed.root, from, this.done);

    if (anchorEnd) {
      return ok ? { start: from, end: this.end, captures: this.captures, errors: this.errs } : null;
    }
    if (this.best < 0) return null;
    return {
      start: from,
      end: this.best,
      captures: this.bestCaptures,
      errors: this.bestErrs,
    };
  }

  /**
   * The continuation the whole pattern ends in.  Built once and driven by the
   * fields above rather than closed over the arguments of `match`, so that a
   * test costs no allocation at all.
   */
  private readonly done: Cont = (pos) => {
    if (this.anchorEnd) {
      if (pos === this.end) return true;
      // Approximate matching may absorb trailing characters as errors.
      const extra = this.end - pos;
      if (extra <= this.endApprox - this.errs) {
        this.errs += extra;
        return true;
      }
      return false;
    }
    // The search continues past a hit while looking for a longer one, and
    // backtracking would undo the groups, so keep a copy of them.
    if (pos > this.best) {
      this.best = pos;
      this.bestCaptures = this.captures.slice();
      this.bestErrs = this.errs;
    }
    return !this.longest;
  };

  /** Leftmost match anywhere in the subject, as used by `${str/pat/repl}`. */
  search(s: string): MatchResult | null {
    const chars = this.split(s);
    for (let i = 0; i <= chars.length; i++) {
      const m = this.match(chars, { from: i, anchorEnd: false, longest: true });
      if (m) return m;
    }
    return null;
  }

  // ------------------------------------------------------------- the engine

  private matchAlt(alt: AltNode, pos: number, k: Cont): boolean {
    let infos = this.altInfos.get(alt);
    if (infos === undefined) {
      infos = alt.branches.map((branch) => this.seqInfo(branch.seq));
      this.altInfos.set(alt, infos);
    }
    return this.matchBranches(alt, infos, pos, k);
  }

  /** The alternation, with its branches' sequences already worked out. */
  private matchBranches(alt: AltNode, infos: SeqInfo[], pos: number, k: Cont): boolean {
    const branches = alt.branches;
    // The group is the same whichever branch fills it, so this is built once
    // rather than once per branch.
    const capture = alt.capture;
    const inner: Cont =
      capture > 0
        ? (end) => {
            const saved = this.captures[capture - 1];
            this.captures[capture - 1] = { start: pos, end };
            if (k(end)) return true;
            this.captures[capture - 1] = saved;
            return false;
          }
        : k;
    // "save = patinput; savglobflags = patglobflags; saverrsfound = errsfound"
    // at the head of each alternative, and put back after it fails.  A branch
    // is the only thing that puts the error count back.
    const savedErrs = this.errs;
    for (let i = 0; i < branches.length; i++) {
      if (this.matchBranch(branches[i], infos[i], pos, inner)) return true;
      this.errs = savedErrs;
    }
    return false;
  }

  private matchBranch(branch: Branch, info: SeqInfo, pos: number, k: Cont): boolean {
    const excludes = branch.excludes;
    if (excludes.length === 0) return this.matchSeq(info, 0, pos, k);

    // `x~y`: the branch and everything after it must match, and only then is
    // the text the branch itself consumed tested against the exclusions.  A
    // hit forces backtracking into the branch, as in zsh.
    //
    // The P_EXCSYNC node in front of the exclusion remembers where the branch
    // has already reached: "if we already matched from here, this time we
    // fail."  Every alternative runs into the same node, so a second way of
    // reaching an end that was already excluded is not tried again --
    // `(^a|^b)~c` does not match `a`, though `^b` alone would.
    //
    // The mark is the error count rather than a bit, as P_WBRANCH's is:
    // arriving with fewer errors spent leaves more for the rest, so that is
    // worth trying again.  And a mark left at an earlier position belonged to
    // a branch this one has backtracked past, so those are cleared.
    //
    // The marks are fresh for each entry, as `zshcalloc` gives them, so that
    // one attempt at an enclosing closure cannot rule out the next and a
    // nested exclusion keeps its own; they are kept in a stack by nesting
    // depth rather than allocated afresh.
    const depth = this.excDepth++;
    let marks = this.excPool[depth];
    if (marks === undefined || marks.length <= this.len + 1) {
      marks = new Int32Array(this.len + 2);
      this.excPool[depth] = marks;
    } else {
      marks.fill(0, 0, this.len + 2);
    }
    try {
      return this.matchSeq(info, 0, pos, (end) => {
        const seen = marks[end];
        if (seen !== 0 && this.errs + 1 >= seen) return false;
        marks[end] = this.errs + 1;
        for (let i = 0; i < end; i++) marks[i] = 0;
        if (!k(end)) return false;
        for (let i = 0; i < excludes.length; i++) {
          if (this.matchExclusion(excludes[i], pos, end, branch.excludeApprox[i] ?? 0)) {
            return false;
          }
        }
        return true;
      });
    } finally {
      this.excDepth = depth;
    }
  }

  /** Does `seq` match the whole of `chars[start, end)`? */
  private matchExclusion(seq: Node[], start: number, end: number, budget: number): boolean {
    const savedEnd = this.end;
    const savedNotEnd = this.notEnd;
    const savedErrs = this.errs;
    const savedDot = this.noLeadingDot;
    // Only a pattern with `(#b)` groups has anything to put back.
    const savedCaptures = this.captures.length > 0 ? this.captures.slice() : this.captures;

    this.end = end;
    this.notEnd = end !== this.len;
    this.errs = 0;
    this.noLeadingDot = false; // a leading '.' is ordinary inside an exclusion

    // The exclusion ends where the branch did, and may spend errors reaching
    // it, exactly as the whole pattern may: `(#a2)abc~(#a2)b` excludes `abc`.
    const hit = this.matchSeq(this.seqInfo(seq), 0, start, (p) => {
      if (p === end) return true;
      const extra = end - p;
      if (extra <= budget - this.errs) {
        this.errs += extra;
        return true;
      }
      return false;
    });

    this.end = savedEnd;
    this.notEnd = savedNotEnd;
    this.errs = savedErrs;
    this.noLeadingDot = savedDot;
    // An excluded match invalidates any groups the exclusion captured.
    this.captures = savedCaptures;
    return hit;
  }

  private matchSeq(info: SeqInfo, idx: number, pos: number, k: Cont): boolean {
    const seq = info.nodes;
    // A run of nodes that can each match only one way is walked here rather
    // than through a continuation apiece: nothing in such a run is ever
    // backtracked into, so the closures only cost allocation.  Both this and
    // the width bound are switched off under approximation, where `mins` is
    // left at zero, because skipping a node there changes the answer.
    for (;;) {
      if (idx === seq.length) return k(pos);
      // Nothing can consume more units than remain, so a tail that spells out
      // more characters than are left cannot match however it backtracks.
      if (this.end - pos < info.mins[idx]) return false;
      const step = info.plain[idx];
      if (step === undefined) break;
      const next = step(pos);
      if (next < 0) return false;
      pos = next;
      idx++;
    }
    const node = seq[idx];
    if (node.kind === "star") return this.matchStarBefore(info, idx, pos, k);
    const simple = info.simple[idx];
    if (simple !== undefined) return this.matchSimpleRepeat(info, idx, simple, pos, k);
    const alts = info.alts[idx];
    if (alts !== undefined) {
      return this.matchBranches(node as AltNode, alts, pos, (end) =>
        this.matchSeq(info, idx + 1, end, k),
      );
    }
    return this.matchNode(node, pos, (end) => this.matchSeq(info, idx + 1, end, k));
  }

  /**
   * For a node that matches in exactly one way, a function from a position to
   * the position after it, or -1 for no match.  `undefined` for anything that
   * can match in more than one way, and for everything while approximation is
   * in play, where any node may match several widths.
   */
  private plainStep(node: Node): ((pos: number) => number) | undefined {
    switch (node.kind) {
      case "str": {
        const units = this.unitsOf(node);
        const flags = node.flags;
        const n = units.length;
        return (pos) => {
          let p = pos;
          for (let i = 0; i < n; i++) {
            if (p >= this.end || !this.charEq(units[i], this.chars[p], flags)) return -1;
            p++;
          }
          return p;
        };
      }
      case "any":
        return (pos) => (pos < this.end && !this.dotBlocked(pos) ? pos + 1 : -1);
      case "class": {
        const accepts = this.classPredicate(node);
        return (pos) =>
          pos < this.end && !this.dotBlocked(pos) && accepts(this.chars[pos], pos) ? pos + 1 : -1;
      }
      case "anchor":
        return node.where === "start"
          ? (pos) => (pos === 0 ? pos : -1)
          : (pos) => (pos === this.end && !this.notEnd ? pos : -1);
      default:
        return undefined;
    }
  }

  /** The leading `.` of a filename, which only a literal dot may match. */
  private dotBlocked(pos: number): boolean {
    return this.noLeadingDot && pos === 0 && this.chars[0] === ".";
  }

  /**
   * A closure over something that matches exactly one unit -- `?#`, `[abc]##`,
   * `x#` -- which zsh compiles to P_ONEHASH/P_TWOHASH rather than the general
   * branching form, and matches by counting greedily and then giving units
   * back (`patrepeat` in Src/pattern.c).
   *
   * The distinction is visible, not merely faster: on this path zsh refuses
   * the closure outright when it stands at the start of a filename before a
   * literal dot, so `?#.foo` does not match `.foo` while `(?)#.foo` does.
   */
  private matchSimpleRepeat(
    info: SeqInfo,
    idx: number,
    unit: StarFilter,
    pos: number,
    k: Cont,
  ): boolean {
    const rep = info.nodes[idx] as RepeatNode;
    if (
      this.noLeadingDot &&
      pos === 0 &&
      pos < this.end &&
      this.chars[0] === "." &&
      isWildcard(rep.body)
    ) {
      // "if (!globdots && P_NOTDOT(P_OPERAND(scan)) && patinput == patinstart
      // && ... == ZWC('.')) return 0" -- the closure fails, rather than
      // falling back on matching nothing at all.
      return false;
    }

    let stop = pos;
    while (stop < this.end && stop - pos < rep.max && unit(this.chars[stop], stop)) stop++;
    const lo = pos + rep.min;
    if (stop < lo) return false;

    const hi = Math.min(stop, this.end - info.mins[idx + 1]);
    const filter = info.filters[idx];
    for (let q = hi; q >= lo; q--) {
      if (filter !== undefined && (q >= this.end || !filter(this.chars[q], q))) continue;
      if (this.matchSeq(info, idx + 1, q, k)) return true;
    }
    return false;
  }

  /**
   * `*` followed by the rest of its sequence.  zsh handles this case apart
   * from the general closure "for speed", and looks ahead at what follows so
   * that positions which cannot start it are never tried; this does the same,
   * and additionally stops as soon as too little of the subject is left for
   * the rest of the sequence.
   */
  private matchStarBefore(info: SeqInfo, idx: number, pos: number, k: Cont): boolean {
    // A `*` is a wildcard, so at the start of a filename it may not match a
    // leading dot -- the same test `matchNode` makes.
    if (this.noLeadingDot && pos === 0 && pos < this.end && this.chars[0] === ".") return false;

    const hi = this.end - info.mins[idx + 1];
    // Built only where zsh has it: off wherever approximation is in force at
    // this star, on elsewhere -- including inside an exclusion.
    const filter = info.filters[idx];
    // Greedy: the longest match is tried first, then shorter ones.  The rest
    // of the sequence is entered directly rather than through a continuation,
    // which would be allocated afresh on every `*` the pattern has.
    // "patglobflags = savglobflags; errsfound = saverrsfound" between the
    // lengths the `*` is tried at.
    const savedErrs = this.errs;
    if (filter === undefined) {
      for (let p = hi; p >= pos; p--) {
        if (this.matchSeq(info, idx + 1, p, k)) return true;
        this.errs = savedErrs;
      }
      return false;
    }
    for (let p = hi; p >= pos; p--) {
      // "nextch == PEOF || (patinput < patinend && CHARMATCH_EXPR(...))": with
      // a lookahead to satisfy, a position at the end of the subject is not
      // tried at all -- there is no character there to satisfy it.
      if (p >= this.end || !filter(this.chars[p], p)) continue;
      if (this.matchSeq(info, idx + 1, p, k)) return true;
      this.errs = savedErrs;
    }
    return false;
  }

  /**
   * The width bounds and `*` lookaheads for one sequence, worked out the first
   * time it is matched.  Under approximation both are switched off: a node may
   * then consume fewer units than it spells out, and zsh drops its own
   * lookahead for the same reason (`!(patglobflags & 0xff)` in Src/pattern.c).
   */
  private seqInfo(seq: Node[]): SeqInfo {
    let info = this.seqInfos.get(seq);
    if (info !== undefined) return info;
    const mins = new Int32Array(seq.length + 1);
    const filters: (StarFilter | undefined)[] = new Array(seq.length).fill(undefined);
    const simple: (StarFilter | undefined)[] = new Array(seq.length).fill(undefined);
    const plain: (((pos: number) => number) | undefined)[] = new Array(seq.length).fill(undefined);
    const alts: (SeqInfo[] | undefined)[] = new Array(seq.length).fill(undefined);
    // Registered before its branches are walked, so a closure that contains
    // itself does not recurse for ever here.
    info = { nodes: seq, mins, filters, simple, plain, alts };
    this.seqInfos.set(seq, info);
    for (let i = 0; i < seq.length; i++) {
      const node = seq[i];
      if (node.kind === "alt") alts[i] = node.branches.map((b) => this.seqInfo(b.seq));
    }
    // All of this is off under approximation, and has to be.  With `(#a...)`
    // in play, reaching a node is not merely how the match proceeds: a literal
    // run that fails leaves `exactend` pointing into itself, and the repairs
    // that follow read it.  Skipping a node that was going to fail therefore
    // changes the answer, so nothing here may skip one -- not the width
    // bounds, not the `*` lookahead, not the closure fast path.
    if (!this.hasApprox) {
      for (let i = seq.length - 1; i >= 0; i--) mins[i] = mins[i + 1] + this.minWidth(seq[i]);
      for (let i = 0; i < seq.length; i++) {
        const node = seq[i];
        plain[i] = this.plainStep(node);
        if (node.kind === "star") filters[i] = this.starFilter(seq[i + 1]);
        else if (node.kind === "repeat") {
          simple[i] = this.repeatUnit(node.body);
          if (simple[i] !== undefined) filters[i] = this.starFilter(seq[i + 1]);
        }
      }
    } else {
      // zsh turns its `*` lookahead off by the budget in force *at that star*
      // ("!(patglobflags & 0xff)"), not by whether the pattern approximates
      // anywhere.  Inside an exclusion approximation is off unless asked for
      // again, so the lookahead is on there -- and it has to be, because it
      // decides whether the node after the star is ever entered, and a node
      // that is entered and fails leaves `exactend` behind it.  Without this,
      // `(#a2)abc~*x*` fails to match `abx`.
      for (let i = 0; i < seq.length; i++) {
        const node = seq[i];
        if (node.kind !== "star") continue;
        const next = seq[i + 1];
        if (next !== undefined && nodeApprox(next) === 0) filters[i] = this.starFilter(next);
      }
    }
    return info;
  }

  private altMinWidth(alt: AltNode): number {
    let least = Infinity;
    for (const branch of alt.branches) {
      let width = 0;
      for (const inner of branch.seq) width += this.minWidth(inner);
      if (width < least) least = width;
    }
    return least === Infinity ? 0 : least;
  }

  private altMaxWidth(alt: AltNode): number {
    let most = 0;
    for (const branch of alt.branches) {
      let width = 0;
      for (const inner of branch.seq) {
        width += this.maxWidth(inner);
        if (width === Infinity) break;
      }
      if (width > most) most = width;
    }
    return most;
  }

  /** The most a node can consume, `Infinity` where that is unbounded. */
  private maxWidth(node: Node): number {
    switch (node.kind) {
      case "str":
        return this.unitsOf(node).length;
      case "any":
      case "class":
        return 1;
      case "numrange":
        // A run of digits: the upper bound limits how many, but a leading zero
        // may pad it, so only an open range is treated as unbounded here.
        return node.to === null ? Infinity : Infinity;
      case "star":
        return Infinity;
      case "anchor":
        return 0;
      case "repeat":
        return node.max === Infinity ? Infinity : node.max * this.maxWidth(node.body);
      case "alt":
        return this.altMaxWidth(node);
    }
  }

  private minWidth(node: Node): number {
    switch (node.kind) {
      case "str":
        return this.unitsOf(node).length;
      case "any":
      case "class":
        return 1;
      case "numrange":
        return 1; // `<x-y>` needs at least one digit
      case "star":
      case "anchor":
        return 0;
      case "repeat":
        return node.min === 0 ? 0 : node.min * this.minWidth(node.body);
      case "alt":
        return this.altMinWidth(node);
    }
  }

  /**
   * A test the unit a `*` stops before has to pass, taken from the node that
   * follows it -- zsh's `nextch` lookahead, widened from a literal's first
   * character to any single-unit piece.  `undefined` when what follows says
   * nothing useful, in which case every position is tried.
   */
  private starFilter(next: Node | undefined): StarFilter | undefined {
    if (next === undefined) return undefined;
    if (next.kind === "str") {
      const units = this.unitsOf(next);
      if (units.length === 0) return undefined;
      const first = units[0];
      const flags = next.flags;
      return (ch) => this.charEq(first, ch, flags);
    }
    if (next.kind === "class") return this.classPredicate(next);
    if (next.kind === "numrange") return (ch) => ch >= "0" && ch <= "9";
    return undefined;
  }

  /**
   * The single unit a closure body accepts, if it accepts exactly one.  zsh's
   * P_SIMPLE: `?`, `[...]` and a one-character literal, but not a number
   * range, a group or a run of more than one character.
   */
  private repeatUnit(body: Node): StarFilter | undefined {
    if (body.kind === "any") return TRUE_FILTER;
    if (body.kind === "class") return this.classPredicate(body);
    if (body.kind === "str") {
      const units = this.unitsOf(body);
      if (units.length !== 1) return undefined;
      const only = units[0];
      const flags = body.flags;
      return (ch) => this.charEq(only, ch, flags);
    }
    return undefined;
  }

  /** A literal's text split into units, computed once per node. */
  private unitsOf(node: StrNode): Units {
    let text = this.literalUnits.get(node);
    if (text === undefined) {
      text = this.split(node.text);
      this.literalUnits.set(node, text);
    }
    return text;
  }

  private matchNode(node: Node, pos: number, k: Cont): boolean {
    // zsh marks every wildcard node "not dot": at the start of a filename a
    // leading '.' can only be matched by a literal dot.
    if (
      this.noLeadingDot &&
      pos === 0 &&
      pos < this.end &&
      this.chars[0] === "." &&
      isWildcard(node)
    ) {
      return false;
    }

    switch (node.kind) {
      case "str":
        return this.matchStr(node, pos, k);
      case "any":
        return this.skipInput(node.flags.approx, pos, (p) => (p < this.end ? p + 1 : -1), k);
      case "star":
        return this.matchStar(pos, k);
      case "class":
        return this.skipInput(
          node.flags.approx,
          pos,
          (p) => (p < this.end && this.classMatches(node, this.chars[p], p) ? p + 1 : -1),
          k,
        );
      case "numrange":
        return this.skipInputWhole(node.flags.approx, pos, (p) => this.matchNumRange(node, p, k));
      case "alt":
        return this.matchAlt(node, pos, k);
      case "repeat":
        return this.matchRepeat(node, pos, k, 0);
      case "anchor":
        // An anchor is repaired the same way, which can never rescue `(#s)`
        // -- dropping subject only moves the position further from the start
        // -- but does rescue `(#e)`: `(#a1)abc(#e)` matches `abcd`.
        return node.where === "start"
          ? this.skipInput(node.flags.approx, pos, (p) => (p === 0 ? p : -1), k)
          : this.skipInput(
              node.flags.approx,
              pos,
              (p) => (p === this.end && !this.notEnd ? p : -1),
              k,
            );
    }
  }

  /**
   * A node that either matches where it stands or does not -- `?`, `[...]`,
   * `(#s)`, `(#e)`.  zsh can repair such a node only one way, by omitting a
   * character from the subject, which it does in a loop; and once the node
   * matches it moves on.  The repair is for the node, not for whatever comes
   * after it, so the continuation is entered once and not retried with more
   * of the subject thrown away.
   */
  private skipInput(
    budget: number,
    pos: number,
    step: (p: number) => number,
    k: Cont,
  ): boolean {
    for (let p = pos; ; p++) {
      const end = step(p);
      if (end >= 0) return k(end);
      if (this.errs >= budget || p >= this.end) return false;
      this.errs++;
    }
  }

  /**
   * The same repair for `<x-y>`, which zsh only declares failed once every
   * length of digit run has been tried against the rest of the pattern -- so
   * here, unlike above, the retry does follow a failure of what comes after.
   */
  private skipInputWhole(budget: number, pos: number, attempt: (p: number) => boolean): boolean {
    for (let p = pos; ; p++) {
      if (attempt(p)) return true;
      if (this.errs >= budget || p >= this.end) return false;
      this.errs++;
    }
  }

  /**
   * A `*` reached through `matchNode` rather than through its sequence, which
   * is the general case and no longer arises: the sequence walker handles
   * every `*` itself, and a closure over a bare `*` is a bad pattern.  Kept
   * because `matchNode` has to answer for every kind of node.
   */
  private matchStar(pos: number, k: Cont): boolean {
    // Greedy: the longest match is tried first, then shorter ones.
    const savedErrs = this.errs;
    for (let p = this.end; p >= pos; p--) {
      if (k(p)) return true;
      this.errs = savedErrs;
    }
    return false;
  }

  private matchRepeat(rep: RepeatNode, pos: number, k: Cont, count: number): boolean {
    const entryErrs = this.errs;
    if (rep.counted) {
      // P_COUNTSTART saves the node's count and its "position last tried",
      // zeroes the count, runs the closure and puts both back.
      const saved = this.countPtr.get(rep);
      const ok = this.matchCount(rep, pos, k, 0);
      if (saved === undefined) this.countPtr.delete(rep);
      else this.countPtr.set(rep, saved);
      return ok;
    }
    if (count < rep.max) {
      // P_WBRANCH.  zsh notes each position a closure has been entered at and
      // refuses to enter it there again: "this is where we make sure that we
      // are not repeatedly matching zero-length strings in a closure, which
      // would cause an infinite loop, and also remove exponential behaviour in
      // backtracking nested closures".  Without it `(f#o#)#` against a
      // twenty-six character string takes this matcher a fifth of a second and
      // zsh a fortieth of a millisecond.
      //
      // `x##` matches its first, mandatory iteration ahead of the branch, so
      // that one is not marked, and `(#cN,M)` is a counted closure with no
      // branch to mark at all.
      const marked = rep.max === Infinity && count >= rep.min;
      let state: WbranchState | undefined;
      let owner = false;
      let blocked = false;
      if (marked) {
        state = this.wbranchMemos.get(rep);
        if (state === undefined) {
          state = { marks: new Int32Array(this.len + 1), live: false };
          this.wbranchMemos.set(rep, state);
        }
        // Opened by the outermost entry and closed when it returns, so one
        // attempt at the closure cannot rule out the next.  The marks are kept
        // and cleared rather than reallocated: a closure matched against each
        // name in a directory would otherwise allocate once per name.
        if (!state.live) {
          owner = true;
          state.live = true;
          if (state.marks.length <= this.len) state.marks = new Int32Array(this.len + 1);
          else state.marks.fill(0, 0, this.len + 1);
        }
        // With approximation the mark is the error count rather than a bit:
        // coming back with more of the budget left is worth another try.
        const seen = state.marks[pos];
        if (seen !== 0 && this.errs + 1 >= seen) blocked = true;
        state.marks[pos] = this.errs + 1;
      }

      let more = false;
      if (!blocked) {
        more = this.matchNode(rep.body, pos, (end) => {
          if (end === pos) {
            // A zero width iteration can only help to reach the minimum;
            // looping on it would never terminate.
            return count + 1 >= rep.min ? k(end) : this.matchRepeat(rep, end, k, count + 1);
          }
          return this.matchRepeat(rep, end, k, count + 1);
        });
      }
      if (owner) state!.live = false;
      if (more) return true;
      this.errs = entryErrs;
    }
    return count >= rep.min ? k(pos) : false;
  }

  /**
   * `(#cN,M)`: P_COUNT.  The count and the position last tried live on the
   * pattern node.  When an iteration fails zsh puts the count back and leaves
   * the position, and the guard that stops a zero length iteration looping
   * reads that position -- so it can see one left behind by an attempt that
   * has since been abandoned.
   */
  private matchCount(rep: RepeatNode, pos: number, k: Cont, cur: number): boolean {
    if (cur > 0 && cur >= rep.min && this.countPtr.get(rep) === pos) {
      // "the previous attempt managed zero length ... simply try to match the
      // remainder of the pattern."
      return k(pos);
    }
    this.countPtr.set(rep, pos);
    if (cur < rep.max) {
      const more = this.matchNode(rep.body, pos, (end) => this.matchCount(rep, end, k, cur + 1));
      if (more) return true;
    }
    if (cur < rep.min) return false;
    return k(pos);
  }

  /** `<x-y>`: a run of digits whose value lies in the range, longest first. */
  private matchNumRange(node: NumRangeNode, pos: number, k: Cont): boolean {
    let scan = pos;
    while (scan < this.end && this.chars[scan] >= "0" && this.chars[scan] <= "9") scan++;
    if (scan === pos) return false;
    const { from, to } = node;
    const bounds = this.numBounds(node);
    for (let p = scan; p > pos; p--) {
      const text = unitsSlice(this.chars, pos, p);
      // A run short enough to fit a double exactly -- which is every number
      // anyone writes -- is compared as one, rather than building a `BigInt`
      // for each of the lengths the range is tried at.
      if (text.length <= SAFE_DIGITS) {
        const value = Number(text);
        if (value < bounds.lo || value > bounds.hi) continue;
      } else {
        const value = BigInt(text);
        if (from !== null && value < from) continue;
        if (to !== null && value > to) continue;
      }
      if (k(p)) return true;
    }
    return false;
  }

  /**
   * The range as a pair of doubles, for values small enough to hold one.  A
   * bound too large for that is reported as `Infinity`, which rejects every
   * such value -- correctly, since they are all smaller than the bound.
   */
  private numBounds(node: NumRangeNode): { lo: number; hi: number } {
    let bounds = this.numRanges.get(node);
    if (bounds === undefined) {
      bounds = {
        lo: node.from === null ? -Infinity : node.from <= SAFE_LIMIT ? Number(node.from) : Infinity,
        hi: node.to === null ? Infinity : node.to <= SAFE_LIMIT ? Number(node.to) : Infinity,
      };
      this.numRanges.set(node, bounds);
    }
    return bounds;
  }

  private matchStr(node: StrNode, pos: number, k: Cont): boolean {
    // Without approximation the sequence walker matches literal runs itself,
    // through `plainStep`, so this arm is the answer for a run reached some
    // other way rather than the one the matching normally goes through.
    if (!this.hasApprox) {
      const units = this.unitsOf(node);
      const flags = node.flags;
      let p = pos;
      for (let i = 0; i < units.length; i++) {
        if (p >= this.end || !this.charEq(units[i], this.chars[p], flags)) return false;
        p++;
      }
      return k(p);
    }
    return this.matchExact(node, pos, k);
  }

  /**
   * `case P_EXACTLY` and the approximation block that follows it, followed as
   * written in Src/pattern.c rather than reformulated.
   *
   * The awkward part is deliberate.  `exactpos` and `exactend` say how far
   * into a literal run the four repairs have got, and zsh holds them in file
   * statics: `exactpos` is copied into a local and put back between attempts,
   * `exactend` is not.  So an attempt that fails inside a *different* run
   * leaves `exactend` pointing into that one, and the repairs that follow
   * measure against the wrong end -- which is why `bc` does not match
   * `(#a1)a?c` although it matches `(#a1)abc`.  Keeping the two variables and
   * their lifetimes is what makes this agree with zsh; a tidier formulation
   * does not.
   */
  private matchExact(node: StrNode, pos: number, k: Cont): boolean {
    // if (exactpos) { chrop = exactpos; chrend = exactend; } else { whole run }
    let run: StrNode;
    let idx: number;
    let endRun: StrNode;
    if (this.exactpos !== null) {
      run = this.exactpos.run;
      idx = this.exactpos.idx;
      endRun = this.exactend!;
    } else {
      run = node;
      idx = 0;
      endRun = node;
    }
    this.exactpos = null;

    const units = this.unitsOf(run);
    const flags = node.flags;
    let p = pos;
    // while (chrop < chrend && patinput < patinend)
    while (this.beforeEnd(run, idx, endRun) && p < this.end) {
      // Past the end of its own run, `chrop` is walking the bytes of the
      // compiled program -- lengths and opcodes -- which no subject character
      // matches.
      if (idx >= units.length) break;
      if (!this.charEq(units[idx], this.chars[p], flags)) break;
      idx++;
      p++;
    }
    if (!this.beforeEnd(run, idx, endRun)) return k(p);

    // if (chrop < chrend) { exactpos = chrop; exactend = chrend; fail = 1; }
    // `patinput` is left where the run stopped, not where it started: on a
    // mismatch zsh puts it back to the offending character, and when the
    // subject runs out it is already at the end.
    this.exactpos = { run, idx };
    this.exactend = endRun;
    return this.repairExact(node, p, k);
  }

  /** The four repairs, in zsh's order, sharing zsh's state. */
  private repairExact(node: StrNode, pos: number, k: Cont): boolean {
    const before = this.errs;
    if (before >= node.flags.approx) {
      this.exactpos = null;
      return false;
    }
    const savexact = this.exactpos!;
    const spent = before + 1;
    this.errs = spent;

    // 1. omit a character from the subject, then retry this same node
    if (pos < this.end && this.matchExact(node, pos + 1, k)) return true;

    // nextexact is derived here, against whatever `exactend` now holds -- the
    // attempt above may have left it in another run.
    const nextexact = { run: savexact.run, idx: savexact.idx + 1 };
    if (pos < this.end) {
      this.errs = spent;
      this.exactpos = savexact;
      // 2. two characters transposed
      if (
        pos + 1 < this.end &&
        this.beforeEnd(nextexact.run, nextexact.idx, this.exactend!) &&
        this.charAt(savexact) !== null &&
        this.charAt(nextexact) !== null &&
        this.charEq(this.charAt(savexact)!, this.chars[pos + 1], node.flags) &&
        this.charEq(this.charAt(nextexact)!, this.chars[pos], node.flags)
      ) {
        this.exactpos = { run: nextexact.run, idx: nextexact.idx + 1 };
        if (this.matchExact(node, pos + 2, k)) return true;
        this.errs = spent;
      }
      // 3. omit a character from both
      this.exactpos = nextexact;
      if (this.matchExact(node, pos + 1, k)) return true;
      this.errs = spent;
      this.exactpos = savexact;
    }

    // 4. omit a character from the pattern.  zsh loops rather than recursing,
    // so there is nothing after this to fall back on -- and it leaves the
    // error spent.  Only a branch puts `errsfound` back.
    this.exactpos = { run: savexact.run, idx: savexact.idx + 1 };
    return this.matchExact(node, pos, k);
  }

  /** Is this position strictly before the end of `endRun`, as pointers would be? */
  private beforeEnd(run: StrNode, idx: number, endRun: StrNode): boolean {
    if (run === endRun) return idx < this.unitsOf(run).length;
    return run.order < endRun.order;
  }

  /** The pattern character at a position, or null where it is program, not text. */
  private charAt(at: { run: StrNode; idx: number }): string | null {
    const units = this.unitsOf(at.run);
    return at.idx < units.length ? units[at.idx] : null;
  }

  private charEq(patChar: string, strChar: string, flags: GlobFlags): boolean {
    if (patChar === strChar) return true;
    if (flags.ignoreCase || this.settings.ignoreCase) {
      return patChar.toLowerCase() === strChar.toLowerCase();
    }
    if (flags.lcMatchUc) {
      // Lower case in the pattern matches either case in the subject.
      return patChar.toLowerCase() === patChar && patChar.toUpperCase() === strChar;
    }
    return false;
  }

  /**
   * Classifies the byte at `pos` the way `mbrtowc` does for zsh: a byte that
   * cannot be represented as a character is held as `0xDC00 + byte`, as
   * `WCHAR_INVALID` in Src/pattern.c does.  It is INCOMPLETE when the bytes
   * from here form a valid but truncated sequence, and INVALID otherwise.
   */
  /** Is `ch` one of the bytes that `member` is made of? */
  private byteOf(member: string, ch: string): boolean {
    const units = this.split(member);
    for (let i = 0; i < units.length; i++) if (units[i] === ch) return true;
    return false;
  }

  /** The two classes that are membership tests rather than character types. */
  private posixMembership(name: string, ch: string): boolean {
    return name === "IFS" ? this.settings.ifs.includes(ch) : " \t\n".includes(ch);
  }

  private byteClass(pos: number): "incomplete" | "invalid" | null {
    const byteAt = (i: number): number | null => {
      const ch = this.chars[i];
      if (ch === undefined || ch.length !== 1) return null;
      const code = ch.charCodeAt(0);
      return code >= 0xdc80 && code <= 0xdcff ? code - 0xdc00 : null;
    };
    const lead = byteAt(pos);
    if (lead === null) return null;

    let needed = 0;
    if ((lead & 0xe0) === 0xc0) needed = 2;
    else if ((lead & 0xf0) === 0xe0) needed = 3;
    else if ((lead & 0xf8) === 0xf0) needed = 4;
    else return "invalid"; // a continuation byte, or no valid lead at all

    for (let i = 1; i < needed; i++) {
      const next = byteAt(pos + i);
      if (next === null) {
        // The string ends inside the sequence, so it is merely truncated;
        // anything else here would have decoded as a character already.
        return pos + i >= this.len ? "incomplete" : "invalid";
      }
      if ((next & 0xc0) !== 0x80) return "invalid";
    }
    return "incomplete";
  }

  /**
   * Answers from the memo where it can.  `[[:INCOMPLETE:]]` and
   * `[[:INVALID:]]` ask about the bytes *around* the position rather than the
   * unit at it, so a class holding either is never memoised.
   */
  private classMatches(node: ClassNode, ch: string, pos: number): boolean {
    return this.classPredicate(node)(ch, pos);
  }

  /**
   * The accept-or-not test for one `[...]`, looked up once and then called
   * directly, so that the memo below costs an array index rather than a map
   * lookup on every unit it is asked about.
   */
  private classPredicate(node: ClassNode): StarFilter {
    let test = this.classTests.get(node);
    if (test !== undefined) return test;
    if (
      node.items.some(
        (item) => item.type === "posix" && (item.name === "INCOMPLETE" || item.name === "INVALID"),
      )
    ) {
      // These ask about the bytes around the position rather than the unit at
      // it, so the answer cannot be remembered per character.
      test = (ch, pos) => this.classTest(node, ch, pos);
    } else {
      const ascii = new Int8Array(128).fill(-1);
      const other = new Map<string, boolean>();
      test = (ch, pos) => {
        if (ch.length === 1) {
          const code = ch.charCodeAt(0);
          if (code < 128) {
            const known = ascii[code];
            if (known >= 0) return known === 1;
            const answer = this.classTest(node, ch, pos);
            ascii[code] = answer ? 1 : 0;
            return answer;
          }
        }
        const known = other.get(ch);
        if (known !== undefined) return known;
        const answer = this.classTest(node, ch, pos);
        // A subject of wholly distinct characters would otherwise grow this
        // without bound, and past a point the memo stops paying for itself.
        if (other.size < 1024) other.set(ch, answer);
        return answer;
      };
    }
    this.classTests.set(node, test);
    return test;
  }

  private classTest(node: ClassNode, ch: string, pos: number): boolean {
    let hit = false;
    const items = node.items;
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      switch (item.type) {
        case "char":
          // Without MULTIBYTE the subject is a byte, so a class member that
          // needs several bytes contributes each of them: zsh matches `é`
          // against `[åäö]` byte by byte.
          if (item.char === ch || (!this.settings.multibyte && this.byteOf(item.char, ch))) {
            hit = true;
          }
          break;
        case "range":
          if (ch >= item.from && ch <= item.to) hit = true;
          break;
        case "posix":
          if (this.posixMatches(item.name, ch, pos)) hit = true;
          break;
      }
      if (hit) break;
    }
    return node.negate ? !hit : hit;
  }

  private posixMatches(name: string, ch: string, pos: number): boolean {
    // Without MULTIBYTE the subject is a sequence of bytes, and the two kinds
    // of class part company.  `IDENT` and `WORD` go through zsh's own table,
    // whose entries for bytes above ASCII exist only in a build without
    // multibyte support (`inittyptab`, under `#ifndef MULTIBYTE_SUPPORT`), so
    // such a byte has no type at all.  The rest go to the C library's macros
    // on that byte, which this package reads as the Latin-1 character of the
    // same value -- deterministic, where zsh's answer follows the locale.
    if (!this.settings.multibyte && ch.charCodeAt(0) > 0x7f) {
      if (name === "IDENT") return false;
      if (name === "WORD") return this.settings.wordChars.includes(ch);
      if (name === "IFS" || name === "IFSSPACE") return this.posixMembership(name, ch);
    }
    switch (name) {
      case "alpha":
        return /\p{L}/u.test(ch);
      case "alnum":
        return /[\p{L}\p{Nd}]/u.test(ch);
      case "ascii":
        return ch.codePointAt(0)! < 0x80;
      case "blank":
        return ch === " " || ch === "\t";
      case "cntrl":
        return /\p{Cc}/u.test(ch);
      case "digit":
        return ch >= "0" && ch <= "9";
      case "graph":
        return !/[\s\p{Cc}\p{Cn}\p{Cs}]/u.test(ch);
      case "lower":
        return /\p{Ll}/u.test(ch);
      case "print":
        return !/[\p{Cc}\p{Cn}\p{Cs}]/u.test(ch);
      case "punct":
        return /[\p{P}\p{S}]/u.test(ch);
      case "space":
        return /\s/u.test(ch);
      case "upper":
        return /\p{Lu}/u.test(ch);
      case "xdigit":
        return /[0-9A-Fa-f]/.test(ch);
      case "IDENT":
        // Without POSIX_IDENTIFIERS an identifier may hold any alphanumeric,
        // so `é` counts; with it, only ASCII does.
        return this.settings.posixIdentifiers
          ? /[A-Za-z0-9_]/.test(ch)
          : /[\p{L}\p{Nd}_]/u.test(ch);
      case "IFS":
      case "IFSSPACE":
        return this.posixMembership(name, ch);
      case "WORD":
        return /[\p{L}\p{Nd}]/u.test(ch) || this.settings.wordChars.includes(ch);
      case "INCOMPLETE":
        // "Never true if not in multibyte mode" (Src/pattern.c).
        return this.settings.multibyte && this.byteClass(pos) === "incomplete";
      case "INVALID":
        return this.settings.multibyte && this.byteClass(pos) === "invalid";
      default:
        // UNKNOWN_CLASS: zsh treats a class it does not know as never matching.
        return false;
    }
  }
}

/** One closure's P_WBRANCH marks, and whether an entry to it is open. */
interface WbranchState {
  marks: Int32Array;
  live: boolean;
}

/** A test on a single unit: what a `*` may stop before, or what a closure repeats. */
type StarFilter = (ch: string, pos: number) => boolean;

/** `?` as a closure body: every unit qualifies. */
const TRUE_FILTER: StarFilter = () => true;

/** A sequence of nodes together with what is known about it in advance. */
interface SeqInfo {
  nodes: Node[];
  /** `mins[i]`: the least the units `nodes[i..]` can consume. */
  mins: Int32Array;
  /** `filters[i]`: for a `*` or simple closure at `i`, a test on the unit it stops before. */
  filters: (StarFilter | undefined)[];
  /** `simple[i]`: for a closure at `i` over one unit, the test that unit passes. */
  simple: (StarFilter | undefined)[];
  /** `plain[i]`: for a node that matches only one way, where it leaves off. */
  plain: (((pos: number) => number) | undefined)[];
  /** `alts[i]`: for an alternation at `i`, the sequences of its branches. */
  alts: (SeqInfo[] | undefined)[];
}

/** The largest error budget any node under here may spend. */
function altApprox(alt: AltNode): number {
  let most = 0;
  for (const branch of alt.branches) {
    for (const node of branch.seq) most = Math.max(most, nodeApprox(node));
    for (const seq of branch.excludes) {
      for (const node of seq) most = Math.max(most, nodeApprox(node));
    }
  }
  return most;
}

function nodeApprox(node: Node): number {
  switch (node.kind) {
    case "str":
    case "any":
    case "class":
    case "numrange":
      return node.flags.approx;
    case "repeat":
      return nodeApprox(node.body);
    case "alt":
      return altApprox(node);
    default:
      return 0;
  }
}

function isWildcard(node: Node): boolean {
  switch (node.kind) {
    case "any":
    case "star":
    case "class":
    case "numrange":
      return true;
    default:
      return false;
  }
}

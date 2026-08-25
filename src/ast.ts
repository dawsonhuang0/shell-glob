import type { GlobFlags } from "./options.js";

/** A branch of an alternation, together with any `~` exclusions applied to it. */
export interface Branch {
  seq: Node[];
  /** `x~y~z`: the text matched by `seq` must not match any of these. */
  excludes: Node[][];
  /**
   * The error budget in force at the end of each exclusion, which lets it
   * absorb trailing characters just as the whole pattern can: `(#a2)abc~(#a2)b`
   * excludes `abc`, since `b` reaches it with two errors to spend.
   */
  excludeApprox: number[];
}

export interface AltNode {
  kind: "alt";
  branches: Branch[];
  /** Backreference group number (1-based) when `(#b)` was active, else 0. */
  capture: number;
}

/** A run of literal characters. */
export interface StrNode {
  kind: "str";
  text: string;
  flags: GlobFlags;
  /**
   * Where this run sits in the compiled pattern, counting from the start.
   * zsh's `exactpos` and `exactend` are pointers into one buffer holding every
   * run in this order, and approximate matching can leave them in different
   * runs; the matcher compares these to work out which way round they are.
   */
  order: number;
}

/** `?` */
export interface AnyNode {
  kind: "any";
  flags: GlobFlags;
}

/** `*` */
export interface StarNode {
  kind: "star";
}

export type ClassItem =
  | { type: "char"; char: string }
  | { type: "range"; from: string; to: string }
  | { type: "posix"; name: string };

/** `[...]`, `[^...]`, `[!...]` */
export interface ClassNode {
  kind: "class";
  negate: boolean;
  items: ClassItem[];
  flags: GlobFlags;
}

/** `<x-y>`, `<->`, `<x->`, `<-y>` */
export interface NumRangeNode {
  kind: "numrange";
  from: bigint | null;
  to: bigint | null;
  flags: GlobFlags;
}

/** `x#`, `x##`, `x(#cN,M)` */
export interface RepeatNode {
  kind: "repeat";
  body: Node;
  min: number;
  /** `Infinity` for an unbounded closure. */
  max: number;
  /**
   * `(#cN,M)` rather than `#` or `##`.  zsh compiles the two to different
   * machines -- P_COUNT against a branch -- which differ in how they refuse a
   * zero length iteration, so the matcher keeps them apart.
   */
  counted?: boolean;
}

/** `(#s)` and `(#e)`: start- and end-of-string assertions. */
export interface AnchorNode {
  kind: "anchor";
  where: "start" | "end";
  flags: GlobFlags;
}

export type Node =
  | AltNode
  | StrNode
  | AnyNode
  | StarNode
  | ClassNode
  | NumRangeNode
  | RepeatNode
  | AnchorNode;

/** The result of compiling a pattern. */
export interface ParsedPattern {
  root: AltNode;
  /** Number of active `(#b)` groups, capped at 9 as in zsh. */
  ngroups: number;
  /** True if `(#m)` was in effect at the end of the pattern. */
  matchRef: boolean;
  /** Error budget in effect at the end of the pattern, from `(#aN)`. */
  approx: number;
  /** Text of a trailing `(#q...)` glob qualifier, if any. */
  qualifiers: string | null;
  /**
   * The pattern compiled to no nodes at all, so zsh holds it as `PAT_PURES`
   * with an empty string and compares it as one -- no globbing flag reaches
   * it.  A component like this is the empty component between two slashes.
   */
  pureEmpty: boolean;
}

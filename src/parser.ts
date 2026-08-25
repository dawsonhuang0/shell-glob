import type {
  AltNode,
  AnchorNode,
  Branch,
  ClassItem,
  Node,
  ParsedPattern,
} from "./ast.js";
import { ZshPatternError } from "./errors.js";
import { noFlags, type GlobFlags, type ZshOptions } from "./options.js";

/**
 * Splits a string into its UTF-8 bytes, carrying a byte above ASCII as
 * `0xDC00 + byte` so it survives as a single unit in a JavaScript string.
 */
function bytesOf(text: string): string[] {
  const out: string[] = [];
  for (const ch of text) {
    const code = ch.charCodeAt(0);
    if (ch.length === 1 && code >= 0xdc80 && code <= 0xdcff) {
      out.push(ch);
      continue;
    }
    for (const byte of new TextEncoder().encode(ch)) {
      out.push(byte < 0x80 ? String.fromCharCode(byte) : String.fromCharCode(0xdc00 + byte));
    }
  }
  return out;
}

/** Number of parenthesised groups zsh will record as backreferences. */
const NSUBEXP = 9;

const POSIX_CLASSES = new Set([
  "alpha", "alnum", "ascii", "blank", "cntrl", "digit", "graph",
  "lower", "print", "punct", "space", "upper", "xdigit",
  "IDENT", "IFS", "IFSSPACE", "INCOMPLETE", "INVALID", "WORD",
]);

/** Marker for a `[:...:]` class zsh does not know; it never matches. */
export const UNKNOWN_CLASS = "<unknown class>";

/**
 * Recursive descent parser mirroring zsh's `patcompswitch` (alternation and
 * `~` exclusion), `patcompbranch` (concatenation, `^` and globbing flags) and
 * `patcomppiece` (a single atom plus its `#`/`##`/`(#c..)` closure).
 */
class Parser {
  private i = 0;
  private depth = 0;
  /** Counts literal runs, so each knows where it sits in the compiled pattern. */
  private runs = 0;
  private flags: GlobFlags = { ...noFlags };
  private npar = 1;
  private qualifiers: string | null = null;

  constructor(
    private readonly pat: string,
    private readonly opt: ZshOptions,
    /** More of the word follows, as it does for every path component but the last. */
    private readonly moreFollows: boolean = false,
    headerPrefix = 0,
  ) {
    this.headerPrefix = headerPrefix;
  }

  /** Flags as the innermost group was entered; null at the top level. */
  private groupFlags: GlobFlags | null = null;
  /**
   * The error budget as `patglobflags` holds it at compile time, which is not
   * the same as the lexical one: an exclusion clears it there and nothing puts
   * it back.  A group emits the node that restores its flags only when they
   * ended up different from the ones it was entered with, so when an exclusion
   * has zeroed this the restore is skipped and the budget set inside the group
   * leaks out past it.
   */
  private compileApprox = 0;
  /**
   * Offset just past a header group the globber peeled off the front and put
   * back, so that the group after it is the one at `patstart`.  Set to -1 once
   * a header group has been seen, since only the first one counts.
   */
  private readonly headerPrefix: number;
  /** Did any group have to be emitted as a `P_GFLAGS` node? */
  private emitsFlagNode = false;

  parse(): ParsedPattern {
    const root = this.parseAlt(false);
    if (this.i < this.pat.length) this.fail(`unexpected '${this.peek()}'`);
    truncatePureString(root);
    // A pattern that compiled to no nodes at all is `PAT_PURES` with an empty
    // string, and zsh compares it as one: no flag reaches it, so `(#a1)`
    // matches only the empty string.  One `P_GFLAGS` node is enough to stop
    // that, which is why `(#a1)(#i)(#a1)` matches `a` and `(#a1)(#a1)` does
    // not -- the `(#i)` in the middle changes something and is emitted.
    const [only] = root.branches;
    const pureEmpty =
      !this.emitsFlagNode &&
      root.branches.length === 1 &&
      only.seq.length === 0 &&
      only.excludes.length === 0;
    return {
      root,
      pureEmpty,
      ngroups: Math.min(this.npar - 1, NSUBEXP),
      matchRef: this.flags.matchRef,
      approx: this.flags.approx,
      qualifiers: this.qualifiers,
    };
  }

  // ---------------------------------------------------------------- helpers

  private fail(msg: string): never {
    throw new ZshPatternError(msg, this.pat, this.i);
  }

  private peek(off = 0): string {
    return this.pat[this.i + off] ?? "";
  }

  private eof(): boolean {
    return this.i >= this.pat.length;
  }

  /** True if `c` is currently active as a pattern operator. */
  private isSpecial(c: string): boolean {
    switch (c) {
      case "*":
      case "?":
      case "[":
        return true;
      case "|":
        // `zshtokenize()` in Src/glob.c never tokenizes `(`, `|` or `)` when
        // SH_GLOB is set, so none of them can be an operator: `a|b` and
        // `(a|b)` match only themselves.
        return !this.opt.shGlob;
      case "(":
      case "<":
        return !this.opt.shGlob;
      case ")":
        // A `)` is always an operator: compiling `a)b` as a pattern is an
        // error.  `haswilds()` in Src/pattern.c, which does not count Outpar,
        // gates *filename generation* rather than compilation -- which is why
        // `a)b` is a bad pattern for `[[ ]]` but an ordinary word as a glob.
        // The globber applies that gate itself, in `hasWilds`.
        return !this.opt.shGlob;
      case "^":
      case "#":
      case "~":
        return this.opt.extendedGlob;
      default:
        return false;
    }
  }

  /**
   * A `~` only introduces an exclusion when something can follow it: `foo~`,
   * `foo~|bar` and `(foo~)` all contain a literal tilde.
   */
  private tildeIsSpecial(): boolean {
    if (!this.opt.extendedGlob || this.peek() !== "~") return false;
    const next = this.peek(1);
    if (next === "/") return true;
    if (next === "" || next === "|" || next === "~") return false;
    if (next === ")" && this.isSpecial(")")) return false;
    return true;
  }

  /** True at a `(#` (or `@(#` under KSH_GLOB) introducing globbing flags. */
  private atGlobFlags(): boolean {
    if (!this.opt.extendedGlob || this.opt.shGlob) return false;
    if (this.peek() === "(" && this.peek(1) === "#" && this.peek(2) !== "c") return true;
    if (
      this.kshEnabled() &&
      this.peek() === "@" &&
      this.peek(1) === "(" &&
      this.peek(2) === "#" &&
      this.peek(3) !== "c"
    ) {
      return true;
    }
    return false;
  }

  /**
   * KSH_GLOB needs a `(` to attach to, and under SH_GLOB `zshtokenize()`
   * never produces one, so `*(ab)` matches the literal string `*(ab)` even
   * with KSH_GLOB set.  (zsh's lexer path keeps ksh forms alive under
   * SH_GLOB; a pattern built from a string, as here, goes through
   * `shtokenize` instead.)
   */
  private kshEnabled(): boolean {
    return this.opt.kshGlob && !this.opt.shGlob;
  }

  /** The ksh-glob operator in front of a `(`, if KSH_GLOB is in force. */
  private kshChar(): string | null {
    if (!this.kshEnabled()) return null;
    if (this.peek(1) !== "(") return null;
    const c = this.peek();
    return c === "@" || c === "*" || c === "+" || c === "?" || c === "!" ? c : null;
  }

  private atBranchEnd(): boolean {
    if (this.eof()) return true;
    const c = this.peek();
    if (c === "|" && this.isSpecial("|")) return true;
    if (c === ")" && this.isSpecial(")")) return true;
    return this.tildeIsSpecial();
  }

  // ------------------------------------------------------------ productions

  /** `patcompswitch`: `branch ( '|' branch | '~' exclusion )*` */
  private parseAlt(inParen: boolean): AltNode {
    if (inParen) this.depth++;
    const outerFlags = { ...this.flags };
    // Inside parentheses a `^` exclusion is compiled through `patcompswitch`
    // rather than `patcompbranch`, and comes out matching with the flags the
    // group was entered with: `((#i)^ab)` does not exclude `aB`, while the
    // same flag from outside -- `(#i)(^ab)` or top level `(#i)^ab` -- does.
    const outerGroupFlags = this.groupFlags;
    const entryCompileApprox = this.compileApprox;
    if (inParen) this.groupFlags = { ...this.flags };
    let capture = 0;
    // Only groups compiled while `(#b)` is active are numbered at all, so
    // `(a|an)_(#b)(*)` records one group, not two.
    if (inParen && this.flags.backref && this.npar <= NSUBEXP) {
      capture = this.npar++;
    }

    const branches: Branch[] = [];
    let current: Branch = { seq: this.parseSeq(), excludes: [], excludeApprox: [] };
    branches.push(current);
    // "if (patglobflags != savglobflags) gfchanged++" is evaluated once each
    // branch is compiled and before that branch's exclusions, so an exclusion
    // of this group's own does not count -- only one nested inside it, whose
    // clearing happened while the branch was being compiled.
    let gfChanged = this.branchChangedFlags(entryCompileApprox, outerFlags);

    for (;;) {
      if (this.tildeIsSpecial()) {
        this.i++;
        // Approximation is switched off inside an exclusion unless it is asked
        // for again there; other flags from the branch carry over.
        const saved = { ...this.flags };
        this.flags.approx = 0;
        // "patglobflags &= ~0xff" before the exclusion is compiled, and
        // nothing restores it.
        this.compileApprox = 0;
        current.excludes.push(this.parseSeq());
        current.excludeApprox.push(this.flags.approx);
        this.flags = saved;
        continue;
      }
      if (this.peek() === "|" && this.isSpecial("|")) {
        this.i++;
        // Flags do not leak from one branch into the next: a group restores
        // the flags it was entered with, while at the top level zsh resets
        // them, so that `(#i)foo|bar` applies the flag to `foo` alone.
        this.flags = inParen ? { ...outerFlags } : { ...noFlags };
        current = { seq: this.parseSeq(), excludes: [], excludeApprox: [] };
        branches.push(current);
        if (this.branchChangedFlags(entryCompileApprox, outerFlags)) gfChanged = true;
        continue;
      }
      break;
    }

    if (inParen) {
      if (this.peek() !== ")") this.fail("unmatched '('");
      this.i++;
      this.depth--;
      // "Restore old values of flags when leaving parentheses" -- but only if
      // `gfchanged`, that is if they actually ended up different.  An
      // exclusion inside the group zeroes the compile time budget, and where
      // that leaves the flags looking unchanged no restoring node is emitted,
      // so what the group set stays in force after it.
      if (gfChanged) this.flags = { ...outerFlags };
    }
    this.groupFlags = outerGroupFlags;

    return { kind: "alt", branches, capture };
  }

  /** Did compiling a branch leave the flags different from the group's? */
  private branchChangedFlags(entryApprox: number, outerFlags: GlobFlags): boolean {
    return this.compileApprox !== entryApprox || !sameOtherFlags(this.flags, outerFlags);
  }

  /** `patcompbranch`: a concatenation of pieces. */
  private parseSeq(): Node[] {
    const seq: Node[] = [];

    while (!this.atBranchEnd()) {
      if (this.atGlobFlags()) {
        const at = this.i;
        const before = { ...this.flags };
        const beforeCompile = this.compileApprox;
        const anchor = this.parseGlobFlags();
        this.compileApprox = this.flags.approx;
        if (anchor) {
          // "Start/end assertion looking like flags, but actually handled as a
          // normal node": the end rule below does not apply to these.
          seq.push(anchor);
        } else if (at === 0 || at === this.headerPrefix) {
          // "Right at start of pattern, the simplest case.  Put them into the
          // flags and don't emit anything."  A group the globber peeled off
          // the front and put back is part of that header too, so the group
          // just after it is the one `patstart` really points at.  Both are
          // offsets, and only one group can begin at each.
        } else if (this.eof() && !this.moreFollows) {
          this.compileApprox = beforeCompile;
          // "Right at the end, so just leave the flags for the next Patprog in
          // the chain to pick up."  Nothing is emitted, so they do not apply
          // here: `??(#a1)` does not match `sub`, while `??(#a1)/x` matches
          // `sub/x`, the flags being mid-word there.
          this.flags = before;
        } else if (!sameFlags(before, this.flags)) {
          // "Otherwise, we have to stick them in as a pattern matching
          // nothing" -- a `P_GFLAGS` node.  It matches no text, but it is a
          // node, so the pattern is no longer the empty pure string and the
          // flags it sets are in force when the end is reached.  A group that
          // changes nothing emits nothing ("No effect").
          this.emitsFlagNode = true;
        }
        continue;
      }
      if (this.peek() === "^" && this.isSpecial("^")) {
        // `^x` is `(*~x)`, with the exclusion running to the end of the branch.
        // It is an exclusion in every respect, so approximation is switched
        // off inside it unless asked for again there, exactly as for `~`:
        // `(#a1)^ab` does not exclude `ac`, while `^(#a1)ab` does.
        this.i++;
        const savedFlags = { ...this.flags };
        // Only the `~` in `patcompswitch` clears the compile time budget;
        // `patcompnot` leaves `patglobflags` alone, so a `^` does not make a
        // group skip its restore.
        this.flags = { ...(this.groupFlags ?? this.flags), approx: 0 };
        const rest = this.parseSeq();
        // The budget the exclusion itself ends with, not the one outside it.
        const restApprox = this.flags.approx;
        this.flags = savedFlags;
        seq.push({
          kind: "alt",
          capture: 0,
          branches: [
            { seq: [{ kind: "star" }], excludes: [rest], excludeApprox: [restApprox] },
          ],
        });
        break;
      }
      for (const node of this.parsePiece()) seq.push(node);
    }

    return seq;
  }

  /**
   * `patcomppiece`: one atom plus a trailing `#`, `##` or `(#cN,M)`.
   * Returns two nodes when a literal run has to be split so that the closure
   * binds to its last character only (`12#` is `1(2#)`, not `(12)#`).
   */
  private parsePiece(): Node[] {
    const ksh = this.kshChar();
    if (ksh) {
      this.i += 2; // the operator and its '('
      const body = this.parseAlt(true);
      const atom = this.applyKsh(ksh, body);
      // None of them may take a further closure: `kshchar` is set for every
      // one of `@( *( +( ?( !(`, and "too much at once doesn't currently
      // work" -- `if (kshchar && (hash || count)) return 0` in patcomppiece.
      return this.withClosure(atom, null, "a ksh glob operator");
    }

    const c = this.peek();
    if (c === "?") {
      this.i++;
      return this.withClosure({ kind: "any", flags: { ...this.flags } }, null);
    }
    if (c === "*") {
      this.i++;
      // A run of `*` matches exactly what one `*` matches, but trying every
      // way to split the string between them is exponential, so collapse them.
      // zsh does the same; see "Optimisation to squeeze multiple *'s used as
      // ordinary glob wildcards" in its Test/D02glob.ztst.
      while (this.peek() === "*") this.i++;
      // `case Star: kshchar = -1` -- "used as a sign that we can't have #'s".
      // `(*)#` is fine; the group is what the closure applies to.
      return this.withClosure({ kind: "star" }, null, "'*'");
    }
    if (c === "[") {
      return this.withClosure(this.parseClass(), null);
    }
    if (c === "(" && this.isSpecial("(")) {
      this.i++;
      return this.withClosure(this.parseAlt(true), null);
    }
    if (c === "<" && this.isSpecial("<") && this.lookingAtNumRange()) {
      return this.withClosure(this.parseNumRange(), null);
    }
    if (c === "#" && this.isSpecial("#")) {
      this.fail("nothing to repeat before '#'");
    }

    const text = this.parseLiteralRun();
    if (text.length === 0) this.fail(`unexpected '${c}'`);
    if (this.atClosure()) {
      // A closure binds to the last *unit* of the run, and without MULTIBYTE a
      // unit is a byte: `é#` repeats the second byte of `é`, not the whole
      // character.  A byte above ASCII is carried as `0xDC00 + byte`, which
      // the matcher reads back as that byte.
      const chars = this.opt.multibyte ? [...text] : bytesOf(text);
      const last = chars.pop()!;
      // The lead is numbered first: `order` has to follow the order the runs
      // appear in the pattern, which is the order zsh lays them out in the
      // compiled program, and not the order this parser happens to build them.
      const leadOrder = chars.length > 0 ? this.runs++ : -1;
      const atom: Node = {
        kind: "str",
        text: last,
        flags: { ...this.flags },
        order: this.runs++,
      };
      const lead: Node | null =
        chars.length > 0
          ? { kind: "str", text: chars.join(""), flags: { ...this.flags }, order: leadOrder }
          : null;
      return this.withClosure(atom, lead);
    }
    return [{ kind: "str", text, flags: { ...this.flags }, order: this.runs++ }];
  }

  private applyKsh(ksh: string, body: AltNode): Node {
    switch (ksh) {
      case "@":
        return body;
      case "*":
        return { kind: "repeat", body, min: 0, max: Infinity };
      case "+":
        return { kind: "repeat", body, min: 1, max: Infinity };
      case "?":
        return {
          kind: "alt",
          capture: 0,
          branches: [
            { seq: [], excludes: [], excludeApprox: [] },
            { seq: [body], excludes: [], excludeApprox: [] },
          ],
        };
      default: // '!'
        return {
          kind: "alt",
          capture: 0,
          branches: [
            // `!(x)` is an exclusion too, and approximation is off inside one.
            { seq: [{ kind: "star" }], excludes: [[body]], excludeApprox: [0] },
          ],
        };
    }
  }

  private atClosure(): boolean {
    return (this.isSpecial("#") && this.peek() === "#") || this.atCount();
  }

  private atCount(): boolean {
    if (!this.opt.extendedGlob || this.opt.shGlob) return false;
    if (this.peek() === "(" && this.peek(1) === "#" && this.peek(2) === "c") return true;
    return (
      this.kshEnabled() &&
      this.peek() === "@" &&
      this.peek(1) === "(" &&
      this.peek(2) === "#" &&
      this.peek(3) === "c"
    );
  }

  /**
   * Applies a trailing `#`, `##` or `(#cN,M)` to the piece just parsed.
   * `noClosure` names the thing that cannot take one, for the error.
   */
  private withClosure(atom: Node, lead: Node | null, noClosure?: string): Node[] {
    let node = atom;
    if (noClosure !== undefined) {
      if ((this.isSpecial("#") && this.peek() === "#") || this.atCount()) {
        this.fail(`a closure may not follow ${noClosure}`);
      }
      return lead ? [lead, atom] : [atom];
    }
    if (this.isSpecial("#") && this.peek() === "#") {
      this.i++;
      let min = 0;
      if (this.peek() === "#") {
        this.i++;
        min = 1;
      }
      if (this.peek() === "#") this.fail("no more than two '#' may appear together");
      node = { kind: "repeat", body: atom, min, max: Infinity };
    } else if (this.atCount()) {
      node = this.parseCount(atom);
    }
    return lead ? [lead, node] : [node];
  }

  /** `(#cN,M)`, `(#cN)`, `(#c,M)`, `(#cN,)` */
  private parseCount(atom: Node): Node {
    this.i += this.peek() === "@" ? 4 : 3; // past `(#c`
    const digits = (): number | null => {
      const start = this.i;
      while (/[0-9]/.test(this.peek())) this.i++;
      return this.i > start ? Number(this.pat.slice(start, this.i)) : null;
    };
    const lo = digits();
    let min: number;
    let max: number;
    if (this.peek() === ",") {
      this.i++;
      const hi = digits();
      min = lo ?? 0;
      max = hi ?? Infinity;
    } else {
      // "missing number treated as zero", so `(#c)` is "none of these".
      min = lo ?? 0;
      max = min;
    }
    if (this.peek() !== ")") this.fail("unterminated '(#c...)'");
    this.i++;
    // No check that the range runs the right way: zsh compiles `(#c2,1)` and
    // it simply matches nothing, which is not the same as refusing it.
    return { kind: "repeat", body: atom, min, max, counted: true };
  }

  /** A run of ordinary characters, stopping at the next active operator. */
  private parseLiteralRun(): string {
    let out = "";
    while (!this.eof()) {
      const c = this.peek();
      if (c === "\\") {
        if (this.i + 1 >= this.pat.length) {
          out += "\\";
          this.i++;
          break;
        }
        // `zshtokenize()` leaves `(`, `|`, `)` and `<` untokenized under
        // SH_GLOB by breaking out of their cases before the pending backslash
        // is applied, so the backslash stays an ordinary character there:
        // `?*\)` matches `x\)` rather than `x)`.
        if (this.opt.shGlob && "(|)<".includes(this.pat[this.i + 1])) {
          out += "\\";
          this.i++;
          continue;
        }
        const cp = String.fromCodePoint(this.pat.codePointAt(this.i + 1)!);
        out += cp;
        this.i += 1 + cp.length;
        continue;
      }
      if (this.kshChar() || this.atGlobFlags() || this.atCount()) break;
      if (this.isSpecial(c)) {
        if (c === "~" && !this.tildeIsSpecial()) {
          out += c;
          this.i++;
          continue;
        }
        if (c === "<" && !this.lookingAtNumRange()) {
          out += c;
          this.i++;
          continue;
        }
        break;
      }
      const cp = String.fromCodePoint(this.pat.codePointAt(this.i)!);
      out += cp;
      this.i += cp.length;
    }
    return out;
  }

  private lookingAtNumRange(): boolean {
    return /^<[0-9]*-[0-9]*>/.test(this.pat.slice(this.i));
  }

  private parseNumRange(): Node {
    const m = /^<([0-9]*)-([0-9]*)>/.exec(this.pat.slice(this.i))!;
    this.i += m[0].length;
    return {
      kind: "numrange",
      from: m[1] ? BigInt(m[1]) : null,
      to: m[2] ? BigInt(m[2]) : null,
      flags: { ...this.flags },
    };
  }


  private parseClass(): Node {
    this.i++; // '['
    let negate = false;
    if (this.peek() === "^" || this.peek() === "!") {
      negate = true;
      this.i++;
    }
    const items: ClassItem[] = [];
    // `[]...]` matches a literal `]`, but only if the bracket closes later on.
    if (this.peek() === "]" && this.pat.indexOf("]", this.i + 1) !== -1) {
      items.push({ type: "char", char: "]" });
      this.i++;
    }
    while (!this.eof() && this.peek() !== "]") {
      if (this.peek() === "[" && this.peek(1) === ":") {
        const end = this.pat.indexOf(":]", this.i + 2);
        if (end !== -1) {
          const name = this.pat.slice(this.i + 2, end);
          this.i = end + 2;
          items.push({
            type: "posix",
            name: POSIX_CLASSES.has(name) ? name : UNKNOWN_CLASS,
          });
          continue;
        }
      }
      const from = this.readClassChar();
      if (this.peek() === "-" && this.peek(1) !== "" && this.peek(1) !== "]") {
        this.i++;
        items.push({ type: "range", from, to: this.readClassChar() });
      } else {
        items.push({ type: "char", char: from });
      }
    }
    if (this.peek() !== "]") this.fail("unmatched '['");
    this.i++;
    return { kind: "class", negate, items, flags: { ...this.flags } };
  }

  private readClassChar(): string {
    if (this.peek() === "\\" && this.i + 1 < this.pat.length) this.i++;
    const cp = String.fromCodePoint(this.pat.codePointAt(this.i)!);
    this.i += cp.length;
    return cp;
  }

  /**
   * `patgetglobflags`.  Returns an anchor node for `(#s)`/`(#e)`; every other
   * flag mutates the lexically scoped flag set and emits nothing.
   */
  private parseGlobFlags(): AnchorNode | null {
    this.i += this.peek() === "@" ? 3 : 2; // past `(#`
    const bodyStart = this.i;
    let anchor: AnchorNode | null = null;

    while (!this.eof() && this.peek() !== ")") {
      const c = this.peek();
      if (c === "q") {
        // Glob qualifiers: ignored by the matcher, picked up by the filename
        // generation code.
        const end = this.pat.indexOf(")", this.i);
        if (end === -1) this.fail("unterminated glob qualifier");
        this.qualifiers = this.pat.slice(this.i + 1, end);
        this.i = end;
        break;
      }
      this.i++;
      switch (c) {
        case "a": {
          const start = this.i;
          while (/[0-9]/.test(this.peek())) this.i++;
          if (this.i === start) this.fail("'(#a)' needs a number");
          const n = Number(this.pat.slice(start, this.i));
          if (n > 254) this.fail("'(#a)' allows at most 254 errors");
          this.flags.approx = n;
          break;
        }
        case "l":
          this.flags.ignoreCase = false;
          this.flags.lcMatchUc = true;
          break;
        case "i":
          this.flags.lcMatchUc = false;
          this.flags.ignoreCase = true;
          break;
        case "I":
          this.flags.ignoreCase = false;
          this.flags.lcMatchUc = false;
          break;
        case "b":
          this.flags.backref = true;
          break;
        case "B":
          this.flags.backref = false;
          break;
        case "m":
          this.flags.matchRef = true;
          break;
        case "M":
          this.flags.matchRef = false;
          break;
        case "s":
          anchor = { kind: "anchor", where: "start", flags: { ...this.flags } };
          break;
        case "e":
          anchor = { kind: "anchor", where: "end", flags: { ...this.flags } };
          break;
        case "u":
        case "U":
          // Whether a string is a sequence of code points or of code units is
          // decided by the `multibyte` option here, so both flags are parsed
          // and then ignored.
          break;
        default:
          this.fail(`unknown globbing flag '${c}'`);
      }
    }
    if (this.peek() !== ")") this.fail("unterminated globbing flags");
    if (anchor && this.i !== bodyStart + 1) {
      this.fail("'(#s)' and '(#e)' must appear on their own");
    }
    this.i++;
    return anchor;
  }
}

/**
 * A pattern that is nothing but literal text is compiled to a plain string and
 * compared as one -- and the code that extracts it takes the first run and
 * stops, on the comment "Only one string in a PAT_PURES, so now done".
 *
 * A globbing flag group that changes nothing is dropped without emitting
 * anything ("No effect", `continue` in `patcompbranch`), so it splits the text
 * into two runs while leaving it a pure string.  The second run is then never
 * looked at: `a(#a0)b` matches `a` and not `ab`.  A group that does change
 * something emits a `P_GFLAGS` node instead, which is why `a(#i)b` is fine.
 *
 * Reproduced here so that a pattern means what zsh makes it mean.  It needs a
 * redundant flag group inside otherwise wholly literal text, which is why it
 * takes a generated corpus to find.
 */
function truncatePureString(root: AltNode): void {
  if (root.branches.length !== 1) return;
  const [branch] = root.branches;
  if (branch.excludes.length > 0 || branch.seq.length < 2) return;
  const first = branch.seq[0];
  if (first.kind !== "str") return;
  for (const node of branch.seq) {
    // Any other kind of node clears P_PURESTR, and so does a flag group that
    // took effect -- which shows up here as a run whose flags differ.
    if (node.kind !== "str") return;
    if (!sameFlags(node.flags, first.flags)) return;
    // "It's much simpler to turn off pure string mode for any
    // case-insensitive or approximate matching": a run compiled while any of
    // those is in force is not a pure string, so `(#i)a(#i).txt` keeps both
    // of its runs even though the second flag group changed nothing.
    const { approx, ignoreCase, lcMatchUc } = node.flags;
    if (approx > 0 || ignoreCase || lcMatchUc) return;
  }
  branch.seq.length = 1;
}

/** Every flag but the error budget, which is compared separately. */
function sameOtherFlags(a: GlobFlags, b: GlobFlags): boolean {
  return (
    a.ignoreCase === b.ignoreCase &&
    a.lcMatchUc === b.lcMatchUc &&
    a.backref === b.backref &&
    a.matchRef === b.matchRef
  );
}

function sameFlags(a: GlobFlags, b: GlobFlags): boolean {
  return (
    a.ignoreCase === b.ignoreCase &&
    a.lcMatchUc === b.lcMatchUc &&
    a.backref === b.backref &&
    a.matchRef === b.matchRef &&
    a.approx === b.approx
  );
}

export function parsePattern(
  pattern: string,
  opt: ZshOptions,
  moreFollows = false,
  headerPrefix = 0,
): ParsedPattern {
  return new Parser(pattern, opt, moreFollows, headerPrefix).parse();
}

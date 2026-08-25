import { evaluateArith } from "./arith.js";
import { ZshPatternError } from "./errors.js";
import type { GlobStats } from "./fs.js";

/** `MAX_SORTS` in Src/glob.c: how many `o`/`O` specifiers a list may hold. */
const MAX_SORTS = 12;

/** Everything a qualifier can ask about one candidate file. */
export interface QualContext {
  /** Path as it will be reported, relative to `cwd` unless `absolute` is set. */
  path: string;
  /** Absolute path, for hooks that want to touch the file. */
  fullPath: string;
  /** Base name. */
  name: string;
  lstat: GlobStats | null;
  /** `stat`, i.e. following symlinks; `null` when it fails. */
  stat: GlobStats | null;
  /** Set only when a qualifier needed it: does this directory hold entries? */
  emptyDir: boolean;
  /** Reference time for the `a`, `m` and `c` qualifiers. */
  now: number;
}

export type QualTest = (ctx: QualContext) => boolean;

export interface SortSpec {
  key: "n" | "L" | "l" | "a" | "m" | "c" | "d" | "N" | "e";
  desc: boolean;
  /** Shell code for `oe`/`o+`, passed to the `sortKey` hook. */
  code?: string;
}

/** Hooks for the qualifiers that would otherwise run shell code. */
export interface QualifierHooks {
  /** `e:code:` and `+cmd`: return true to keep the file. */
  evaluate?: (code: string, ctx: QualContext) => boolean;
  /** `oe:code:` and `o+cmd`: return the string to sort on. */
  sortKey?: (code: string, ctx: QualContext) => string;
  /** `u:name:`: map a user name to a uid. */
  resolveUser?: (name: string) => number;
  /** `g:name:`: map a group name to a gid. */
  resolveGroup?: (name: string) => number;
}

export interface Qualifiers {
  /** Disjunction of conjunctions: `*(.,/)` is "plain files or directories". */
  groups: QualTest[][];
  markDirs: boolean;
  listTypes: boolean;
  nullGlob: boolean;
  globDots: boolean;
  numericSort: boolean;
  /** `Yn`: stop after this many matches. */
  limit: number | null;
  sorts: SortSpec[];
  subscript: { beg: number; end: number | null } | null;
  prepend: string[];
  append: string[];
  /** Colon modifiers, in the order they were given. */
  modifiers: string[];
  needsStat: boolean;
  needsReaddir: boolean;
}

export function emptyQualifiers(): Qualifiers {
  return {
    groups: [],
    markDirs: false,
    listTypes: false,
    nullGlob: false,
    globDots: false,
    numericSort: false,
    limit: null,
    sorts: [],
    subscript: null,
    prepend: [],
    append: [],
    modifiers: [],
    needsStat: false,
    needsReaddir: false,
  };
}

const UNITS: Record<string, number> = { M: 2592000, w: 604800, d: 86400, h: 3600, m: 60, s: 1 };
const SIZE_UNITS: Record<string, number> = {
  k: 1024, K: 1024,
  m: 1048576, M: 1048576,
  p: 512, P: 512,
  g: 1073741824, G: 1073741824,
  t: 1099511627776, T: 1099511627776,
};

/** `(`, `[`, `{` and `<` are closed by their partner; anything else by itself. */
/**
 * Splits a subscript at its top level comma, the one `getarg` stops at:
 * "(c != Outbrack && (ishash || c != ',')) || i || inpar", where `i` counts
 * brackets and `inpar` parentheses.  So `[(1,2)]` is one expression using the
 * comma operator, not a range.
 */
function splitSubscript(body: string): [string, string | undefined] {
  let brackets = 0;
  let parens = 0;
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (c === "[") brackets++;
    else if (c === "]") brackets--;
    else if (c === "(") parens++;
    else if (c === ")") parens--;
    else if (c === "," && brackets === 0 && parens === 0) {
      return [body.slice(0, i), body.slice(i + 1)];
    }
  }
  return [body, undefined];
}

function closerFor(open: string): string {
  return { "(": ")", "[": "]", "{": "}", "<": ">" }[open] ?? open;
}

/**
 * Parses a glob qualifier list, i.e. the text inside the trailing `(...)` or
 * `(#q...)` of a filename generation pattern.
 */
export function parseQualifiers(
  text: string,
  pattern: string,
  hooks: QualifierHooks = {},
): Qualifiers {
  const q = emptyQualifiers();
  let i = 0;
  /** Current conjunction; `^` and `-` are running modifiers within it. */
  let group: QualTest[] = [];
  let negate = false;
  /** Sort keys already given, for the doubled-specifier test. */
  const seenSorts = new Set<string>();
  let follow = false;

  function fail(msg: string): never {
    throw new ZshPatternError(msg, pattern, i, "qualifier");
  }

  const add = (test: (ctx: QualContext, st: GlobStats | null) => boolean): void => {
    const wantFollow = follow;
    const wantNegate = negate;
    if (wantFollow) q.needsStat = true;
    group.push((ctx) => {
      const st = wantFollow ? (ctx.stat ?? ctx.lstat) : ctx.lstat;
      const hit = st !== null && test(ctx, st);
      return wantNegate ? !hit : hit;
    });
  };

  const peek = (off = 0): string => text[i + off] ?? "";

  /** A number, possibly preceded by `+` or `-` to make it a range test. */
  const readRange = (): { range: -1 | 0 | 1; value: number } => {
    let range: -1 | 0 | 1 = 0;
    if (peek() === "+") {
      range = 1;
      i++;
    } else if (peek() === "-") {
      range = -1;
      i++;
    }
    const start = i;
    while (/[0-9]/.test(peek())) i++;
    if (i === start) fail("number expected");
    return { range, value: Number(text.slice(start, i)) };
  };

  const compare = (value: number, range: number, want: number): boolean =>
    range < 0 ? value < want : range > 0 ? value > want : value === want;

  /**
   * How zsh words a missing or unterminated argument, which depends on which
   * qualifier wanted it: `u` and `g` name themselves, the ones that take shell
   * code go through `glob_exec_string`, and `f` through `qgetmodespec`.
   */
  const missingText = (what: string): string =>
    what === "u" || what === "g"
      ? `missing delimiter for '${what}' glob qualifier`
      : what === "f"
        ? "invalid mode specification"
        : "missing end of string";

  /** Text delimited the way the `e`, `u`, `g`, `P` and `f` qualifiers delimit it. */
  const readDelimited = (what: string): string => {
    const open = peek();
    if (!open) fail(missingText(what));
    const close = closerFor(open);
    i++;
    const start = i;
    let depth = 1;
    while (i < text.length) {
      if (open !== close && text[i] === open) depth++;
      else if (text[i] === close && --depth === 0) break;
      i++;
    }
    if (i >= text.length) fail(missingText(what));
    const body = text.slice(start, i);
    i++;
    return body;
  };

  const modeTest = (bits: number): void => add((_ctx, st) => (st!.mode & bits) === bits);

  while (i < text.length) {
    const c = text[i++];
    switch (c) {
      case ",":
        // A new alternative: `^` and `-` do not carry over.
        q.groups.push(group);
        group = [];
        negate = false;
        follow = false;
        break;
      case ":":
        // The rest of the list is colon modifiers.
        q.modifiers = text
          .slice(i - 1)
          .split(":")
          .filter((m) => m.length > 0);
        i = text.length;
        break;
      case "^":
        negate = !negate;
        break;
      case "-":
        follow = !follow;
        break;

      // ------------------------------------------------------------- types
      case "/":
        add((_c, st) => st!.isDirectory());
        break;
      case ".":
        add((_c, st) => st!.isFile());
        break;
      case "@":
        add((_c, st) => st!.isSymbolicLink());
        break;
      case "=":
        add((_c, st) => st!.isSocket());
        break;
      case "p":
        add((_c, st) => st!.isFIFO());
        break;
      case "%":
        if (peek() === "b") {
          i++;
          add((_c, st) => st!.isBlockDevice());
        } else if (peek() === "c") {
          i++;
          add((_c, st) => st!.isCharacterDevice());
        } else {
          add((_c, st) => st!.isBlockDevice() || st!.isCharacterDevice());
        }
        break;
      case "*":
        add((_c, st) => st!.isFile() && (st!.mode & 0o111) !== 0);
        break;
      case "F":
        q.needsReaddir = true;
        add((ctx, st) => st!.isDirectory() && !ctx.emptyDir);
        break;

      // ------------------------------------------------------- permissions
      case "r": modeTest(0o400); break;
      case "w": modeTest(0o200); break;
      case "x": modeTest(0o100); break;
      case "A": modeTest(0o040); break;
      case "I": modeTest(0o020); break;
      case "E": modeTest(0o010); break;
      case "R": modeTest(0o004); break;
      case "W": modeTest(0o002); break;
      case "X": modeTest(0o001); break;
      case "s": modeTest(0o4000); break;
      case "S": modeTest(0o2000); break;
      case "t": modeTest(0o1000); break;
      case "f":
        add(makePermissionTest(readPermissionSpec(), pattern));
        break;

      // ------------------------------------------------------ ownership etc
      case "d": {
        const { value } = readRange();
        add((_c, st) => st!.dev === value);
        break;
      }
      case "l": {
        const { range, value } = readRange();
        add((_c, st) => compare(st!.nlink, range, value));
        break;
      }
      case "U": {
        const uid = typeof process !== "undefined" && process.getuid ? process.getuid() : 0;
        add((_c, st) => st!.uid === uid);
        break;
      }
      case "G": {
        const gid = typeof process !== "undefined" && process.getgid ? process.getgid() : 0;
        add((_c, st) => st!.gid === gid);
        break;
      }
      case "u": {
        const id = readId("u", hooks.resolveUser);
        add((_c, st) => st!.uid === id);
        break;
      }
      case "g": {
        const id = readId("g", hooks.resolveGroup);
        add((_c, st) => st!.gid === id);
        break;
      }

      // ------------------------------------------------------- time and size
      case "a":
      case "m":
      case "c": {
        let unit = UNITS.d;
        if (peek() in UNITS) unit = UNITS[text[i++]];
        const { range, value } = readRange();
        const field = c === "a" ? "atimeMs" : c === "m" ? "mtimeMs" : "ctimeMs";
        add((ctx, st) => {
          const diff = Math.floor((ctx.now - st![field]) / 1000 / unit);
          return compare(diff, range, value);
        });
        break;
      }
      case "L": {
        let unit = 1;
        if (peek() in SIZE_UNITS) unit = SIZE_UNITS[text[i++]];
        const { range, value } = readRange();
        add((_c, st) => compare(Math.ceil(st!.size / unit), range, value));
        break;
      }

      // ----------------------------------------------------- shell code hooks
      case "e":
      case "+": {
        const code = c === "e" ? readDelimited("e") : readWord();
        const evaluate = hooks.evaluate;
        if (!evaluate) {
          // Not a zsh error: zsh would just run the code.
          throw new ZshPatternError(
            `the '${c}' glob qualifier runs shell code; supply a 'qualifierHooks.evaluate' function to use it`,
            pattern,
            i,
            "unsupported",
          );
        }
        const wantNegate = negate;
        group.push((ctx) => {
          const hit = evaluate(code, ctx);
          return wantNegate ? !hit : hit;
        });
        break;
      }

      // -------------------------------------------- options for the whole glob
      case "M":
        q.markDirs = true;
        break;
      case "T":
        q.listTypes = true;
        q.needsStat = true;
        break;
      case "N":
        q.nullGlob = true;
        break;
      case "D":
        q.globDots = true;
        break;
      case "n":
        q.numericSort = true;
        break;
      case "Y": {
        // `^Y` switches the short circuit back off; otherwise a count is
        // required, as zsh's qgetnum() insists on one.
        if (negate) {
          q.limit = null;
          break;
        }
        const start = i;
        while (/[0-9]/.test(peek())) i++;
        if (i === start) fail("number expected");
        const digits = text.slice(start, i);
        // "if ((shortcircuit = data) != data)": the count is kept in an `int`,
        // so anything that does not survive the narrowing is refused.
        const limit = Number(digits);
        if (limit > 0x7fffffff) fail(`value too big: Y${digits}`);
        q.limit = limit;
        break;
      }
      case "o":
      case "O": {
        // "if (gf_nsorts == MAX_SORTS)", checked before the key is read.
        if (q.sorts.length === MAX_SORTS) fail("too many glob sort specifiers");
        const key = peek();
        if (!key) fail("unknown sort specifier");
        i++;
        // `^` flips the direction, so `*(^oL)` is `*(OL)`.
        const desc = (c === "O") !== negate;
        if (key === "e" || key === "+") {
          // `GS_EXEC` is exempt from the duplicate test: the same code may be
          // given twice, and it is the code that distinguishes them.
          const code = key === "e" ? readDelimited("oe") : readWord();
          q.sorts.push({ key: "e", desc, code });
        } else if ("nLlamcdN".includes(key)) {
          if (key !== "n" && key !== "N" && key !== "d") q.needsStat = true;
          // "if (gf_sorts & t) zerr("doubled sort specifier")".  The direction
          // is not part of `t`, so `oLOL` is doubled; but `-` shifts the type
          // of a key that stats, so `oL-oL` is two different sorts and
          // `-oLoL` is one repeated.
          const shifted = follow && "Llamc".includes(key);
          const id = `${key}${shifted ? "-" : ""}`;
          if (seenSorts.has(id)) fail("doubled sort specifier");
          seenSorts.add(id);
          q.sorts.push({ key: key as SortSpec["key"], desc });
        } else {
          fail("unknown sort specifier");
        }
        break;
      }
      case "[": {
        const body = text.slice(i, text.indexOf("]", i));
        if (text.indexOf("]", i) === -1) fail("invalid subscript");
        i += body.length + 1;
        // Each half is a full arithmetic expression, not a number: `[2*2]` is
        // the fourth match and `[^~]` is an error, not an empty selection.
        // `getarg` stops at a comma only outside any bracket or parenthesis,
        // so `[(1,2)]` is one expression using the comma operator.
        const [beg, end] = splitSubscript(body);
        const num = (part: string): number => evaluateArith(part, text);
        q.subscript = { beg: num(beg), end: end === undefined ? null : num(end) };
        break;
      }
      case "P": {
        const word = readDelimited("P");
        if (negate) q.append.push(word);
        else q.prepend.push(word);
        break;
      }
      default:
        fail(`unknown file attribute: ${c}`);
    }
  }
  q.groups.push(group);
  // A list with no tests in it matches everything.
  if (q.groups.every((g) => g.length === 0)) q.groups = [];
  return q;

  /** `+cmd`: the longest run of alphanumerics and underscores. */
  function readWord(): string {
    const start = i;
    while (/[A-Za-z0-9_]/.test(peek())) i++;
    // "missing identifier after `+'", which is how `glob_exec_string` reports
    // the bare `+` form.
    if (i === start) fail("missing identifier after `+'");
    return text.slice(start, i);
  }

  function readId(what: string, resolve?: (name: string) => number): number {
    if (/[0-9]/.test(peek())) {
      const start = i;
      while (/[0-9]/.test(peek())) i++;
      return Number(text.slice(start, i));
    }
    const name = readDelimited(what);
    if (!resolve) {
      fail(
        `the '${what}${name}' glob qualifier needs a name lookup; supply 'qualifierHooks.resolve${
          what === "u" ? "User" : "Group"
        }'`,
      );
    }
    return resolve(name);
  }

  /** The argument of the `f` qualifier: either `=755` style or `:gu+w,o-rx:`. */
  function readPermissionSpec(): string {
    if (/[0-9=+\-?]/.test(peek())) {
      const start = i;
      while (/[0-9=+\-?]/.test(peek())) i++;
      return text.slice(start, i);
    }
    return readDelimited("f");
  }
}

/**
 * The `f` qualifier's mode spec, a port of zsh's `qgetmodespec()`.
 *
 * It accumulates two sets of bits: `yes`, which the file must have, and `no`,
 * which it must not, so that `f:gu+w,o-rx:` is one combined test.  The class
 * letters mask which bits a right applies to, which is why `u+s` asks for the
 * setuid bit alone while `a+s` asks for setuid and setgid together.
 */
function makePermissionTest(
  spec: string,
  pattern: string,
): (ctx: QualContext, st: GlobStats | null) => boolean {
  const fail = (msg: string): never => {
    throw new ZshPatternError(msg, pattern, 0, "qualifier");
  };

  const CLASS_MASKS: Record<string, number> = {
    o: 0o1007,
    g: 0o2070,
    u: 0o4700,
    a: 0o7777,
  };
  const RIGHTS: Record<string, number> = {
    x: 0o111,
    w: 0o222,
    r: 0o444,
    s: 0o6000,
    t: 0o1000,
  };

  let yes = 0;
  let no = 0;

  for (const sub of spec.split(",")) {
    // "!(end && c == end) && c != ',' && c" -- a piece with nothing in it at
    // all is the one thing `qgetmodespec` refuses.
    if (sub === "") fail("invalid mode specification");
    let i = 0;
    let mask = 0;
    while (i < sub.length && CLASS_MASKS[sub[i]] !== undefined) {
      mask |= CLASS_MASKS[sub[i]];
      i++;
    }
    const how = sub[i] === "+" || sub[i] === "-" ? sub[i] : "=";
    if (sub[i] === "+" || sub[i] === "-" || sub[i] === "=") i++;
    const rest = sub.slice(i);
    let value = 0;

    if (mask) {
      for (const ch of rest) {
        if (RIGHTS[ch] !== undefined) {
          value |= RIGHTS[ch];
        } else if (ch >= "0" && ch <= "7") {
          // A digit stands for the same rights in every class.
          const digit = Number(ch);
          value |= digit | (digit << 3) | (digit << 6);
        } else {
          fail("invalid mode specification");
        }
      }
      if (how === "=" || how === "+") yes |= value & mask;
      if (how === "=" || how === "-") no |= (how === "=" ? ~value : value) & mask;
      continue;
    }

    // An octal number instead, where `?` leaves those digits unchecked.  A
    // sign with no number after it leaves `val` at zero, which constrains
    // nothing: `*(f+x)` is an empty spec followed by the `x` qualifier, so it
    // selects what is executable by its owner rather than anything about `f`.
    let known = 0o7777;
    for (const ch of rest) {
      if (ch === "?") {
        known = (known << 3) | 7;
        value <<= 3;
      } else if (ch >= "0" && ch <= "7") {
        known <<= 3;
        value = (value << 3) | Number(ch);
      } else {
        fail("invalid mode specification");
      }
    }
    if (how === "=") {
      yes = (yes & ~known) | value;
      no = (no & ~known) | (~value & ~known);
    } else if (how === "+") {
      yes |= value;
    } else {
      no |= value;
    }
  }

  yes &= 0o7777;
  no &= 0o7777;
  return (_ctx, st) => {
    if (st === null) return false;
    const bits = st.mode & 0o7777;
    return (bits & yes) === yes && (bits & no) === 0;
  };
}

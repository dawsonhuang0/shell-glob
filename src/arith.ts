import { ZshPatternError } from "./errors.js";

/**
 * zsh's arithmetic evaluator, as much of it as a glob qualifier subscript can
 * reach.  `*(om[1,3])` looks like a slice but each half is a full expression:
 * `*(om[2*2])` is the fourth match, `*(om[0x2])` the second, and `*(om[^~])`
 * is an error rather than a subscript that quietly means nothing.
 *
 * There are no shell parameters here, so a name evaluates to 0, which is what
 * an unset one does in zsh.  An assignment keeps its value for the rest of the
 * expression it appears in and no longer.
 */

/** Evaluates `text`, truncated toward zero as a subscript is. */
export function evaluateArith(text: string, source: string): number {
  const value = new ArithParser(text, source).run();
  // `|| 0` so that a truncated -0.5 is 0 rather than -0, which zsh prints as
  // 0 and which would otherwise index differently from it.
  return Math.trunc(value) || 0;
}

interface Token {
  kind: "number" | "name" | "op";
  text: string;
  value?: number;
}

/** Longest first, so `<<` is not read as two `<`. */
const OPERATORS = [
  "**", "<<", ">>", "<=", ">=", "==", "!=", "&&", "||", "^^", "#",
  "+", "-", "*", "/", "%", "<", ">", "&", "^", "|", "!", "~", "?", ":", ",", "=", "(", ")",
];

/**
 * The whole qualifier text and the offending position are what
 * `ZshPatternError` reports; the message is zsh's own wording.
 */
let failSource = "";

function fail(message: string): never {
  // Reached only from a glob qualifier subscript, which zsh evaluates while
  // parsing the qualifiers.
  throw new ZshPatternError(`bad math expression: ${message}`, failSource, 0, "qualifier");
}

class ArithParser {
  private readonly tokens: Token[] = [];
  private i = 0;
  private readonly vars = new Map<string, number>();

  constructor(
    private readonly text: string,
    source: string,
  ) {
    failSource = source;
    this.tokenize();
  }

  run(): number {
    if (this.tokens.length === 0) fail("empty string");
    const value = this.parseComma();
    if (this.i < this.tokens.length) {
      fail(`operand expected at \`${this.text.slice(this.offsetOf(this.i))}'`);
    }
    return value;
  }

  /** Where a token starts in the source, for the message zsh prints. */
  private offsets: number[] = [];
  private offsetOf(index: number): number {
    return this.offsets[index] ?? this.text.length;
  }

  private tokenize(): void {
    const s = this.text;
    let i = 0;
    while (i < s.length) {
      const c = s[i];
      if (c === " " || c === "\t" || c === "\n") {
        i++;
        continue;
      }
      const start = i;
      if (c >= "0" && c <= "9") {
        const [value, next] = readNumber(s, i);
        this.offsets.push(start);
        this.tokens.push({ kind: "number", text: s.slice(i, next), value });
        i = next;
        continue;
      }
      if (/[A-Za-z_]/.test(c)) {
        let j = i;
        while (j < s.length && /[A-Za-z0-9_]/.test(s[j])) j++;
        // `base#digits`, where the base may be written as a name only if it is
        // a number; a name here is just a name.
        this.offsets.push(start);
        this.tokens.push({ kind: "name", text: s.slice(i, j) });
        i = j;
        continue;
      }
      const op = OPERATORS.find((o) => s.startsWith(o, i));
      if (op === undefined) fail(`operand expected at \`${s.slice(i)}'`);
      this.offsets.push(start);
      this.tokens.push({ kind: "op", text: op });
      i += op.length;
    }
  }

  private peek(): Token | undefined {
    return this.tokens[this.i];
  }

  private eat(op: string): boolean {
    const t = this.peek();
    if (t !== undefined && t.kind === "op" && t.text === op) {
      this.i++;
      return true;
    }
    return false;
  }

  // The precedence chain, loosest first, as in zsh's math.

  private parseComma(): number {
    let value = this.parseAssign();
    while (this.eat(",")) value = this.parseAssign();
    return value;
  }

  private parseAssign(): number {
    const start = this.i;
    const t = this.peek();
    if (t !== undefined && t.kind === "name") {
      const after = this.tokens[this.i + 1];
      if (after !== undefined && after.kind === "op" && after.text === "=") {
        this.i += 2;
        const value = this.parseAssign();
        this.vars.set(t.text, value);
        return value;
      }
    }
    this.i = start;
    return this.parseTernary();
  }

  private parseTernary(): number {
    const cond = this.parseBinary(0);
    if (!this.eat("?")) return cond;
    const yes = this.parseAssign();
    if (!this.eat(":")) fail("':' expected");
    const no = this.parseAssign();
    return cond !== 0 ? yes : no;
  }

  private parseBinary(level: number): number {
    if (level >= LEVELS.length) return this.parseUnary();
    let left = this.parseBinary(level + 1);
    for (;;) {
      const t = this.peek();
      if (t === undefined || t.kind !== "op" || !LEVELS[level].includes(t.text)) return left;
      this.i++;
      // `&&` and `||` leave the other side unevaluated, which shows only in
      // whether a `1/0` on that side is reached.
      if (t.text === "&&" && left === 0) {
        this.parseBinary(level + 1);
        left = 0;
        continue;
      }
      if (t.text === "||" && left !== 0) {
        this.parseBinary(level + 1);
        left = 1;
        continue;
      }
      const right = RIGHT_ASSOC.has(t.text)
        ? this.parseBinary(level)
        : this.parseBinary(level + 1);
      left = apply(t.text, left, right);
      if (RIGHT_ASSOC.has(t.text)) return left;
    }
  }

  private parseUnary(): number {
    if (this.eat("-")) return -this.parseUnary();
    if (this.eat("+")) return this.parseUnary();
    if (this.eat("!")) return this.parseUnary() === 0 ? 1 : 0;
    if (this.eat("~")) return toNumber(~toBig(this.parseUnary()));
    if (this.eat("#")) return this.parseCharCode();
    return this.parsePrimary();
  }

  /**
   * `##c` and `#\c` are the code point of `c`.  A `#` before anything else
   * yields zero, having consumed what follows it.
   */
  private parseCharCode(): number {
    const t = this.peek();
    if (t !== undefined && t.kind === "op" && (t.text === "#" || t.text === "\\")) {
      this.i++;
      const next = this.peek();
      if (next === undefined) return 0;
      this.i++;
      return next.text.codePointAt(0) ?? 0;
    }
    const raw = this.text[this.offsetOf(this.i)];
    if (t !== undefined) this.i++;
    return raw === undefined ? 0 : 0;
  }

  private parsePrimary(): number {
    const t = this.peek();
    if (t === undefined) fail("operand expected at `'");
    if (t.kind === "number") {
      this.i++;
      // `base#digits`: 16#ff is 255, and `2#` with nothing after it is zero.
      if (this.eat("#")) return this.readInBase(t.value!);
      return t.value!;
    }
    if (t.kind === "name") {
      this.i++;
      if (this.eat("#")) return this.readInBase(this.vars.get(t.text) ?? 0);
      // An unset parameter is 0, and every parameter is unset here.
      const value = this.vars.get(t.text) ?? 0;
      if (this.eat("=")) fail("lvalue required");
      return value;
    }
    if (t.text === "(") {
      this.i++;
      const value = this.parseComma();
      if (!this.eat(")")) fail("')' expected");
      return value;
    }
    fail(`operand expected at \`${this.text.slice(this.offsetOf(this.i))}'`);
  }

  private readInBase(base: number): number {
    const t = this.peek();
    // Nothing after the `#` is zero rather than an error, as `2#` is.
    if (t === undefined || (t.kind !== "number" && t.kind !== "name")) return 0;
    this.i++;
    // Base 0 reads as decimal, which is what `0#1` being 1 says.
    const radix = base === 0 ? 10 : base;
    if (radix < 2 || radix > 36) {
      // Its own error, not one of the "bad math expression" family.
      throw new ZshPatternError(
        `invalid base (must be 2 to 36 inclusive): ${base}`,
        failSource,
        0,
        "qualifier",
      );
    }
    let value = 0;
    for (const ch of t.text) {
      const d = parseInt(ch, 36);
      if (Number.isNaN(d) || d >= radix) fail(`bad base digit: ${ch}`);
      value = value * radix + d;
    }
    return value;
  }
}

/**
 * Binary operators by precedence, loosest first -- zsh's own table
 * (`z_prec` in Src/math.c), not C's.  `CPRECEDENCES` selects C's, and it is
 * off by default, so the shifts and the bitwise operators bind *tighter* than
 * multiplication rather than looser, and `**` sits between them:
 *
 *   `1|2*3` is 9, not 7, because it groups as `(1|2)*3`
 *   `1<<2+3` is 7, not 32, because it groups as `(1<<2)+3`
 *   `-2**2` is 4, not -4, because unary binds tighter still
 */
const LEVELS: string[][] = [
  ["||", "^^"],
  ["&&"],
  ["==", "!="],
  ["<", ">", "<=", ">="],
  ["+", "-"],
  ["*", "/", "%"],
  ["**"],
  ["|"],
  ["^"],
  ["&"],
  ["<<", ">>"],
];

/** `2**3**2` is 512: the only binary operator that groups to the right. */
const RIGHT_ASSOC = new Set(["**"]);

/** The bitwise operators work on 64 bit integers, as zsh's do. */
function toBig(n: number): bigint {
  return BigInt.asIntN(64, BigInt(Math.trunc(n)));
}

function toNumber(n: bigint): number {
  return Number(BigInt.asIntN(64, n));
}

function apply(op: string, a: number, b: number): number {
  const ints = Number.isInteger(a) && Number.isInteger(b);
  switch (op) {
    case "+": return a + b;
    case "-": return a - b;
    case "*": return a * b;
    case "**": return a ** b;
    case "/":
      if (b === 0) throw new ZshPatternError("division by zero", failSource, 0, "qualifier");
      // Integer operands divide as integers, as they do in the shell.
      return ints ? Math.trunc(a / b) : a / b;
    case "%":
      if (b === 0) throw new ZshPatternError("division by zero", failSource, 0, "qualifier");
      return ints ? a % b : a % b;
    // 64 bit, as zsh's `zlong` is: `1<<31` is 2147483648, not negative.
    case "<<": return toNumber(toBig(a) << toBig(b));
    case ">>": return toNumber(toBig(a) >> toBig(b));
    case "<": return a < b ? 1 : 0;
    case ">": return a > b ? 1 : 0;
    case "<=": return a <= b ? 1 : 0;
    case ">=": return a >= b ? 1 : 0;
    case "==": return a === b ? 1 : 0;
    case "!=": return a !== b ? 1 : 0;
    case "&": return toNumber(toBig(a) & toBig(b));
    case "^": return toNumber(toBig(a) ^ toBig(b));
    case "|": return toNumber(toBig(a) | toBig(b));
    // Only reached when the left side did not settle it; `parseBinary` short
    // circuits the other way round.
    case "&&": return a !== 0 && b !== 0 ? 1 : 0;
    case "||": return a !== 0 || b !== 0 ? 1 : 0;
    // `^^` is a logical exclusive or, which C has no operator for.
    case "^^": return (a !== 0) !== (b !== 0) ? 1 : 0;
    default: return fail(`unknown operator ${op}`);
  }
}

/**
 * A numeric literal, as `lexconstant` in Src/math.c reads one.
 *
 * A leading zero does *not* mean octal: that is `OCTAL_ZEROES`, which is off
 * unless zsh is emulating sh, so `010` is ten.  `0x` and `0b` go through
 * `zstrtol`, which stops at the first character it cannot use rather than
 * complaining, so `0x` with no digits after it is the zero it began with.
 * An underscore may separate digits anywhere.
 */
function readNumber(s: string, i: number): [number, number] {
  const digitsOf = (from: number, test: RegExp): [string, number] => {
    let j = from;
    let out = "";
    while (j < s.length && (test.test(s[j]) || s[j] === "_")) {
      if (s[j] !== "_") out += s[j];
      j++;
    }
    return [out, j];
  };

  if (s[i] === "0" && (s[i + 1] === "x" || s[i + 1] === "X")) {
    const [digits, j] = digitsOf(i + 2, /[0-9a-fA-F]/);
    // "0x" with nothing usable after it is zero, prefix and all.
    if (digits.length === 0) return [0, i + 2];
    return [parseInt(digits, 16), j];
  }
  if (s[i] === "0" && (s[i + 1] === "b" || s[i + 1] === "B")) {
    const [digits, j] = digitsOf(i + 2, /[01]/);
    if (digits.length === 0) return [0, i + 2];
    return [parseInt(digits, 2), j];
  }

  const [whole, afterWhole] = digitsOf(i, /[0-9]/);
  let j = afterWhole;
  let text = whole;
  if (s[j] === "." || s[j] === "e" || s[j] === "E") {
    if (s[j] === ".") {
      const [frac, next] = digitsOf(j + 1, /[0-9]/);
      text += `.${frac}`;
      j = next;
    }
    if (s[j] === "e" || s[j] === "E") {
      let k = j + 1;
      let sign = "";
      if (s[k] === "+" || s[k] === "-") {
        sign = s[k];
        k++;
      }
      const [exp, next] = digitsOf(k, /[0-9]/);
      if (exp.length > 0) {
        text += `e${sign}${exp}`;
        j = next;
      }
    }
    return [Number(text), j];
  }
  return [Number(whole), j];
}

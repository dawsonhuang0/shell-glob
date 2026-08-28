import type { ZshOptions } from "./options.js";

/**
 * Brace expansion, following `hasbraces` and `xpandbraces` in `Src/glob.c`.
 *
 * This is not filename generation -- no pattern is compiled and the
 * filesystem is never consulted -- but zsh keeps it in `glob.c` and applies it
 * to a word just before globbing, so it lives here rather than with the
 * matcher.
 *
 * zsh works on a tokenised word, where a brace the lexer quoted is simply not
 * a brace token any more.  Here the input is a raw string, so the same
 * distinction is drawn by the backslash: `\{` is an ordinary character and
 * keeps its backslash in the output, for the globber to resolve later.
 *
 * The two halves mirror the shell.  `hasbraces` asks whether a word has an
 * expansion in it at all, and quietly turns the braces that do not into
 * ordinary characters; `xpandbraces` expands the first group it finds and is
 * called again until nothing is left.  Both behaviours are visible from the
 * outside, which is why they are reproduced rather than tidied away:
 *
 *     {a{b,c}}      {ab} {ac}      the outer braces go literal, the inner expand
 *     {1..10..0}    1..10..0       a bad range still loses its braces
 *     {a..e..2}     {a..e..2}      but a word with no expansion keeps them
 */

/** The `{` at `start` and its matching `}`, with what was found between. */
interface Group {
  start: number;
  end: number;
  /** Offsets of the commas at the group's own level. */
  commas: number[];
  /** Offsets of the `..` pairs at the group's own level. */
  dots: number[];
}

const isDigit = (ch: string): boolean => ch >= "0" && ch <= "9";

/**
 * zsh spells `-` two ways -- the character and the `Dash` token it uses where
 * a `-` may have come from a range -- and tests both wherever a sign or a
 * range separator is read.  Only the character can reach us.
 */
const isDash = (ch: string): boolean => ch === "-";

/**
 * Finds the matching `}`, and reports the commas and `..`s at the group's own
 * level along the way.  Returns null if the brace is never closed, which
 * leaves it an ordinary character.
 */
function readGroup(word: string, start: number): Group | null {
  const commas: number[] = [];
  const dots: number[] = [];
  let depth = 0;
  for (let i = start; i < word.length; i++) {
    const ch = word[i];
    if (ch === "\\") {
      i++;
      continue;
    }
    if (ch === "{") {
      depth++;
    } else if (ch === "}") {
      if (--depth === 0) return { start, end: i, commas, dots };
    } else if (depth === 1) {
      if (ch === ",") commas.push(i);
      else if (ch === "." && word[i + 1] === ".") {
        dots.push(i);
        i++;
      }
    }
  }
  return null;
}

/**
 * The word with every character the backslash quoted blanked out, so the scans
 * below see only the braces that are really braces.  zsh has a lexer to do
 * this for it; here the backslash is the whole of it.
 */
function significant(word: string): string[] {
  const out = new Array<string>(word.length).fill("");
  for (let i = 0; i < word.length; i++) {
    if (word[i] === "\\") {
      i++;
      continue;
    }
    out[i] = word[i];
  }
  return out;
}

/**
 * `skipparens`: the index just past the `}` closing the group at `open`, or -1
 * if it never closes.  The difference matters more than it looks, because an
 * unclosed nested group takes the group around it down with it.
 */
function skipBraces(s: string[], open: number): number {
  let level = 1;
  let i = open + 1;
  for (; i < s.length && level > 0; i++) {
    if (s[i] === "{") level++;
    else if (s[i] === "}") level--;
  }
  return level > 0 ? -1 : i;
}

/**
 * `bracechardots`: `{a..z}`, a range between two single characters.  The check
 * is deliberately narrow -- one character, `..`, one character, `}` -- so
 * `{1..10}` falls through to the numeric range below, while `{1..3}` qualifies
 * here and gives the same answer either way.
 */
function charDots(word: string, start: number): [number, number] | null {
  let i = start + 1;
  // A quoted character is not one zsh would have left as an endpoint.
  if (word[i] === "\\") return null;
  const from = word.codePointAt(i);
  if (from === undefined) return null;
  i += String.fromCodePoint(from).length;
  if (word[i] !== "." || word[i + 1] !== ".") return null;
  i += 2;
  if (word[i] === "\\") return null;
  const to = word.codePointAt(i);
  if (to === undefined) return null;
  i += String.fromCodePoint(to).length;
  return word[i] === "}" ? [from, to] : null;
}

/**
 * The shape test `hasbraces` applies to a numeric range: an optional sign,
 * digits, `..`, another number, and optionally a third after a second `..`.
 * At least one of the two ends must actually hold a digit.
 *
 * It is only a shape test.  `{1..10..0}` passes it and then fails the real
 * parse in `expandGroup`, which is how a zero increment ends up losing its
 * braces rather than keeping them.
 */
function numericShape(s: string[], lbr: number): boolean {
  let i = lbr + 1;
  const num = () => {
    if (isDash(s[i])) i++;
    while (i < s.length && isDigit(s[i])) i++;
  };
  num();
  for (let seen = 0; seen < 2; seen++) {
    if (!(s[i] === "." && s[i + 1] === ".")) return false;
    i += 2;
    num();
    if (s[i] === "}") return isDigit(s[lbr + 1]) || isDigit(s[i - 1]);
  }
  return false;
}

/**
 * `hasbraces` for the ordinary case: the `{` of the group zsh would expand, or
 * -1 if the word has no expansion in it.
 *
 * The walk is not the left-to-right scan it looks like.  Rejecting an outer
 * group sends it back to the first group nested inside -- which is why
 * `{a{b,c}}` gives `{ab} {ac}` instead of treating the outer pair as a list of
 * one -- and a nested group that never closes takes the outer one down with
 * it, which is why `{{{,}` is left alone.
 */
function findPlain(word: string, s: string[]): number {
  let lbr = -1;
  let mbr = -1;
  let comma = -1;
  let i = 0;
  for (;;) {
    const c = i < s.length ? s[i] : "\0";
    i++;
    if (c === "{") {
      if (lbr < 0) {
        if (charDots(word, i - 1)) return i - 1;
        lbr = i - 1;
        if (numericShape(s, lbr)) return lbr;
      } else {
        const open = i - 1;
        const close = skipBraces(s, open);
        if (close < 0) {
          // Unbalanced: this group and the one around it are both text, and
          // the scan resumes wherever the search for a close gave up.
          i = s.length;
          if (comma >= 0) i = comma;
          if (mbr >= 0 && mbr < i) i = mbr;
          lbr = mbr = comma = -1;
        } else {
          i = close;
          if (mbr < 0) mbr = open;
        }
      }
    } else if (c === "}") {
      if (lbr >= 0) {
        if (comma >= 0) return lbr;
        // No comma, so this group is text.  Look again inside it.
        if (mbr >= 0) i = mbr;
        mbr = lbr = -1;
      }
    } else if (c === ",") {
      if (lbr >= 0 && comma < 0) comma = i - 1;
    } else if (c === "\0") {
      if (mbr < 0 && comma < 0) return -1;
      if (comma >= 0) i = comma;
      if (mbr >= 0 && mbr < i) i = mbr;
      lbr = mbr = comma = -1;
    }
  }
}

/**
 * `hasbraces` under BRACE_CCL, where any group that closes will expand.  It
 * counts from the very first `{`, so an outer brace that never closes hides
 * every group inside it: `{{,}` expands by the ordinary rules and not at all
 * by these.  `{}` is dropped to text and stepped over.
 */
function findCcl(s: string[]): number {
  const demoted = new Set<number>();
  let depth = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === "{") {
      if (depth === 0 && s[i + 1] === "}") {
        demoted.add(i);
        demoted.add(i + 1);
        i++;
      } else depth++;
    } else if (c === "}" && depth > 0 && --depth === 0) {
      for (let j = 0; j < s.length; j++) {
        if (s[j] === "{" && !demoted.has(j)) return j;
      }
    }
  }
  return -1;
}

/** A signed decimal run starting at `i`, and where it stopped. */
function readInt(word: string, i: number, end: number): [bigint, number] {
  const start = i;
  if (isDash(word[i])) i++;
  while (i < end && isDigit(word[i])) i++;
  const text = word.slice(start, i);
  return [text === "" || text === "-" ? 0n : BigInt(text), i];
}

/** Whether a number written at `i` asks for zero padding. */
function padded(word: string, i: number): boolean {
  return word[i] === "0" || (isDash(word[i]) && word[i + 1] === "0");
}

function pad(value: bigint, width: number): string {
  const negative = value < 0n;
  const digits = (negative ? -value : value).toString();
  const body = digits.padStart(Math.max(0, width - (negative ? 1 : 0)), "0");
  return negative ? `-${body}` : body;
}

/**
 * Expands one group into the words it stands for, in zsh's order.
 *
 * zsh builds its answer by splicing nodes into a list, and whether it walks
 * that list forwards or backwards is what decides the direction: a range
 * written downwards comes back downwards.  `descending` carries that.
 */
function expandGroup(word: string, g: Group, opts: ZshOptions): string[] {
  const prefix = word.slice(0, g.start);
  const suffix = word.slice(g.end + 1);
  const body = word.slice(g.start + 1, g.end);
  const out = (parts: string[]) => parts.map((p) => prefix + p + suffix);

  // A range only when there is no comma: a comma, or a nested group, wins.
  if (g.commas.length === 0 && g.dots.length > 0) {
    const chars = charDots(word, g.start);
    if (chars) {
      let [from, to] = chars;
      const descending = to < from;
      if (descending) [from, to] = [to, from];
      const parts: string[] = [];
      for (let c = from; c <= to; c++) parts.push(String.fromCodePoint(c));
      if (descending) parts.reverse();
      return out(parts);
    }

    let i = g.start + 1;
    let [start, after] = readInt(word, i, g.end);
    const width1 = after - i;
    let ok = after > i && word[after] === "." && word[after + 1] === ".";
    let end = 0n;
    let step = 1n;
    let width2 = 0;
    let width3 = 0;
    let dots2 = -1;
    if (ok) {
      const dots1 = after;
      i = after + 2;
      [end, after] = readInt(word, i, g.end);
      width2 = after - i;
      if (after === i) ok = false;
      else if (after !== g.end) {
        // A third number: `{n1..n2..incr}`.
        dots2 = after;
        if (g.dots.length === 2 && word[after] === "." && word[after + 1] === ".") {
          i = after + 2;
          [step, after] = readInt(word, i, g.end);
          width3 = after - i;
          if (after !== g.end || step === 0n) ok = false;
        } else ok = false;
      }
      void dots1;
    }

    if (ok) {
      // Padding is taken from the first of the three numbers written with a
      // leading zero, in the order they appear.
      const width = padded(word, g.start + 1)
        ? width1
        : padded(word, g.start + 1 + width1 + 2)
          ? width2
          : dots2 >= 0 && padded(word, dots2 + 2)
            ? width3
            : 0;
      let descending = false;
      if (step < 0n) {
        step = -step;
        descending = !descending;
      }
      if (start > end) {
        [start, end] = [end, start];
        descending = !descending;
      } else if (step > 1n) {
        // With a step, the run is anchored to the number written first.
        end -= (end - start) % step;
      }
      const parts: string[] = [];
      for (let v = end; v >= start; v -= step) parts.push(pad(v, width));
      if (!descending) parts.reverse();
      return out(parts);
    }
    // Not a range after all.  zsh falls through to the comma expansion
    // below, which with no comma yields the body without its braces.
  }

  if (g.commas.length === 0 && opts.braceCcl) {
    // `{a-mnop}`: a set of characters, and ranges between them, in order.
    const present = new Set<number>();
    let last = -1;
    for (let i = 0; i < body.length; i++) {
      const c1 = body.charCodeAt(i);
      const c2 = body.charCodeAt(i + 1);
      if (isDash(body[i]) && last >= 0 && i + 1 < body.length && last <= c2) {
        while (last < c2) present.add(last++);
        last = -1;
      } else {
        present.add(c1);
        last = c1;
      }
    }
    return out([...present].sort((a, b) => a - b).map((c) => String.fromCharCode(c)));
  }

  // Plain comma expansion, splitting at this group's own commas.
  const parts: string[] = [];
  let from = g.start + 1;
  for (const comma of g.commas) {
    parts.push(word.slice(from, comma));
    from = comma + 1;
  }
  parts.push(word.slice(from, g.end));
  return out(parts);
}

/**
 * Expands every brace group in a word, as `prefork` does: the first group is
 * expanded, and each word that comes back is expanded again until none is
 * left.  A word with nothing to expand comes back on its own, unchanged.
 */
export function expandBraces(word: string, opts: ZshOptions): string[] {
  if (opts.ignoreBraces) return [word];
  const done: string[] = [];
  const pending: string[] = [word];
  while (pending.length > 0) {
    const next = pending.shift() as string;
    const marks = significant(next);
    const at = opts.braceCcl ? findCcl(marks) : findPlain(next, marks);
    const g = at < 0 ? null : readGroup(next, at);
    if (!g) {
      done.push(next);
      continue;
    }
    // Depth first, so the words keep the order zsh gives them.
    pending.unshift(...expandGroup(next, g, opts));
  }
  return done;
}

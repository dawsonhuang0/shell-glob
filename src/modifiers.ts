import { ZshPatternError } from "./errors.js";
import { isAbsolutePath } from "./paths.js";

/**
 * What the modifiers that ask about the world need to be told.  `:c` and `:A`
 * cannot be answered from the string alone, so they are supplied rather than
 * left to find out, and a virtual filesystem can be tested against.
 */
export interface ModifierContext {
  cwd: string;
  windows?: boolean;
  /** `:c`: where a command lives.  The same lookup `=cmd` uses. */
  commandPath?: (name: string) => string | null | undefined;
  /** `:A` and `:P`: a path with its symbolic links resolved. */
  realpath?: (path: string) => string | null | undefined;
}

/**
 * The history-style colon modifiers that may follow glob qualifiers, e.g.
 * `*(.:t)` for the basename of every plain file.
 *
 * Several of them are prefixes rather than modifiers in their own right:
 * `g`, `f`, `F:n:`, `w` and `W:sep:` all change how the modifier after them
 * is applied, and `&` repeats the last substitution given.  zsh keeps that
 * state across the whole `:` list, which is why it is threaded through here
 * rather than worked out one modifier at a time.
 */
export function applyModifier(
  value: string,
  modifier: string,
  ctxOrCwd: ModifierContext | string,
  windowsArg = false,
  state: ModifierState = {},
): string {
  const ctx: ModifierContext =
    typeof ctxOrCwd === "string" ? { cwd: ctxOrCwd, windows: windowsArg } : ctxOrCwd;
  const cwd = ctx.cwd;
  const windows = ctx.windows ?? false;

  // The prefixes, peeled in the order zsh reads them.
  let rest = modifier;
  let global = false;
  let repeat = 1;
  let untilStable = false;
  let wordwise: string | null = null;
  for (;;) {
    if (rest[0] === "g") {
      global = true;
      rest = rest.slice(1);
    } else if (rest[0] === "f") {
      untilStable = true;
      rest = rest.slice(1);
    } else if (rest[0] === "F") {
      const m = /^F(.)(\d+)\1/.exec(rest);
      if (!m) throw unsupported(rest);
      repeat = Number(m[2]);
      rest = rest.slice(m[0].length);
    } else if (rest[0] === "w") {
      wordwise = " \t\n";
      rest = rest.slice(1);
    } else if (rest[0] === "W") {
      const m = /^W(.)([^]*?)\1/.exec(rest);
      if (!m) throw unsupported(rest);
      wordwise = m[2];
      rest = rest.slice(m[0].length);
    } else break;
  }

  // A bare prefix is a no-op, as zsh leaves it.
  if (rest === "") return value;

  const once = (input: string): string =>
    applyOne(input, rest, { ...ctx, cwd }, windows, global, state);

  const step = (input: string): string => {
    if (wordwise === null) return once(input);
    // Word-wise: the modifier is applied to each word, and the separators
    // between them are kept exactly as they were.
    const sep = new RegExp(`([${wordwise.replace(/[\\^\]-]/g, "\\$&")}]+)`);
    return input
      .split(sep)
      .map((part, i) => (i % 2 === 0 && part !== "" ? once(part) : part))
      .join("");
  };

  let out = value;
  if (untilStable) {
    for (let n = 0; n < 1000; n++) {
      const next = step(out);
      if (next === out) break;
      out = next;
    }
    return out;
  }
  for (let n = 0; n < repeat; n++) out = step(out);
  return out;
}

/** What `:&` needs to remember, and `:s` sets. */
export interface ModifierState {
  from?: string;
  to?: string;
}

function unsupported(mod: string): ZshPatternError {
  return new ZshPatternError(`unsupported modifier ':${mod}'`, mod, 0, "unsupported");
}

function applyOne(
  value: string,
  mod: string,
  ctx: ModifierContext,
  windows: boolean,
  global: boolean,
  state: ModifierState,
): string {
  const cwd = ctx.cwd;

  // `:h` and `:t` take an optional count: `:h3` keeps the first three path
  // components, `:t3` the last three.  `:h0` and `:t0` mean the same as the
  // bare form, and a count larger than the path leaves it untouched.
  const count = /^[ht](\d+)$/.exec(mod);

  switch (mod[0]) {
    case "h": {
      const trimmed = value.replace(/(.)\/+$/, "$1");
      if (count && Number(count[1]) > 0) {
        const parts = splitPath(trimmed);
        const keep = Number(count[1]);
        return keep >= parts.components.length ? trimmed : join(parts, keep);
      }
      const i = trimmed.lastIndexOf("/");
      if (i < 0) return ".";
      return i === 0 ? "/" : trimmed.slice(0, i);
    }
    case "t": {
      const trimmed = value.replace(/(.)\/+$/, "$1");
      if (count && Number(count[1]) > 0) {
        const parts = splitPath(trimmed);
        const keep = Number(count[1]);
        if (keep >= parts.components.length) return trimmed;
        return parts.components.slice(parts.components.length - keep).join("/");
      }
      const i = trimmed.lastIndexOf("/");
      return i < 0 ? trimmed : trimmed.slice(i + 1);
    }
    // The extension is the part after the last `.` in the final component,
    // and zsh counts a leading dot too: `.hidden:r` is empty, `.hidden:e` is
    // `hidden`, while `a.b/c` has no extension at all.
    case "r": {
      const dot = value.lastIndexOf(".");
      return dot > value.lastIndexOf("/") ? value.slice(0, dot) : value;
    }
    case "e": {
      const dot = value.lastIndexOf(".");
      return dot > value.lastIndexOf("/") ? value.slice(dot + 1) : "";
    }
    case "l":
      return value.toLowerCase();
    case "u":
      return value.toUpperCase();
    case "a":
      // A path that is already absolute is left alone -- which on Windows
      // includes a drive letter, so `C:/proj/a.txt` is not joined onto `cwd`.
      return normalizePath(isAbsolutePath(value, windows) ? value : `${cwd}/${value}`);
    case "s": {
      const { from, to } = parseSubstitution(mod);
      state.from = from;
      state.to = to;
      return global ? value.split(from).join(to) : value.replace(from, to);
    }
    // `:&` repeats the substitution the last `:s` gave, which is why that one
    // records it.  With no `:s` before it there is nothing to repeat.
    case "&": {
      if (state.from === undefined || state.to === undefined) return value;
      return global
        ? value.split(state.from).join(state.to)
        : value.replace(state.from, state.to);
    }
    // `:c` is `=cmd` in modifier form: zsh calls the very same function.
    case "c": {
      const found = ctx.commandPath?.(value);
      return found === null || found === undefined ? value : found;
    }
    // `:A` resolves symbolic links as well as making the path absolute, and
    // `:P` does the same from the current directory.  Without a resolver
    // there is nothing to resolve, so the lexical answer stands.
    case "A":
    case "P": {
      const absolute = isAbsolutePath(value, windows) ? value : `${cwd}/${value}`;
      const resolved = ctx.realpath?.(absolute);
      return resolved === null || resolved === undefined ? normalizePath(absolute) : resolved;
    }
    case "q":
      return quoteString(value);
    case "Q":
      return dequoteString(value);
    default:
      throw unsupported(mod);
  }
}

function splitPath(path: string): { absolute: boolean; components: string[] } {
  const absolute = path.startsWith("/");
  return {
    absolute,
    components: (absolute ? path.slice(1) : path).split("/").filter((p) => p !== ""),
  };
}

function join(parts: { absolute: boolean; components: string[] }, keep: number): string {
  const joined = parts.components.slice(0, keep).join("/");
  return parts.absolute ? `/${joined}` : joined;
}

/** `s/old/new/`, with any character as the delimiter. */
function parseSubstitution(mod: string): { from: string; to: string } {
  const delim = mod[1];
  if (!delim) throw new ZshPatternError("missing delimiter in ':s' modifier", mod, 1, "unsupported");
  const parts: string[] = [""];
  for (let i = 2; i < mod.length; i++) {
    if (mod[i] === "\\" && i + 1 < mod.length) {
      parts[parts.length - 1] += mod[++i];
      continue;
    }
    if (mod[i] === delim) {
      if (parts.length === 2) break;
      parts.push("");
      continue;
    }
    parts[parts.length - 1] += mod[i];
  }
  if (parts.length < 2) {
    throw new ZshPatternError("missing delimiter in ':s' modifier", mod, 1, "unsupported");
  }
  return { from: parts[0], to: parts[1] };
}

/** Resolve `.` and `..` textually, the way zsh's `:a` modifier does. */
export function normalizePath(path: string): string {
  const absolute = path.startsWith("/");
  const out: string[] = [];
  for (const part of path.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      if (out.length > 0 && out[out.length - 1] !== "..") out.pop();
      else if (!absolute) out.push("..");
      continue;
    }
    out.push(part);
  }
  const joined = out.join("/");
  return absolute ? `/${joined}` : joined || ".";
}

/**
 * `:q`, as `quotestring` with `QT_BACKSLASH_SHOWNULL` writes it: every
 * character the shell would act on gets a backslash, and an empty string
 * becomes `\'\'` so that it survives as a word at all.
 */
function quoteString(value: string): string {
  if (value === "") return "''";
  return value.replace(/[\\|&;<>()$`'"\t\n *?[\]#~=%{},!^]/g, (ch) =>
    ch === "\n" ? "\\\n" : `\\${ch}`,
  );
}

/** `:Q`, which takes one level of quoting back off. */
function dequoteString(value: string): string {
  let out = "";
  for (let i = 0; i < value.length; i++) {
    const ch = value[i];
    if (ch === "\\" && i + 1 < value.length) {
      out += value[++i];
    } else if (ch === "'") {
      // A single-quoted run ends at the next quote and holds no escapes.
      const end = value.indexOf("'", i + 1);
      if (end < 0) return out + value.slice(i + 1);
      out += value.slice(i + 1, end);
      i = end;
    } else if (ch === '"') {
      const end = value.indexOf('"', i + 1);
      if (end < 0) return out + value.slice(i + 1);
      out += value.slice(i + 1, end);
      i = end;
    } else out += ch;
  }
  return out;
}

/**
 * Splits the `:` section of a qualifier list into modifiers.
 *
 * Not `split(":")`: a modifier may hold colons of its own.  `s` and `S` take
 * any character as their delimiter, so `:s:a:b:` is one modifier, and `F` and
 * `W` take an argument delimited the same way.  zsh scans this rather than
 * splitting it, and stops as soon as what follows is not another `:` -- which
 * is why the `t` in `:s:a:b:t` is quietly dropped rather than applied.
 */
export function splitModifiers(text: string): string[] {
  const out: string[] = [];
  let i = 0;
  const delimited = (from: number): number => {
    // <delim>text<delim>, with a backslash escaping the delimiter.
    const delim = text[from];
    if (delim === undefined) return -1;
    let j = from + 1;
    while (j < text.length && text[j] !== delim) {
      if (text[j] === "\\") j++;
      j++;
    }
    return j < text.length ? j + 1 : -1;
  };
  while (text[i] === ":") {
    i++;
    const start = i;
    // The prefixes, which change how the modifier after them is applied.
    for (;;) {
      const ch = text[i];
      if (ch === "g" || ch === "f" || ch === "w") {
        i++;
      } else if (ch === "F" || ch === "W") {
        const end = delimited(i + 1);
        if (end < 0) break;
        i = end;
      } else break;
    }
    const c = text[i];
    if (c === undefined) {
      // A trailing run of prefixes with nothing to apply them to.
      if (i > start) out.push(text.slice(start, i));
      break;
    }
    i++;
    if (c === "s" || c === "S") {
      // <delim>from<delim>to<delim>, the last delimiter optional at the end.
      const delim = text[i];
      if (delim !== undefined) {
        i++;
        for (let half = 0; half < 2; half++) {
          while (i < text.length && text[i] !== delim) {
            if (text[i] === "\\") i++;
            i++;
          }
          if (i < text.length) i++;
        }
      }
    } else if (c === "h" || c === "t") {
      while (text[i] >= "0" && text[i] <= "9") i++;
    }
    out.push(text.slice(start, i));
  }
  return out;
}

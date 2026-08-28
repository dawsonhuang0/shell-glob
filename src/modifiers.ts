import { ZshPatternError } from "./errors.js";
import { isAbsolutePath } from "./paths.js";

/**
 * The history-style colon modifiers that may follow glob qualifiers, e.g.
 * `*(.:t)` for the basename of every plain file.
 */
export function applyModifier(
  value: string,
  modifier: string,
  cwd: string,
  windows = false,
): string {
  const global = modifier.startsWith("g") && modifier.length > 1;
  const mod = global ? modifier.slice(1) : modifier;

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
      return global ? value.split(from).join(to) : value.replace(from, to);
    }
    default:
      throw new ZshPatternError(
        `unsupported modifier ':${modifier}'`,
        modifier,
        0,
        "unsupported",
      );
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

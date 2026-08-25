/**
 * Extracts every pattern matching and filename generation case zsh's own test
 * suite contains, from all of Test/*.ztst, into test/fixtures/ztst.json.
 *
 *     node scripts/extract-ztst.mjs [path/to/zsh]
 *
 * A .ztst block is indented shell input, a "<status>:<name>" line, then the
 * expected stdout as ">" lines.  We interpret the small slice of shell that
 * pattern tests are written in — variable assignment, `setopt`, `print`,
 * `[[ x = pat ]]`, and the `#`/`##`/`%`/`%%`/`/`//` parameter expansions —
 * and record zsh's own expected output as the fixture.  Anything else is
 * counted as skipped, with the reason, so the coverage is auditable.
 */
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const zshRoot = process.argv[2] ?? fileURLToPath(new URL("../zsh", import.meta.url));
const testDir = `${zshRoot}/Test`;

const OPTION_NAMES = {
  extendedglob: "extendedGlob",
  kshglob: "kshGlob",
  shglob: "shGlob",
  nomatch: "noMatch",
  nullglob: "nullGlob",
  globdots: "globDots",
  markdirs: "markDirs",
  globstarshort: "globStarShort",
  bareglobqual: "bareGlobQual",
  numericglobsort: "numericGlobSort",
  caseglob: "caseGlob",
  multibyte: "multibyte",
  badpattern: "badPattern",
  glob: null, // recognised, but only "on" is meaningful here
};

/** Expands `a{1,2}b` the way the shell does, for the %prep commands. */
function braceExpand(word) {
  const open = word.indexOf("{");
  if (open === -1) return [word];
  let depth = 0;
  let close = -1;
  const parts = [];
  let current = "";
  for (let i = open; i < word.length; i++) {
    const c = word[i];
    if (c === "{") {
      depth++;
      if (depth === 1) continue;
    } else if (c === "}") {
      depth--;
      if (depth === 0) {
        close = i;
        parts.push(current);
        break;
      }
    } else if (c === "," && depth === 1) {
      parts.push(current);
      current = "";
      continue;
    }
    current += c;
  }
  if (close === -1) return [word];
  const prefix = word.slice(0, open);
  const suffix = word.slice(close + 1);
  return parts.flatMap((part) => braceExpand(`${prefix}${part}${suffix}`));
}

/** The %prep section, as far as it builds a directory tree we can recreate. */
function parsePrep(lines) {
  const prep = [];
  let inPrep = false;
  for (const raw of lines) {
    if (raw.startsWith("%prep")) {
      inPrep = true;
      continue;
    }
    if (raw.startsWith("%")) inPrep = false;
    if (!inPrep || !raw.startsWith(" ")) continue;
    const line = raw.replace(/\s+#\s.*$/, "").trim();
    let m = /^mkdir\s+(?:-p\s+)?(\S+)$/.exec(line);
    if (m) {
      for (const path of braceExpand(m[1])) prep.push({ command: "mkdir", path });
      continue;
    }
    m = /^(?:touch|:\s*>|>)\s*(\S+)$/.exec(line);
    if (m) {
      for (const path of braceExpand(m[1])) prep.push({ command: "touch", path });
      continue;
    }
    m = /^ln\s+-s\s+(\S+)\s+(\S+)$/.exec(line);
    if (m) {
      prep.push({ command: "symlink", target: m[1], path: m[2] });
      continue;
    }
  }
  return prep;
}

/** Blocks of { input, status, name, expected, line }. */
function parseBlocks(lines) {
  const blocks = [];
  let input = [];
  let start = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const header = /^(\d+):(.*)$/.exec(line);
    if (header && input.length > 0) {
      const expected = [];
      const errors = [];
      let fuzzy = false;
      let j = i + 1;
      for (; j < lines.length; j++) {
        if (lines[j].startsWith(">")) expected.push(lines[j].slice(1));
        else if (lines[j].startsWith("?")) errors.push(lines[j].slice(1));
        else if (/^[*F]/.test(lines[j])) fuzzy = true;
        else break;
      }
      blocks.push({
        input,
        status: Number(header[1]),
        name: header[2],
        expected,
        errors,
        fuzzy,
        line: start,
      });
      input = [];
      i = j - 1;
      continue;
    }
    if (line.startsWith(" ")) {
      const text = line.replace(/\s+#\s.*$/, "").trim();
      if (text && !text.startsWith("#")) {
        if (input.length === 0) start = i + 1;
        input.push(text);
      }
    }
  }
  return blocks;
}

class Unsupported extends Error {}

/** Applies just the `setopt`/`unsetopt` lines of a block, ignoring the rest. */
function applySetopts(input, options) {
  for (const line of input) {
    const m = /^\s*(un)?setopt\s+(.+)$/.exec(line);
    if (!m) continue;
    for (const raw of m[2].split(/\s+/)) {
      let name = raw.toLowerCase().replace(/_/g, "");
      let value = !m[1];
      if (!(name in OPTION_NAMES) && name.startsWith("no")) {
        name = name.slice(2);
        value = !value;
      }
      const key = OPTION_NAMES[name];
      if (key) options = { ...options, [key]: value };
    }
  }
  return options;
}

function joinRelative(base, path) {
  if (path === ".") return base;
  return base ? `${base}/${path}` : path;
}

/**
 * Tokenizes one shell word the way zsh's lexer does, tracking which characters
 * were quoted.  `literal` is the plain value; `pattern` is the same text with
 * every character that was quoted backslash escaped, so that it keeps its
 * pattern meaning only where the shell would have kept it.  Text coming from a
 * parameter expansion is never pattern active, which is why `${~var}` exists.
 */
function shellWord(word, vars) {
  // `-` and `!` matter inside a bracket expression, so quoting them counts too.
  const SPECIAL = /[*?[\]()<>^#~|\\!-]/;
  let literal = "";
  let pattern = "";
  const push = (ch, quoted) => {
    literal += ch;
    pattern += quoted && SPECIAL.test(ch) ? `\\${ch}` : ch;
  };
  const expand = (name, active) => {
    if (!vars.has(name)) throw new Unsupported(`unset variable ${name}`);
    for (const ch of vars.get(name)) push(ch, !active);
  };

  let i = 0;
  while (i < word.length) {
    const c = word[i];
    if (c === "'") {
      i++;
      while (i < word.length && word[i] !== "'") push(word[i++], true);
      if (i >= word.length) throw new Unsupported("unbalanced quote");
      i++;
      continue;
    }
    if (c === '"') {
      i++;
      while (i < word.length && word[i] !== '"') {
        if (word[i] === "\\" && '"$`\\'.includes(word[i + 1] ?? "")) {
          i++;
          push(word[i++], true);
          continue;
        }
        if (word[i] === "$") {
          const m = /^\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?/.exec(word.slice(i));
          if (!m) throw new Unsupported(`expansion in ${word}`);
          expand(m[1], false);
          i += m[0].length;
          continue;
        }
        push(word[i++], true);
      }
      if (i >= word.length) throw new Unsupported("unbalanced quote");
      i++;
      continue;
    }
    if (c === "\\") {
      i++;
      if (i < word.length) push(word[i++], true);
      continue;
    }
    if (c === "$") {
      const tilde = /^\$\{~([A-Za-z_][A-Za-z0-9_]*)\}|^\$~([A-Za-z_][A-Za-z0-9_]*)/.exec(
        word.slice(i),
      );
      if (tilde) {
        // `${~var}`: the value is used as a pattern.
        expand(tilde[1] ?? tilde[2], true);
        i += tilde[0].length;
        continue;
      }
      const m = /^\$\{([A-Za-z_][A-Za-z0-9_]*)\}|^\$([A-Za-z_][A-Za-z0-9_]*)/.exec(
        word.slice(i),
      );
      if (!m) throw new Unsupported(`expansion in ${word}`);
      expand(m[1] ?? m[2], false);
      i += m[0].length;
      continue;
    }
    push(word[i++], false);
  }
  return { literal, pattern };
}

/** Does the word hold a glob operator that survived quoting? */
function isGlobPattern(pattern) {
  for (let i = 0; i < pattern.length; i++) {
    if (pattern[i] === "\\") {
      i++;
      continue;
    }
    if (/[*?[()<>^#~|]/.test(pattern[i])) return true;
  }
  return false;
}

/**
 * A `${var#pat}` style expansion, mapped onto the library's API.  Returns
 * `{ kind, variable, pattern, replacement }` or null if it is not one.
 */
function parseParameterOp(word) {
  const m =
    /^([^$]*)\$\{([A-Za-z_][A-Za-z0-9_]*)(##?|%%?|\/\/?)(.*)\}([^$]*)$/.exec(word);
  if (!m) return null;
  const [, before, variable, op, restRaw, after] = m;
  if (/[{}]/.test(before) || /[{}]/.test(after)) return null;
  let rest = restRaw;
  // `${v/#pat/rep}` anchors the match at the start, `/%` at the end; zsh
  // documents these as equivalent to the (#s) and (#e) assertions.
  let anchor = "";
  if ((op === "/" || op === "//") && /^[#%]/.test(rest)) {
    if (rest.startsWith("#%") || rest.startsWith("%#")) {
      anchor = "both";
      rest = rest.slice(2);
    } else {
      anchor = rest[0] === "#" ? "start" : "end";
      rest = rest.slice(1);
    }
  }
  if (op === "/" || op === "//") {
    // The pattern runs to the first unescaped `/`.
    let pattern = "";
    let i = 0;
    for (; i < rest.length; i++) {
      if (rest[i] === "\\") {
        pattern += rest[i] + (rest[++i] ?? "");
        continue;
      }
      if (rest[i] === "/") break;
      pattern += rest[i];
    }
    if (anchor === "start" || anchor === "both") pattern = `(#s)${pattern}`;
    if (anchor === "end" || anchor === "both") pattern = `${pattern}(#e)`;
    return {
      kind: op === "/" ? "replace" : "replaceAll",
      variable,
      pattern,
      replacement: i < rest.length ? rest.slice(i + 1) : "",
      before,
      after,
      anchored: anchor !== "",
    };
  }
  return {
    kind: { "#": "stripShortestPrefix", "##": "stripLongestPrefix",
            "%": "stripShortestSuffix", "%%": "stripLongestSuffix" }[op],
    variable,
    pattern: rest,
    before,
    after,
  };
}

/** Splits a command line into words, keeping quotes attached to their word. */
function splitWords(line) {
  const words = [];
  let current = "";
  let quote = null;
  let started = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === "\\") {
      current += c + (line[i + 1] ?? "");
      i++;
      started = true;
      continue;
    }
    if (quote) {
      current += c;
      if (c === quote) quote = null;
      continue;
    }
    if (c === "'" || c === '"') {
      quote = c;
      current += c;
      started = true;
      continue;
    }
    if (c === "$" && line[i + 1] === "{") {
      // Keep a `${...}` together, spaces and all.
      let depth = 0;
      let j = i + 1;
      for (; j < line.length; j++) {
        if (line[j] === "{") depth++;
        else if (line[j] === "}" && --depth === 0) break;
      }
      current += line.slice(i, j + 1);
      i = j;
      started = true;
      continue;
    }
    if (c === " " || c === "\t") {
      if (started) words.push(current);
      current = "";
      started = false;
      continue;
    }
    current += c;
    started = true;
  }
  if (started) words.push(current);
  if (quote) throw new Unsupported("unbalanced quote");
  return words;
}


/**
 * Flattens the block's input into single statements: a subshell becomes its
 * contents (its scoping is handled by the caller restoring state), and
 * `a; b` becomes two lines.
 */
function flattenInput(input) {
  const out = [];
  for (let line of input) {
    // `( ... )` on one line, or a bare `(` / `)` around a group.
    if (line === "(" || line === ")" || line === "(" || /^\(\s*$/.test(line)) continue;
    if (/^\(.*\)$/.test(line) && !/^\(\(/.test(line)) {
      const inner = line.slice(1, -1).trim();
      // Only if the parentheses really wrap the whole statement.
      let depth = 0;
      let wraps = true;
      for (let i = 0; i < line.length - 1; i++) {
        if (line[i] === "(") depth++;
        else if (line[i] === ")") depth--;
        if (depth === 0 && i > 0) {
          wraps = false;
          break;
        }
      }
      if (wraps) line = inner;
    }
    if (line.startsWith("(")) line = line.slice(1).trim();
    if (line.endsWith(")") && !line.includes("(")) line = line.slice(0, -1).trim();
    if (!line) continue;
    // Split on `;`, but not inside quotes, brackets or parentheses.
    let depth = 0;
    let quote = null;
    let current = "";
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (c === "\\") {
        current += c + (line[i + 1] ?? "");
        i++;
        continue;
      }
      if (quote) {
        current += c;
        if (c === quote) quote = null;
        continue;
      }
      if (c === "'" || c === '"') {
        quote = c;
        current += c;
        continue;
      }
      if (c === "(" || c === "[" || c === "{") depth++;
      else if (c === ")" || c === "]" || c === "}") depth--;
      if (c === ";" && depth === 0) {
        if (current.trim()) out.push(current.trim());
        current = "";
        continue;
      }
      current += c;
    }
    if (current.trim()) out.push(current.trim());
  }
  return out;
}

/** Interprets one block, returning the cases it yields. */
function interpretBlock(block, state, file) {
  const cases = [];
  const setup = [];
  /** Setup commands that come after the first output producing command. */
  const setupAfter = [];
  /** Expected output lines still to be accounted for. */
  let outputs = [];
  let localVars = new Map(state.vars);
  let arrays = new Map(state.arrays);
  let options = state.options;
  let cwd = state.cwd;

  const evaluateWord = (word) => {
    // `${a[(r)pat]}` and friends: a pattern search over an array's elements.
    const subscript = /^\$\{([A-Za-z_][A-Za-z0-9_]*)\[\(([rRiI])\)(.*)\]\}$/.exec(word);
    if (subscript) {
      const [, name, flag, pattern] = subscript;
      if (!arrays.has(name)) throw new Unsupported(`unset array ${name}`);
      if (/[$`]/.test(pattern)) throw new Unsupported(`expansion in ${word}`);
      return {
        type: "arraySearch",
        flag,
        elements: arrays.get(name),
        pattern,
        options,
      };
    }
    const bareArray = /^\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?$/.exec(word);
    if (bareArray && arrays.has(bareArray[1])) {
      return { type: "literal", value: arrays.get(bareArray[1]).join(" ") };
    }

    // `${var#pat}` and friends become a case of their own.
    const op = parseParameterOp(word);
    if (op) {
      if (!localVars.has(op.variable)) throw new Unsupported(`unset variable ${op.variable}`);
      if (/[$`]/.test(op.pattern) || /[$`]/.test(op.replacement ?? "")) {
        throw new Unsupported(`expansion inside ${word}`);
      }
      if (/['"]/.test(op.before + op.after)) {
        throw new Unsupported(`quoting around ${word}`);
      }
      // The pattern and the replacement are shell words in their own right.
      const patternWord = shellWord(op.pattern, localVars);
      const replacementWord = shellWord(op.replacement ?? "", localVars);
      return {
        type: "expansion",
        kind: op.kind,
        value: localVars.get(op.variable),
        pattern: patternWord.pattern,
        replacement: replacementWord.literal,
        before: op.before,
        after: op.after,
        // The anchored forms need the (#s)/(#e) assertions, so extended glob.
        options: op.anchored ? { ...options, extendedGlob: true } : options,
      };
    }
    if (/\$\{[^}]*[([{]/.test(word) || /\$\(/.test(word) || /\$\{[^}]*[:^=+]/.test(word)) {
      throw new Unsupported(`expansion in ${word}`);
    }
    const { literal, pattern } = shellWord(word, localVars);
    if (isGlobPattern(pattern)) {
      if (/(^|[^\\])[{]/.test(pattern)) throw new Unsupported("brace expansion");
      if (word.includes("$")) {
        // Whether an expanded value globs depends on GLOB_SUBST, which we do
        // not model, so leave this one alone.
        throw new Unsupported("a glob built by expansion");
      }
      if (/\((#q)?[^)]*\be[:[{(]/.test(pattern) || /\(\+[a-z]/.test(pattern)) {
        throw new Unsupported("a glob qualifier running shell code");
      }
      // Only D02glob builds its tree entirely in %prep; elsewhere the files
      // come from shell commands we do not run, so the expansion is not
      // reproducible here.
      if (file !== "D02glob.ztst") throw new Unsupported("filesystem state we do not model");
      return { type: "glob", word: pattern, options, cwd };
    }
    return { type: "literal", value: literal };
  };

  for (const line of flattenInput(block.input)) {
    const cd = /^cd\s+(\S+)$/.exec(line);
    if (cd) {
      if (/[$*?[]/.test(cd[1])) throw new Unsupported(`cd ${cd[1]}`);
      cwd = cd[1] === ".." ? cwd.split("/").slice(0, -1).join("/") : joinRelative(cwd, cd[1]);
      continue;
    }

    const setopt = /^(un)?setopt\s+(.+)$/.exec(line);
    if (setopt) {
      for (const raw of setopt[2].split(/\s+/)) {
        let name = raw.toLowerCase().replace(/_/g, "");
        let value = !setopt[1];
        if (!(name in OPTION_NAMES) && name.startsWith("no")) {
          name = name.slice(2);
          value = !value;
        }
        if (!(name in OPTION_NAMES)) throw new Unsupported(`option ${raw}`);
        const key = OPTION_NAMES[name];
        if (key) options = { ...options, [key]: value };
      }
      continue;
    }

    const arrayAssign = /^(?:local\s+|typeset\s+)?(?:-a\s+)?([A-Za-z_][A-Za-z0-9_]*)=\((.*)\)$/.exec(
      line,
    );
    if (arrayAssign) {
      const [, name, body] = arrayAssign;
      if (/[$`]/.test(body)) throw new Unsupported("expansion in an array assignment");
      arrays.set(name, splitWords(body).map((word) => shellWord(word, localVars).literal));
      localVars.delete(name);
      continue;
    }

    const assign = /^(?:local\s+|typeset\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line);
    if (assign && !line.includes("(")) {
      const [, name, raw] = assign;
      if (/\$\(|`/.test(raw)) throw new Unsupported("command substitution");
      localVars.set(name, shellWord(raw, localVars).literal);
      arrays.delete(name);
      continue;
    }

    const fs = /^(mkdir|touch|rm)\s+(?:(-\S+)\s+)?(\S+)$/.exec(line);
    if (fs && !/[{}$*?[\]]/.test(fs[3])) {
      const step = { type: "setup", command: fs[1], path: fs[3], file };
      if (cases.length === 0 && outputs.length === 0) setup.push(step);
      else setupAfter.push(step);
      continue;
    }

    const cond = /^\[\[\s+(.+?)\s+(=|==|!=)\s+(.+?)\s+\]\](?:\s+(&&|\|\|)\s+print\s+(.+))?$/.exec(
      line,
    );
    if (cond) {
      const [, lhsRaw, operator, rhsRaw, guard, text] = cond;
      if (/&&|\|\||^!/.test(`${lhsRaw} ${rhsRaw}`)) {
        throw new Unsupported("a compound condition");
      }
      if (/\(#q/.test(lhsRaw)) throw new Unsupported("a glob qualifier on the left of =");
      const lhs = shellWord(lhsRaw, localVars).literal;
      // The right hand side is a pattern, so quoting matters there.
      const pattern = shellWord(rhsRaw, localVars).pattern;
      cases.push({
        type: "match",
        string: lhs,
        pattern,
        operator,
        guard: guard ?? null,
        text: text ?? null,
        options,
      });
      continue;
    }

    const print = /^print((?:\s+-[A-Za-z]+)*)\s+(.*)$/.exec(line);
    if (print) {
      const perLine = /-[A-Za-z]*l/.test(print[1]);
      let rest = print[2].trim();
      if (rest.startsWith("-- ") || rest.startsWith("- ")) {
        rest = rest.slice(rest.indexOf(" ") + 1).trim();
      }
      if (/[|;&`]|\$\(|\bthen\b/.test(rest.replace(/\([^)]*\)/g, ""))) {
        if (perLine) throw new Unsupported("shell syntax in a print");
        outputs.push({ perLine, words: null, why: "shell syntax in a print" });
        continue;
      }
      let words;
      try {
        words = splitWords(rest).map(evaluateWord);
      } catch (err) {
        if (!(err instanceof Unsupported) || perLine) throw err;
        // We cannot evaluate this one, but it still writes exactly one line,
        // so the rest of the block stays in step.
        outputs.push({ perLine, words: null, why: err.message });
        continue;
      }
      outputs.push({ perLine, words });
      continue;
    }

    throw new Unsupported(`cannot translate: ${line}`);
  }

  return { cases, setup, setupAfter, outputs, options, vars: localVars, arrays, cwd };
}

/** Turns the interpreted block into fixture entries, pairing up the output. */
function resolveBlock(block, interpreted, file) {
  const steps = [...interpreted.setup];
  const { cases, outputs } = interpreted;

  for (const item of cases) {
    let expected;
    if (item.guard === null) {
      if (cases.length > 1 || outputs.length > 0 || block.status > 1) {
        throw new Unsupported("a bare condition among other commands");
      }
      expected = block.status === 0;
    } else {
      const printed = block.expected.includes(item.text);
      expected = item.guard === "&&" ? printed : !printed;
    }
    steps.push({
      type: "match",
      string: item.string,
      pattern: item.pattern,
      matches: item.operator === "!=" ? !expected : expected,
      options: item.options,
      name: block.name,
      file,
      line: block.line,
    });
  }

  if (outputs.length > 0) {
    if (block.status !== 0) throw new Unsupported("a print in a block that fails");
    if (outputs.length !== block.expected.length && !(outputs.length === 1 && outputs[0].perLine)) {
      throw new Unsupported("output does not line up with the commands");
    }
    for (const [i, output] of outputs.entries()) {
      if (output.words === null) continue; // a line we could not evaluate
      const lines = output.perLine ? block.expected : [block.expected[i]];
      if (
        output.words.length === 1 &&
        (output.words[0].type === "expansion" || output.words[0].type === "arraySearch")
      ) {
        if (lines.length !== 1) throw new Unsupported("multi line expansion output");
        steps.push({
          ...output.words[0],
          expected: lines[0],
          name: block.name,
          file,
          line: block.line,
        });
        continue;
      }
      if (output.words.some((word) => word.type === "expansion" || word.type === "arraySearch")) {
        throw new Unsupported("an expansion mixed with other words");
      }
      const globs = output.words.filter((word) => word.type === "glob");
      if (globs.length === 0) continue; // nothing to check
      if (globs.length !== output.words.length) {
        throw new Unsupported("a glob mixed with literal words");
      }
      if (globs.length !== 1) throw new Unsupported("more than one glob in a print");
      const words = output.perLine
        ? lines
        : lines[0] === ""
          ? []
          : lines[0].split(" ");
      if (words.some((word) => word === "")) throw new Unsupported("an empty word in the output");
      steps.push({
        type: "glob",
        word: globs[0].word,
        expected: words,
        options: globs[0].options,
        cwd: globs[0].cwd,
        name: block.name,
        file,
        line: block.line,
      });
    }
  }

  steps.push(...interpreted.setupAfter);
  return steps;
}

const steps = [];
const skipped = [];
const perFile = {};
/** The %prep tree each file builds, for the files that need one. */
const prep = {};

for (const file of readdirSync(testDir).filter((name) => name.endsWith(".ztst")).sort()) {
  const bytes = readFileSync(`${testDir}/${file}`);
  let text;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    text = bytes.toString("latin1"); // a file with stray bytes, as D02glob has
  }
  const source = text.split("\n");
  const blocks = parseBlocks(source);
  prep[file] = parsePrep(source);
  perFile[file] = { blocks: blocks.length, cases: 0, skipped: 0 };
  // Options and variables persist between blocks, as they do in the shell.
  const state = { vars: new Map(), arrays: new Map(), options: {}, cwd: "" };

  for (const block of blocks) {
    const record = (why) => {
      skipped.push({ file, name: block.name, why });
      perFile[file].skipped++;
    };
    if (block.fuzzy) {
      record("expects stderr or a fuzzy match");
      continue;
    }
    let interpreted;
    try {
      interpreted = interpretBlock(block, state, file);
    } catch (err) {
      if (!(err instanceof Unsupported)) throw err;
      // The shell would still have run any `setopt` in this block, so keep
      // those even though we cannot use the rest of it.
      state.options = applySetopts(block.input, state.options);
      record(err.message);
      continue;
    }
    // Only carry state forward from blocks we understood in full.
    state.vars = interpreted.vars;
    state.arrays = interpreted.arrays;
    state.options = interpreted.options;
    // A `cd` inside a block is almost always in a subshell, so it does not
    // carry over; blocks that need it do it themselves.
    try {
      const produced = resolveBlock(block, interpreted, file);
      const real = produced.filter((step) => step.type !== "setup");
      if (real.length === 0) {
        // Setup-only or nothing to assert: keep the setup, count nothing.
        steps.push(...produced);
        if (produced.length === 0) record("nothing to check");
        continue;
      }
      steps.push(...produced);
      perFile[file].cases += real.length;
    } catch (err) {
      if (!(err instanceof Unsupported)) throw err;
      record(err.message);
    }
  }
}

// Keep only the prep for files that actually produced a filesystem case.
const needsTree = new Set(steps.filter((s) => s.type === "glob" || s.type === "setup").map((s) => s.file));
for (const file of Object.keys(prep)) if (!needsTree.has(file)) delete prep[file];

writeFileSync(
  fileURLToPath(new URL("../test/fixtures/ztst.json", import.meta.url)),
  `${JSON.stringify({ steps, skipped, perFile, prep }, null, 2)}\n`,
);

const cases = steps.filter((step) => step.type !== "setup").length;
console.log(`${cases} cases from ${Object.keys(perFile).length} files, ${skipped.length} blocks skipped`);
for (const [file, counts] of Object.entries(perFile)) {
  if (counts.cases > 0) {
    console.log(`  ${file.padEnd(22)} ${String(counts.cases).padStart(4)} cases  (${counts.skipped}/${counts.blocks} blocks skipped)`);
  }
}
const reasons = {};
for (const { why } of skipped) {
  const key = why.startsWith("cannot translate") ? "cannot translate" : why.split(" in ")[0];
  reasons[key] = (reasons[key] ?? 0) + 1;
}
console.log("\nskip reasons:");
for (const [why, n] of Object.entries(reasons).sort((a, b) => b[1] - a[1]).slice(0, 12)) {
  console.log(`  ${String(n).padStart(4)}  ${why}`);
}

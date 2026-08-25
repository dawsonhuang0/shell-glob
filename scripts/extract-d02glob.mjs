/**
 * Extracts the runnable cases from zsh's own globbing test file,
 * Test/D02glob.ztst, into test/fixtures/d02glob.json.
 *
 *     node scripts/extract-d02glob.mjs [path/to/zsh]
 *
 * A .ztst file is a sequence of blocks: indented shell input, then a line
 * "<status>:<name>", then the expected stdout as ">" lines.  We keep the
 * blocks that reduce to filesystem setup, `setopt`, a `print` of a glob, or a
 * `[[ string = pattern ]]` test, and record zsh's own expected output as the
 * fixture.  Everything needing the shell proper — subshells, functions,
 * parameter expansion, `disable -p`, quote stripping — is listed as skipped.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const zshRoot = process.argv[2] ?? fileURLToPath(new URL("../zsh", import.meta.url));
const source = readFileSync(`${zshRoot}/Test/D02glob.ztst`, "latin1").split("\n");

/** Split the file into blocks of { input, status, name, expected }. */
function parseBlocks(lines) {
  const blocks = [];
  let input = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const header = /^(\d+):(.*)$/.exec(line);
    if (header && input.length > 0) {
      const expected = [];
      let fuzzy = false;
      let j = i + 1;
      for (; j < lines.length; j++) {
        if (lines[j].startsWith(">")) expected.push(lines[j].slice(1));
        else if (/^[?*F]/.test(lines[j])) fuzzy = true;
        else break;
      }
      blocks.push({ input, status: Number(header[1]), name: header[2], expected, fuzzy });
      input = [];
      i = j - 1;
      continue;
    }
    if (line.startsWith(" ")) {
      // Drop trailing comments, but not a `#` that is part of a pattern.
      const text = line.replace(/\s+#\s.*$/, "").trim();
      if (text && !text.startsWith("#")) input.push(text);
    }
  }
  return blocks;
}

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
};

/** True if the word contains shell syntax we are not going to interpret. */
function hasShellSyntax(raw) {
  // `<1-10>` is a numeric glob, not a redirection.
  const word = raw.replace(/<\d*-\d*>/g, "");
  if (/[$'"`]/.test(word)) return true;
  let depth = 0;
  for (let i = 0; i < word.length; i++) {
    const c = word[i];
    if (c === "\\") i++;
    else if (c === "(" || c === "[") depth++;
    else if (c === ")" || c === "]") depth--;
    else if (depth === 0 && (c === "|" || c === ";" || c === "&" || c === ">" || c === "<")) {
      return true; // a real pipe or redirection, not a glob operator
    }
  }
  return false;
}

/** `print -rl --`: we only need to know whether output is one word per line. */
function parsePrint(line) {
  const m = /^print((?:\s+-[A-Za-z]+)*)\s+(.*)$/.exec(line);
  if (!m) return null;
  let rest = m[2].trim();
  if (rest.startsWith("-- ")) rest = rest.slice(3).trim();
  if (rest === "--" || rest === "") return null;
  return { perLine: /-[A-Za-z]*l/.test(m[1]), word: rest };
}

const steps = [];
const skipped = [];
/** Options and the tree persist from block to block, as in the shell. */
let options = {};

for (const block of parseBlocks(source)) {
  const skip = (why) => skipped.push({ name: block.name, why });
  if (block.fuzzy) {
    skip("expects stderr or a fuzzy match");
    continue;
  }

  /** Commands in the order the block runs them, since some clean up after. */
  const ordered = [];
  let optionsHere = options;
  let usable = true;

  for (const line of block.input) {
    const setopt = /^(un)?setopt\s+(.+)$/.exec(line);
    if (setopt) {
      for (const raw of setopt[2].split(/\s+/)) {
        let name = raw.toLowerCase().replace(/_/g, "");
        let value = !setopt[1];
        if (!OPTION_NAMES[name] && name.startsWith("no")) {
          name = name.slice(2);
          value = !value;
        }
        const key = OPTION_NAMES[name];
        if (!key) {
          usable = false;
          skip(`option ${raw}`);
          break;
        }
        optionsHere = { ...optionsHere, [key]: value };
      }
      if (!usable) break;
      continue;
    }

    const fs = /^(mkdir|touch|rm)\s+(?:(-\S+)\s+)?(\S+)$/.exec(line);
    if (fs && !/[{}$*?[\]]/.test(fs[3])) {
      ordered.push({ type: "setup", command: fs[1], path: fs[3] });
      continue;
    }

    // `[[ str = pat ]]`, optionally guarding a `print`.
    const cond =
      /^\[\[\s+(\S+)\s+(=|==|!=)\s+(.+?)\s+\]\](?:\s+(&&|\|\|)\s+print\s+(.+))?$/.exec(line);
    if (cond && !/[$'"`]/.test(cond[1]) && !/[$'"`]/.test(cond[3])) {
      ordered.push({
        type: "match",
        string: cond[1],
        pattern: cond[3],
        negated: cond[2] === "!=",
        guard: cond[4] ?? null,
        text: cond[5] ?? null,
        options: optionsHere,
      });
      continue;
    }

    const printed = parsePrint(line);
    if (printed && !hasShellSyntax(printed.word)) {
      ordered.push({ type: "glob", ...printed, options: optionsHere });
      continue;
    }

    usable = false;
    skip(`cannot translate: ${line}`);
    break;
  }

  if (!usable) continue;
  options = optionsHere;
  const asserts = ordered.filter((step) => step.type !== "setup");
  if (asserts.length === 0) {
    steps.push(...ordered);
    continue;
  }

  /** Resolved assertions, keyed by their entry in `ordered`. */
  const resolved = new Map();
  const emit = () => {
    for (const step of ordered) {
      if (step.type === "setup") steps.push(step);
      else if (resolved.has(step)) steps.push(resolved.get(step));
    }
  };

  const globs = asserts.filter((a) => a.type === "glob");
  const matches = asserts.filter((a) => a.type === "match");

  if (globs.length > 0 && matches.length > 0) {
    skip("mixes conditions and globs");
    emit();
    continue;
  }

  if (matches.length > 0) {
    // A bare condition is judged by the block's exit status; a guarded one by
    // whether its `print` shows up in the expected output.
    for (const assert of matches) {
      let expected;
      if (assert.guard === null) {
        if (matches.length > 1 || block.status > 1) {
          skip("condition without a print in a multi-command block");
          expected = null;
        } else {
          expected = block.status === 0;
        }
      } else {
        const printed = block.expected.includes(assert.text);
        expected = assert.guard === "&&" ? printed : !printed;
      }
      if (expected === null) continue;
      resolved.set(assert, {
        type: "match",
        string: assert.string,
        pattern: assert.pattern,
        matches: assert.negated ? !expected : expected,
        options: assert.options,
        name: block.name,
      });
    }
    emit();
    continue;
  }

  if (block.status !== 0) {
    skip("expects a non-zero status");
    emit();
    continue;
  }
  if (globs.length === 1 && globs[0].perLine) {
    resolved.set(globs[0], {
      type: "glob",
      word: globs[0].word,
      expected: block.expected,
      options: globs[0].options,
      name: block.name,
    });
    emit();
    continue;
  }
  if (globs.every((glob) => !glob.perLine) && globs.length === block.expected.length) {
    // `print` writes its arguments space separated on one line.
    for (const [i, glob] of globs.entries()) {
      const line = block.expected[i];
      const words = line === "" ? [] : line.split(" ");
      if (words.some((word) => word === "")) {
        skip("output contains an empty word");
        continue;
      }
      resolved.set(glob, {
        type: "glob",
        word: glob.word,
        expected: words,
        options: glob.options,
        name: block.name,
      });
    }
    emit();
    continue;
  }
  skip("output does not line up with the commands");
  emit();
}

const cases = steps.filter((step) => step.type !== "setup").length;
writeFileSync(
  fileURLToPath(new URL("../test/fixtures/d02glob.json", import.meta.url)),
  `${JSON.stringify({ steps, skipped }, null, 2)}\n`,
);
console.log(`${cases} cases, ${steps.length - cases} setup steps, ${skipped.length} blocks skipped`);
for (const { name, why } of skipped) console.log(`  skipped: ${name} (${why})`);

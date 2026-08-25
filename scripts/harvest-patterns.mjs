/**
 * Harvests every pattern-shaped string out of zsh's entire test suite, then
 * emits a zsh script that evaluates each one so the real shell supplies the
 * expected answers.
 *
 *     node scripts/harvest-patterns.mjs > /tmp/harvest.zsh
 *     zsh -f /tmp/harvest.zsh > test/fixtures/harvested.txt
 *
 * The point is that we never interpret the shell ourselves.  We only need to
 * spot the patterns; zsh decides what they mean.
 */
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { isPortable, loadPatlog, toUtf8 } from "./patlog.mjs";

const zshRoot = process.argv[2] ?? fileURLToPath(new URL("../zsh", import.meta.url));

/**
 * Text we refuse to hand to the shell: anything that expands a parameter or
 * runs a command, rather than just matching.  `${unset?oops}` would abort the
 * harvest, and an `e:...:` qualifier would execute code.
 */
const RUNS_CODE = /[$`]|\(#q[^)]*[e+]|\([^)]*\be[:[{(<]|\(\+[A-Za-z_]/;

/** Is this worth testing, i.e. does it use a pattern operator at all? */
function isPattern(text) {
  if (!text || text.length > 120) return false;
  if (RUNS_CODE.test(text)) return false;
  // A backslash is fine: `zshtokenize()` treats it as an escape, the same as
  // this package does.  A leading `~` is filename expansion, but only at the
  // start of a word, so the sweep prefixes a sentinel to both the pattern and
  // every subject and the operator meaning is preserved.

  let escaped = false;
  for (let i = 0; i < text.length; i++) {
    if (escaped) {
      escaped = false;
      continue;
    }
    if (text[i] === "\\") {
      escaped = true;
      continue;
    }
    if ("*?[(<^#~|".includes(text[i])) return true;
  }
  return false;
}

const patterns = new Set();
const subjects = new Set();

/** Pull the interesting fragments out of one line of a test file. */
function harvestLine(line) {
  // `[[ x = pat ]]` in any of its spellings.
  for (const m of line.matchAll(/\[\[\s+(\S+)\s+[=!]=?\s+(.+?)\s+\]\]/g)) {
    subjects.add(m[1]);
    patterns.add(m[2]);
  }
  // `${var#pat}` and friends: the pattern is everything after the operator.
  for (const m of line.matchAll(/\$\{[A-Za-z_][A-Za-z0-9_]*(?:##?|%%?|\/\/?)([^}]*)\}/g)) {
    patterns.add(m[1]);
  }
  // The `res str pat` corpus lines of Misc/globtests.
  const corpus = /^([tf])\s+(\S+)\s+(\S.*?)\s*$/.exec(line);
  if (corpus) {
    subjects.add(corpus[2]);
    patterns.add(corpus[3]);
  }
  // Any bare word that looks like a glob.
  for (const word of line.split(/\s+/)) patterns.add(word);
}

/**
 * Scans a whole file for `case` statements and returns their arm patterns.
 * A `case` arm separates alternatives with a top level `|`, which an ordinary
 * pattern has to spell as a parenthesised group, so `a | b` becomes `(a|b)`.
 */
function harvestCaseArms(text) {
  const found = [];
  let depth = 0;
  for (const raw of text.split("\n")) {
    const line = raw.replace(/^[>?*]/, "").trim();
    if (/^case\s+.*\s+in\s*\{?$/.test(line)) {
      depth++;
      continue;
    }
    if (depth === 0) continue;
    if (/^(esac|\})/.test(line)) {
      depth--;
      continue;
    }
    // `pat)` or `(pat)`, with the body possibly on the same line.
    const m = /^\(?\s*([^)]*?)\s*\)/.exec(line);
    if (!m || m[1] === "") continue;
    const arm = m[1];
    if (/^\s*$/.test(arm)) continue;
    const alternatives = arm.split("|").map((part) => part.trim());
    found.push(alternatives.length > 1 ? `(${alternatives.join("|")})` : alternatives[0]);
    // Each alternative is a usable pattern in its own right too.
    for (const alternative of alternatives) found.push(alternative);
  }
  return found;
}

const files = [];
for (const name of readdirSync(`${zshRoot}/Test`)) {
  if (name.endsWith(".ztst")) files.push(`${zshRoot}/Test/${name}`);
}
files.push(`${zshRoot}/Misc/globtests`, `${zshRoot}/Misc/globtests.ksh`);

for (const file of files) {
  const bytes = readFileSync(file);
  let text;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    text = bytes.toString("latin1");
  }
  for (const line of text.split("\n")) {
    if (line.startsWith("#") || line.startsWith("F:")) continue;
    // A ".ztst" result header is "<status>:<test name>", i.e. prose, not shell
    // code: scraping it invents patterns such as "0:=(...)".
    if (/^\d+:/.test(line)) continue;
    harvestLine(line.replace(/^[>?*]/, ""));
  }
  for (const arm of harvestCaseArms(text)) patterns.add(arm);
}

/*
 * The authoritative list is what an instrumented zsh recorded while running
 * its own test suite: that captures patterns assembled at run time, which
 * reading the test files cannot.  Scraping the files is the fallback.
 */
const logged = loadPatlog();
/** Patterns taken from the log, which need no `isPattern` filtering. */
const fromLog = new Set();
if (logged) {
  for (const entry of logged) {
    if (entry.file) continue; // filename generation is harvested separately
    if (!isPortable(entry.pattern)) continue;
    const text = toUtf8(entry.pattern);
    // These came out of `patcompile()`, so any `$` in them is a literal
    // character rather than an expansion -- and `${~pat}` does not re-run
    // command substitution on a value, so they are safe to hand to the shell.
    fromLog.add(text);
    patterns.add(text);
  }
  console.error(`pattern log contributed ${logged.filter((e) => !e.file).length} entries`);
}

// Keep the real patterns, and build a subject set to match them against.
const keptPatterns = [...patterns]
  .filter((text) => fromLog.has(text) || isPattern(text))
  .sort();
const keptSubjects = [...subjects]
  .filter((s) => s && s.length <= 40 && !/[\x00-\x1f$`'"]/.test(s))
  .sort();

/** Subjects every pattern is tried against, so the truth table has substance. */
const BASE_SUBJECTS = [
  // No subject here holds a byte that is not a character.  The `[:alpha:]`
  // family is implemented with the operating system's own macros -- `isalpha`
  // on a byte, `iswalpha` on a character -- so how zsh classifies such a byte
  // depends on the C library and the locale, while this package is
  // deterministic.  `[:INCOMPLETE:]` and `[:INVALID:]` are covered instead by
  // test/classes.test.ts, against answers taken from zsh directly.
  "a", "b", "ab", "abc", "abcd", "foo", "foobar", "bar", "foo.c", "lex.c",
  "README", "readme", "FOO", "Foo", "a.b.c", "123", "0", "a1", "1a", "-", "]",
  "^", "~", "#", ".", "..", ".hidden", "a/b", "x", "xyz", "fofo", "ffo",
  "foooofof", "aaa", "aXbXc", "é", "ünïcode",
];

const useSubjects = [...new Set([...BASE_SUBJECTS, ...keptSubjects.slice(0, 24)])];

// Emit a zsh program that prints one line per (pattern, subject) pair.
/*
 * The options that actually change how a pattern matches, verified against the
 * built zsh: CASE_GLOB and BAD_PATTERN do not reach `[[ str = pat ]]`, so they
 * are not swept here.  Every combination of these is tried, which is what the
 * fixture's combo index refers to.
 */
const COMBO_OPTIONS = ["extendedglob", "kshglob", "shglob", "multibyte", "posixidentifiers"];
/** Prefixed to a pattern starting with `~`, to stop filename expansion. */
const TILDE_SENTINEL = "Z";
const COMBO_COUNT = 1 << COMBO_OPTIONS.length;

const out = [];
out.push("#!/usr/bin/env zsh -f");
out.push("# Generated by scripts/harvest-patterns.mjs -- do not edit.");
out.push('print -r -- "#zsh\t$ZSH_VERSION"');
out.push(`print -r -- "#options\t${COMBO_OPTIONS.join("\t")}"`);
out.push("emulate -L zsh");
out.push("setopt nobadpattern nonomatch");
out.push("subjects=(");
for (const s of useSubjects) out.push(`  ${zshLiteral(s)}`);
out.push(")");
// The subjects go to JSON for the same reason the patterns do: a subject may
// hold a byte that is not a character, which a text fixture cannot carry.
writeFileSync(
  fileURLToPath(new URL("../test/fixtures/subjects.json", import.meta.url)),
  `${JSON.stringify(useSubjects)}\n`,
);
out.push("patterns=(");
// Emitted the same way as the subjects: a pattern may hold a byte that is not
// a character, which has to reach the shell as that byte.
for (const p of keptPatterns) out.push(`  ${zshLiteral(p)}`);
out.push(")");
// Report the index rather than the text: a pattern may hold a tab or a
// newline, which a line based fixture cannot carry.  scripts/patterns.json
// holds the texts, written by node, where encoding is not a problem.
writeFileSync(
  fileURLToPath(new URL("../test/fixtures/patterns.json", import.meta.url)),
  `${JSON.stringify(keptPatterns)}\n`,
);
// A leading `~` is filename expansion, which happens only at the start of a
// word: prefixing a sentinel to the pattern and to every subject leaves the
// matching semantics alone while stopping `~` from expanding.  The test in
// test/harvested.test.ts applies exactly the same rule.
out.push(`sentinel=${quote(TILDE_SENTINEL)}`);
out.push([
  `for combo in {0..${COMBO_COUNT - 1}}; do`,
  "  for idx in {1..$#patterns}; do",
  "    pat=$patterns[idx]",
  "    # Each pattern runs in its own subshell: a pattern that is a shell",
  "    # syntax error aborts only its own evaluation, not the harvest.",
  "    bits=$(",
  "      i=0",
  `      for opt in ${COMBO_OPTIONS.join(" ")}; do`,
  "        if (( (combo >> i) & 1 )); then setopt $opt; else unsetopt $opt; fi",
  "        (( i++ ))",
  "      done",
  "      out=",
  "      if [[ $pat = '~'* ]]; then prefix=$sentinel; else prefix=; fi",
  "      for str in $subjects; do",
  "        lhs=$prefix$str",
  "        rhs=$prefix$pat",
  "        if [[ $lhs = ${~rhs} ]] 2>/dev/null; then out=${out}1; else out=${out}0; fi",
  "      done",
  "      print -rn -- $out",
  "    ) 2>/dev/null",
  "    # A short result means the shell gave up part way through; skip it.",
  "    # A short result means the shell refused the pattern under these",
  "    # options -- BAD_PATTERN is only consulted for filename generation, so",
  "    # a malformed pattern is always an error here.  Record that, so the",
  "    # port can be checked to reject it too.",
  '    if [[ $#bits -eq $#subjects ]]; then',
  '      print -r -- "$combo\t$bits\t$idx"',
  "    else",
  '      print -r -- "$combo!\t\t$idx"',
  "    fi",
  "  done",
  "done",
].join("\n"));

/**
 * A zsh literal for a subject: `$'...'` with `\xNN` for every byte that is not
 * a character, so the shell sees exactly the bytes this string stands for.
 */
function zshLiteral(text) {
  const needsEscape = [...text].some((c) => {
    const code = c.charCodeAt(0);
    return code < 0x20 || (code >= 0xdc80 && code <= 0xdcff) || code === 0x7f;
  });
  if (!needsEscape) return quote(text);
  let out = "$'";
  for (const ch of text) {
    const code = ch.charCodeAt(0);
    if (code >= 0xdc80 && code <= 0xdcff) out += `\\x${(code - 0xdc00).toString(16)}`;
    else if (code < 0x20 || code === 0x7f) out += `\\x${code.toString(16).padStart(2, "0")}`;
    else if (ch === "'" || ch === "\\") out += `\\${ch}`;
    else out += ch;
  }
  return `${out}'`;
}

function quote(s) {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

process.stdout.write(out.join("\n"));
console.error(
  `harvested ${keptPatterns.length} patterns x ${useSubjects.length} subjects ` +
    `x ${COMBO_COUNT} option combinations = ` +
    `${keptPatterns.length * useSubjects.length * COMBO_COUNT} assertions`,
);

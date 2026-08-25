/**
 * Harvests every filename generation pattern out of zsh's test suite and emits
 * a zsh script that expands each one in a fixed tree, so the real shell decides
 * what each pattern produces.
 *
 *     node scripts/harvest-globs.mjs > /tmp/globs.zsh
 *     zsh -f /tmp/globs.zsh > test/fixtures/harvested-globs.txt
 *
 * As with the pattern harvest, we only spot the globs; zsh expands them.
 *
 * The `Y` qualifier returns matches in directory traversal order, which is not
 * reproducible across two separately created trees, so the test compares only
 * how many files those globs produce.
 */
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { isPortable, loadPatlog, toUtf8 } from "./patlog.mjs";

const zshRoot = process.argv[2] ?? fileURLToPath(new URL("../zsh", import.meta.url));

/** A glob we refuse to run: it would expand a parameter or execute code. */
// `[:INCOMPLETE:]` and `[:INVALID:]` match raw bytes that are not valid
// characters; a JavaScript string cannot hold those at all, so they are out of
// scope rather than a difference worth recording.
const UNSAFE = /\[:(INCOMPLETE|INVALID):\]|[$`]|\(#q[^)]*[e+]|\([^)]*\be[:[{(<]|\(\+[A-Za-z_]|^~|^\/|^=/;

/** Does the word use an operator that makes it a glob at all? */
function isGlob(word) {
  if (!word || word.length > 4000) return false;
  if (UNSAFE.test(word)) return false;
  if (/[\x00-\x1f'"]/.test(word)) return false;

  if (/[{}]/.test(word)) return false; // brace expansion is a separate stage
  // Redirections are not globs: `<<-EOF`, `3<file`, `>out` and friends.
  if (/^\d*[<>]/.test(word) || word.includes("<<")) return false;
  // `<` is only an operator when it opens a numeric range such as `<1-10>`.
  if (/<\d*-\d*>/.test(word)) return true;
  let escaped = false;
  for (const ch of word) {
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === "\\") {
      escaped = true;
      continue;
    }
    if ("*?[(^#".includes(ch)) return true;
  }
  return false;
}

/**
 * Tokenizes a line into shell words, tracking which characters were quoted.
 * `pattern` is the word with every quoted character backslash escaped, so it
 * keeps its glob meaning only where the shell would have kept it.
 */
function shellWords(line) {
  const SPECIAL = /[*?[\]()<>^#~|\\!-]/;
  const out = [];
  let current = "";
  let started = false;
  let quote = null;
  const push = (ch, quoted) => {
    current += quoted && SPECIAL.test(ch) ? `\\${ch}` : ch;
    started = true;
  };
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quote) {
      if (c === quote) quote = null;
      else push(c, true);
      continue;
    }
    if (c === "'" || c === '"') {
      quote = c;
      started = true;
      continue;
    }
    if (c === "\\") {
      i++;
      if (i < line.length) push(line[i], true);
      continue;
    }
    if (/[\s;|&]/.test(c)) {
      if (started) out.push(current);
      current = "";
      started = false;
      continue;
    }
    push(c, false);
  }
  if (started) out.push(current);
  return out;
}

/**
 * Collects the filenames zsh's tests actually create or expect, so the tree we
 * expand against contains the names the globs are written for.  Without this
 * most globs expand to nothing and the comparison says very little.
 */
function harvestNames(text) {
  const names = new Set();
  const add = (raw) => {
    if (!raw) return;
    let name = raw.replace(/^glob\.tmp\//, "").replace(/^\.\//, "");
    if (!name || name.length > 40) return;
    if (/[$`'"*?[\]()<>^#~|\\{}]/.test(name)) return;
    if (name.startsWith("/") || name.split("/").includes("..")) return;
    if (!/^[A-Za-z0-9._+@-][A-Za-z0-9._+@/-]*$/.test(name)) return;
    if (name.endsWith("/")) name = name.slice(0, -1);
    if (name === "." || name === "") return;
    names.add(name);
  };
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    // Files the tests build.
    let m = /^(?:touch|mkdir)\s+(?:-\S+\s+)?(\S+)\s*$/.exec(line);
    if (m) add(m[1]);
    m = /^:\s*>\s*(\S+)\s*$/.exec(line);
    if (m) add(m[1]);
    m = /^ln\s+-s\s+\S+\s+(\S+)\s*$/.exec(line);
    if (m) add(m[1]);
  }
  return names;
}

const treeNames = new Set();
const globs = new Set();
for (const name of readdirSync(`${zshRoot}/Test`)) {
  if (!name.endsWith(".ztst")) continue;
  const text = readFileSync(`${zshRoot}/Test/${name}`, "latin1");
  for (const name of harvestNames(text)) treeNames.add(name);
  for (const raw of text.split("\n")) {
    if (raw.startsWith("#")) continue;
    // A ".ztst" result header is "<status>:<test name>", i.e. prose, not shell
    // code: scraping it invents patterns such as "0:=(...)".
    if (/^\d+:/.test(raw)) continue;
    for (const word of shellWords(raw.replace(/^[>?*]/, ""))) {
      // Anything zsh rejects is dropped by the harvest itself, so it is safe
      // to offer it every word that still looks like a glob.
      const candidate = word.replace(/^glob\.tmp\//, "");
      if (isGlob(candidate)) globs.add(candidate);
      if (isGlob(word)) globs.add(word);
    }
  }
}

/**
 * Builds one plausible filename for a glob, by replacing each operator with
 * something it can match.  Whatever this produces, zsh still decides what the
 * glob expands to, so a wrong guess only costs a file nobody matches -- it can
 * never make a comparison pass that should have failed.
 */
function concreteName(glob) {
  let name = glob.replace(/\((#q)?[^()]*\)$/, ""); // drop trailing qualifiers
  name = name
    .replace(/\*\*\*?\//g, "dir1/")
    .replace(/\(([^()|]*)\|[^()]*\)/g, "$1") // first alternative
    .replace(/<(\d*)-\d*>/g, (_, from) => from || "1")
    .replace(/\[\[:[a-zA-Z]+:\]\]/g, "a")
    .replace(/\[\^[^\]]*\]/g, "q")
    .replace(/\[([^\]])[^\]]*\]/g, "$1")
    .replace(/\(#[^)]*\)/g, "")
    .replace(/[()#^]/g, "")
    .replace(/\*/g, "x")
    .replace(/\?/g, "y")
    .replace(/~.*$/, "")
    .replace(/\\(.)/g, "$1");
  if (!name || name.length > 40) return null;
  if (!/^[A-Za-z0-9._+=,%@-][A-Za-z0-9._+=,%@/-]*$/.test(name)) return null;
  if (name.split("/").some((part) => part === "" || part === ".." )) return null;
  return name;
}

/*
 * As for patterns: prefer what the instrumented zsh actually compiled while
 * running its own test suite over what can be scraped from the test files.
 */
const loggedGlobs = loadPatlog();
if (loggedGlobs) {
  let added = 0;
  for (const entry of loggedGlobs) {
    if (!entry.file) continue;
    if (!isPortable(entry.pattern, { file: true })) continue;
    const text = toUtf8(entry.pattern);
    // A word zsh compiled as a glob belongs in the corpus even when it holds
    // no operator: the shell still decided what it expands to.  These came out
    // of `patcompile()`, so a `$` in them is a literal character, and `${~g}`
    // does not expand a value a second time.
    const risky = /`|\(#q[^)]*[e+]|\([^)]*\be[:[{(<]|\(\+[A-Za-z_]/;
    if (!risky.test(text) && !/[\t\n\r]/.test(text)) {
      globs.add(text);
      added++;
    }
  }
  console.error(`pattern log contributed ${added} globs`);
}

const quote = (s) => `'${s.replace(/'/g, `'\\''`)}'`;

/** As in the pattern harvest: `$'..'` when the word holds a raw byte. */
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
const list = [...globs].sort();

const out = [];
out.push("#!/usr/bin/env zsh -f");
out.push("# Generated by scripts/harvest-globs.mjs -- do not edit.");
out.push('print -r -- "#zsh\t$ZSH_VERSION"');
out.push("emulate -L zsh");
// Leave BAD_PATTERN at its default, so a malformed glob errors and is
// dropped from the corpus: this fixture is about globbing, not about how the
// shell passes an unparseable word through.
out.push("setopt extendedglob nullglob");
out.push("unsetopt kshglob");
out.push('root=$(mktemp -d)');
out.push('cd $root || exit 1');
// The tree: D02glob's own %prep, plus the file types qualifiers care about.
out.push(`
mkdir -p dir1 dir2 dir3/subdir dir4 .hiddendir
for f in a b c; do : > $f; : > dir1/$f; : > dir2/$f; done
: > .hidden
: > dir3/z.txt
: > dir3/subdir/x.txt
print -n aaaa > small
print -n "$(head -c 2000 < /dev/zero | tr '\\0' x)" > big
: > exec.sh; chmod 755 exec.sh
: > noperm; chmod 000 noperm
ln -s dir1 linkdir
ln -s nowhere brokenlink
mkfifo fifo 2>/dev/null
mkdir -p emptydir
: > lex.c; : > lex.h; : > parse.c; : > parse.h
: > file1; : > file2; : > file10
touch -t 200001010000 old.txt
: > new.txt
`);
// The tree: a fixed core plus every plain filename zsh's tests mention.
const synthesised = new Set();
for (const glob of globs) {
  const name = concreteName(glob);
  if (name) synthesised.add(name);
}
const extraNames = [...new Set([...treeNames, ...synthesised])]
  .filter((n) => !["a", "b", "c"].includes(n))
  .sort()
  .slice(0, 600);
out.push("extra=(");
for (const name of extraNames) out.push(`  ${quote(name)}`);
out.push(")");
out.push([
  "for n in $extra; do",
  "  if [[ $n = */* ]]; then mkdir -p ${n:h} 2>/dev/null; fi",
  "  [[ -e $n ]] || : > $n 2>/dev/null",
  "done",
  "# Record the tree so the test suite can build exactly the same one.",
  "treedirs=( **/*(D/) ); treefiles=( **/*(D.) ); treelinks=( **/*(D@) )",
  `print -r -- "#treedirs\t\${(pj:\u0001:)treedirs}"`,
  `print -r -- "#treefiles\t\${(pj:\u0001:)treefiles}"`,
  `print -r -- "#treelinks\t\${(pj:\u0001:)treelinks}"`,
].join("\n"));
out.push("globs=(");
for (const g of list) out.push(`  ${zshLiteral(g)}`);
out.push(")");
// Report the index rather than the text, as the pattern sweep does: a glob may
// hold a byte that is not a character, which a line based fixture cannot
// carry.  fixtures/globs.json holds the texts, written by node.
writeFileSync(
  fileURLToPath(new URL("../test/fixtures/globs.json", import.meta.url)),
  `${JSON.stringify(list)}\n`,
);
// A leading `~` would be filename expansion, which happens only at the start
// of a word: the sentinel keeps `~` as the operator it is in the pattern.
// test/harvested-globs.test.ts applies the same rule.
out.push(`sentinel=${quote("Z")}`);
/*
 * The options that change what a glob expands to.  Every combination is tried;
 * NUMERIC_GLOB_SORT, MARK_DIRS, LIST_TYPES, CASE_PATHS and the NULL_GLOB
 * family have their own tests, since they change presentation or error
 * handling rather than which files match.
 */
const GLOB_COMBO_OPTIONS = ["extendedglob", "kshglob", "shglob", "globdots", "bareglobqual"];
const GLOB_COMBO_COUNT = 1 << GLOB_COMBO_OPTIONS.length;

out.push(`print -r -- "#options\t${GLOB_COMBO_OPTIONS.join("\t")}"`);
out.push([
  `for combo in {0..${GLOB_COMBO_COUNT - 1}}; do`,
  "  for idx in {1..$#globs}; do",
  "    g=$globs[idx]",
  "    # Each expansion runs in its own subshell so a bad glob cannot abort",
  "    # the harvest, and so options do not leak between cases.  errexit makes",
  "    # a glob zsh rejects fail the subshell, which records it as rejected.",
  "    result=$(",
  "      i=0",
  `      for opt in ${GLOB_COMBO_OPTIONS.join(" ")}; do`,
  "        if (( (combo >> i) & 1 )); then setopt $opt; else unsetopt $opt; fi",
  "        i=$(( i + 1 ))",
  "      done",
  "      # errexit only after the options are set: `(( i++ ))` returns a",
  "      # non-zero status when i is 0, which would abort the subshell.",
  "      setopt errexit badpattern nullglob",
  "      if [[ $g = '~'* ]]; then use=$sentinel$g; else use=$g; fi",
  "      matches=( ${~use} )",
  "      print -rn -- ${(pj:\u0001:)matches}",
  "    ) 2>/dev/null",
  "    rc=$?",
  "    if [[ $rc -eq 0 ]]; then",
  '      print -r -- "$combo\t$idx\t$result"',
  "    else",
  '      print -r -- "$combo!\t$idx\t"',
  "    fi",
  "  done",
  "done",
].join("\n"));
out.push('cd /; rm -rf $root');

process.stdout.write(out.join("\n"));
console.error(
  `harvested ${list.length} globs x ${GLOB_COMBO_COUNT} option combinations = ` +
    `${list.length * GLOB_COMBO_COUNT} expansions`,
);

/**
 * Compares this package against the zsh built from ./zsh, on the two things it
 * does: matching a pattern against strings, and expanding a glob over a tree.
 *
 *   node scripts/bench.mjs
 *
 * Both sides do the same work inside one process, so what is measured is the
 * matching and the walking rather than process start-up.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { compile, glob, globSync } from "../dist/index.js";

const ZSH = fileURLToPath(new URL("../zsh/Src/zsh", import.meta.url));

const PATTERNS = [
  "*.c",
  "*.[ch]",
  "(foo|bar)*baz",
  "*(#i)README*",
  "[[:alpha:]]##[0-9]#",
  "**/*.ts",
  "(a*|b*)~*tmp*",
  "<1-1000>.log",
  "?????.txt",
  "*foo*bar*baz*",
];

const SUBJECTS = [
  "main.c", "main.h", "README.md", "readme", "foobarbaz", "abc123",
  "src/index.ts", "atmp", "42.log", "hello.txt", "x", "foo_bar_baz",
  "aaaaaaaaaaaaaaaaaaaa", "deeply/nested/path/file.ts", "12345.txt",
];

const MATCH_ROUNDS = 400;

function benchMatchOurs() {
  const compiled = PATTERNS.map((p) => compile(p, { extendedGlob: true }));
  const start = process.hrtime.bigint();
  let hits = 0;
  for (let round = 0; round < MATCH_ROUNDS; round++) {
    for (const pattern of compiled) {
      for (const subject of SUBJECTS) if (pattern.test(subject)) hits++;
    }
  }
  return { ms: Number(process.hrtime.bigint() - start) / 1e6, hits };
}

function benchMatchZsh() {
  const script = `
emulate -L zsh
setopt extendedglob
patterns=(${PATTERNS.map((p) => `'${p.replace(/'/g, `'\\''`)}'`).join(" ")})
subjects=(${SUBJECTS.map((s) => `'${s}'`).join(" ")})
hits=0
typeset -F SECONDS
start=$SECONDS
for (( round = 1; round <= ${MATCH_ROUNDS}; round++ )); do
  for pat in $patterns; do
    for str in $subjects; do
      [[ $str = ${"${~pat}"} ]] && (( hits++ ))
    done
  done
done
print -r -- "$(( (SECONDS - start) * 1000 )) $hits"
`.replace("${\"${~pat}\"}", "${~pat}");
  const out = execFileSync(ZSH, ["-f", "-c", script], { encoding: "utf8" }).trim();
  const [ms, hits] = out.split(/\s+/);
  return { ms: Number(ms), hits: Number(hits) };
}

/** A tree with enough files that walking it is the dominant cost. */
function buildTree() {
  const root = mkdtempSync(join(tmpdir(), "zg-bench-"));
  for (let d = 0; d < 40; d++) {
    const dir = join(root, `dir${d}`, `sub${d % 5}`);
    mkdirSync(dir, { recursive: true });
    for (let f = 0; f < 50; f++) {
      writeFileSync(join(dir, `file${f}.${f % 3 === 0 ? "ts" : "txt"}`), "");
    }
  }
  return root;
}

const GLOBS = ["**/*.ts", "dir*/sub*/file1?.txt", "**/file4[0-9].*", "dir<1-20>/**/*.ts"];
const GLOB_ROUNDS = 15;

function benchGlobOurs(root) {
  const start = process.hrtime.bigint();
  let found = 0;
  for (let round = 0; round < GLOB_ROUNDS; round++) {
    for (const g of GLOBS) found += globSync(g, { cwd: root, extendedGlob: true, nullGlob: true }).length;
  }
  return { ms: Number(process.hrtime.bigint() - start) / 1e6, found };
}

/**
 * The same expansions read asynchronously.  Node can have several directory
 * reads in flight at once, which a shell walking a tree cannot, so this is the
 * one place where the work itself is arranged differently rather than merely
 * done faster.
 */
async function benchGlobOursAsync(root) {
  const start = process.hrtime.bigint();
  let found = 0;
  for (let round = 0; round < GLOB_ROUNDS; round++) {
    for (const g of GLOBS) {
      found += (await glob(g, { cwd: root, extendedGlob: true, nullGlob: true })).length;
    }
  }
  return { ms: Number(process.hrtime.bigint() - start) / 1e6, found };
}

function benchGlobZsh(root) {
  const script = `
emulate -L zsh
setopt extendedglob nullglob
cd ${root}
globs=(${GLOBS.map((g) => `'${g}'`).join(" ")})
found=0
typeset -F SECONDS
start=$SECONDS
for (( round = 1; round <= ${GLOB_ROUNDS}; round++ )); do
  for g in $globs; do
    matches=( \${~g} )
    (( found += $#matches ))
  done
done
print -r -- "$(( (SECONDS - start) * 1000 )) $found"
`;
  const out = execFileSync(ZSH, ["-f", "-c", script], { encoding: "utf8" }).trim();
  const [ms, found] = out.split(/\s+/);
  return { ms: Number(ms), found: Number(found) };
}

/**
 * The two patterns zsh's own Misc/globtests corpus uses to exercise nested
 * closures.  Both sides need P_WBRANCH's per-position mark to answer them at
 * all; without it the work doubles every few characters.
 */
const NESTED = [
  ["(f#o#)#", "setopt extendedglob", { extendedGlob: true }],
  ["*(*(f)*(o))", "setopt extendedglob kshglob", { extendedGlob: true, kshGlob: true }],
];
const NESTED_SUBJECT = "fffooofoooooffoofffooofffx".repeat(16).slice(0, 400);
const NESTED_ROUNDS = 200;

function benchNestedOurs(pattern, options) {
  const compiled = compile(pattern, options);
  compiled.test(NESTED_SUBJECT);
  const start = process.hrtime.bigint();
  for (let round = 0; round < NESTED_ROUNDS; round++) compiled.test(NESTED_SUBJECT);
  return { ms: Number(process.hrtime.bigint() - start) / 1e6 };
}

function benchNestedZsh(pattern, setopt) {
  const script = `
emulate -L zsh
${setopt}
str='${NESTED_SUBJECT}'
pat='${pattern}'
typeset -F SECONDS
start=$SECONDS
for (( round = 1; round <= ${NESTED_ROUNDS}; round++ )); do
  [[ $str = ${"${~pat}"} ]]
done
print -r -- "$(( (SECONDS - start) * 1000 ))"
`.replace("${\"${~pat}\"}", "${~pat}");
  return { ms: Number(execFileSync(ZSH, ["-f", "-c", script], { encoding: "utf8" }).trim()) };
}

const row = (label, ours, zsh, unit) => {
  const ratio = zsh.ms / ours.ms;
  const verdict = ratio >= 1 ? `${ratio.toFixed(2)}x faster` : `${(1 / ratio).toFixed(2)}x slower`;
  console.log(
    `${label.padEnd(22)} ours ${ours.ms.toFixed(1).padStart(8)}ms   ` +
      `zsh ${zsh.ms.toFixed(1).padStart(8)}ms   ${verdict.padStart(14)}   ${unit}`,
  );
};

// Warm up, so what is timed is steady-state work rather than first-call JIT.
benchMatchOurs();
const tree = buildTree();
try {
  benchGlobOurs(tree);
  await benchGlobOursAsync(tree);

  benchMatchOurs(); // again, after the glob warm-up has churned the heap
  const matchOurs = benchMatchOurs();
  const matchZsh = benchMatchZsh();
  const globOurs = benchGlobOurs(tree);
  const globAsync = await benchGlobOursAsync(tree);
  const globZsh = benchGlobZsh(tree);

  const matchOps = PATTERNS.length * SUBJECTS.length * MATCH_ROUNDS;
  console.log(`matching: ${matchOps} tests, globbing: ${GLOBS.length * GLOB_ROUNDS} expansions\n`);
  row("pattern matching", matchOurs, matchZsh, `${matchOurs.hits} vs ${matchZsh.hits} hits`);
  row("filename generation", globOurs, globZsh, `${globOurs.found} vs ${globZsh.found} files`);
  row("  the same, async", globAsync, globZsh, `${globAsync.found} vs ${globZsh.found} files`);

  console.log(
    `\nnested closures over a ${NESTED_SUBJECT.length} character subject, ` +
      `${NESTED_ROUNDS} rounds each:\n`,
  );
  for (const [pattern, setopt, options] of NESTED) {
    row(pattern, benchNestedOurs(pattern, options), benchNestedZsh(pattern, setopt), "no match");
  }
} finally {
  rmSync(tree, { recursive: true, force: true });
}

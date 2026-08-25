/**
 * Reports how much of what zsh actually compiled ends up in the corpus, and
 * how many option combinations each case is asserted under.
 *
 *   node scripts/coverage-report.mjs
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { isPortable, loadPatlog, toUtf8 } from "./patlog.mjs";

/** The pattern sweep stores indices into this list, not the texts. */
const patternTexts = JSON.parse(
  readFileSync(fileURLToPath(new URL("../test/fixtures/patterns.json", import.meta.url)), "utf8"),
);
const patternAt = (index) => patternTexts[Number(index) - 1];

/** The glob sweep stores indices too. */
const globTexts = JSON.parse(
  readFileSync(fileURLToPath(new URL("../test/fixtures/globs.json", import.meta.url)), "utf8"),
);
const globAt = (index) => globTexts[Number(index) - 1];

const read = (name) =>
  readFileSync(fileURLToPath(new URL(`../test/fixtures/${name}`, import.meta.url)), "utf8")
    .split("\n")
    .filter((line) => line.length > 0);

const countBits = (hex) => {
  let bits = 0;
  // The mask may carry `j` (JSON encoded), `p` (passed through) and `!`.
  let value = BigInt(`0x${hex.replace(/[jp!]/g, "")}`);
  while (value) {
    bits += Number(value & 1n);
    value >>= 1n;
  }
  return bits;
};

function summarise(name, keyIndex, mapKey = (v) => v) {
  const lines = read(name);
  const rows = lines.filter((line) => !line.startsWith("#"));
  const cases = new Set(rows.map((line) => mapKey(line.split("\t")[keyIndex])));
  const pairs = rows.reduce((sum, line) => sum + countBits(line.split("\t")[0]), 0);
  return { rows: rows.length, cases, pairs };
}

const patterns = summarise("harvested.txt", 2, patternAt);
const globs = summarise("harvested-globs.txt", 1, globAt);
const inCorpus = new Set([...patterns.cases, ...globs.cases]);

const logged = loadPatlog();
console.log("=== corpus completeness (against what zsh compiled)");
if (!logged) {
  console.log("  no pattern log; run `npm run patlog` first");
} else {
  const portable = logged.filter((e) => isPortable(e.pattern, { file: e.file }));
  const covered = portable.filter((e) => inCorpus.has(toUtf8(e.pattern)));
  const missing = portable.filter((e) => !inCorpus.has(toUtf8(e.pattern)));
  const pct = (n) => `${((100 * n) / logged.length).toFixed(1)}%`;
  console.log(`  logged distinct tuples : ${logged.length}`);
  console.log(`  portable               : ${portable.length} (${pct(portable.length)})`);
  console.log(`  present in the corpus  : ${covered.length} (${pct(covered.length)})`);
  const why = {};
  for (const entry of missing) {
    const text = toUtf8(entry.pattern);
    let reason = "other";
    if (/\[:(INCOMPLETE|INVALID):\]/.test(text)) reason = "byte-level character class";
    else if (text.includes("\\")) reason = "backslash (escape vs literal)";
    else if (text.startsWith("~")) reason = "tilde expansion";
    else if (/\(#q[^)]*[e+]|\([^)]*\be[:[{(<]/.test(text)) reason = "qualifier running shell code";
    else if (/[{}]/.test(text)) reason = "brace expansion";
    else if (entry.file && /\(#?q?[^)]*Y\d/.test(text)) reason = "Y (traversal order)";
    why[reason] = (why[reason] ?? 0) + 1;
  }
  for (const [reason, n] of Object.entries(why).sort((a, b) => b[1] - a[1])) {
    console.log(`    ${String(n).padStart(4)} absent: ${reason}`);
  }
}

console.log("\n=== option-combination sweep");
for (const [label, data, name] of [
  ["patterns", patterns, "harvested.txt"],
  ["globs", globs, "harvested-globs.txt"],
]) {
  const options = read(name).find((l) => l.startsWith("#options"))?.split("\t").slice(1) ?? [];
  console.log(
    `  ${label.padEnd(9)} ${data.cases.size} cases x ${1 << options.length} combinations ` +
      `-> ${data.pairs} assertions in ${data.rows} rows`,
  );
  console.log(`            swept: ${options.join(", ")}`);
}
console.log(`  total assertions: ${patterns.pairs + globs.pairs}`);

console.log("\n=== is every case swept under every combination?");
for (const [label, name, keyIndex, mapKey] of [
  ["patterns", "harvested.txt", 2, patternAt],
  ["globs", "harvested-globs.txt", 1, globAt],
]) {
  const options = read(name).find((l) => l.startsWith("#options"))?.split("\t").slice(1) ?? [];
  const combos = 1 << options.length;
  const perCase = new Map();
  for (const line of read(name).filter((l) => !l.startsWith("#"))) {
    const parts = line.split("\t");
    const key = mapKey(parts[keyIndex]);
    perCase.set(key, (perCase.get(key) ?? 0) + countBits(parts[0]));
  }
  const full = [...perCase.values()].filter((n) => n === combos).length;
  const asserted = [...perCase.values()].reduce((a, b) => a + b, 0);
  const pct = (n, d) => `${((100 * n) / d).toFixed(2)}%`;
  console.log(
    `  ${label.padEnd(9)} ${full}/${perCase.size} cases under all ${combos} ` +
      `(${pct(full, perCase.size)}); ` +
      `${asserted}/${perCase.size * combos} pairs (${pct(asserted, perCase.size * combos)})`,
  );
}

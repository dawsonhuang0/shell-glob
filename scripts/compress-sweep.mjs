/**
 * Compresses a raw option sweep into the checked-in fixture.
 *
 *   zsh -f /tmp/harvest.zsh > /tmp/raw-patterns.txt
 *   node scripts/compress-sweep.mjs /tmp/raw-patterns.txt > test/fixtures/harvested.txt
 *
 * The sweep runs every pattern under every combination of the options that can
 * change how it matches, which is a lot of lines but very little information:
 * most patterns behave identically under most combinations.  Each pattern is
 * therefore stored once per *distinct* result, tagged with a bitmask of the
 * combinations that produce it, so the fixture stays small while still
 * asserting every combination.
 */
import { readFileSync } from "node:fs";

const raw = readFileSync(process.argv[2] ?? "/tmp/raw-patterns.txt", "utf8").split("\n");

const header = [];
/** pattern -> (bitstring -> set of combo indices) */
const byPattern = new Map();
let comboCount = 0;

for (const line of raw) {
  if (!line) continue;
  if (line.startsWith("#")) {
    header.push(line);
    continue;
  }
  const t1 = line.indexOf("\t");
  const t2 = line.indexOf("\t", t1 + 1);
  if (t1 < 0 || t2 < 0) continue;
  const comboText = line.slice(0, t1);
  const rejected = comboText.endsWith("!");
  const combo = Number(rejected ? comboText.slice(0, -1) : comboText);
  const bits = rejected ? " rejected" : line.slice(t1 + 1, t2);
  const pattern = line.slice(t2 + 1); // an index into fixtures/patterns.json
  comboCount = Math.max(comboCount, combo + 1);
  let results = byPattern.get(pattern);
  if (!results) {
    results = new Map();
    byPattern.set(pattern, results);
  }
  let combos = results.get(bits);
  if (!combos) {
    combos = [];
    results.set(bits, combos);
  }
  combos.push(combo);
}

const lines = [...header];
let rows = 0;
let distinct = 0;

let unanswered = 0;
let rejections = 0;

for (const [pattern, results] of byPattern) {
  // A combination the shell did not answer for -- the pattern is a syntax
  // error under those options -- is simply not asserted, rather than being
  // taken for agreement.
  const covered = new Set();
  for (const combos of results.values()) for (const c of combos) covered.add(c);
  unanswered += comboCount - covered.size;
  distinct += results.size;
  for (const [bits, combos] of results) {
    let mask = 0n;
    for (const c of combos) mask |= 1n << BigInt(c);
    const rejected = bits === " rejected";
    if (rejected) rejections += combos.length;
    lines.push(`${mask.toString(16)}${rejected ? "!" : ""}\t${rejected ? "" : bits}\t${pattern}`);
    rows++;
  }
}

process.stdout.write(`${lines.join("\n")}\n`);
const asserted = byPattern.size * comboCount - unanswered;
process.stderr.write(
  `${byPattern.size} patterns x ${comboCount} combinations -> ${rows} rows; ` +
    `${asserted} (pattern, combination) pairs asserted ` +
    `(${rejections} of them rejections), ` +
    `${unanswered} not answered by the shell\n`,
);

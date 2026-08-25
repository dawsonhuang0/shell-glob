/**
 * Compresses a raw glob option sweep into the checked-in fixture.
 *
 *   zsh -f /tmp/globs.zsh > /tmp/raw-globs.txt
 *   node scripts/compress-globs.mjs /tmp/raw-globs.txt > test/fixtures/harvested-globs.txt
 *
 * As with the pattern sweep, each glob is stored once per distinct outcome,
 * tagged with a bitmask of the option combinations that produce it.  A glob
 * zsh rejected under some combinations is recorded as rejected for those, so
 * the port has to reject it there too.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { toUtf8 } from "./patlog.mjs";

/** The sweep stores indices into this list, not the texts. */
const SEPARATOR = "\u0001";

const globTexts = JSON.parse(
  readFileSync(fileURLToPath(new URL("../test/fixtures/globs.json", import.meta.url)), "utf8"),
);

// Read as bytes and decode the way zsh represents them, so a result naming a
// file whose bytes are not all characters survives.
const raw = readFileSync(process.argv[2] ?? "/tmp/raw-globs.txt", "latin1")
  .split("\n")
  .map((line) => toUtf8(line));

const header = [];
/** glob -> (result -> combos), where a rejection is stored as null. */
const byGlob = new Map();
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
  const glob = line.slice(t1 + 1, t2); // an index into fixtures/globs.json
  const result = line.slice(t2 + 1);
  comboCount = Math.max(comboCount, combo + 1);

  let outcomes = byGlob.get(glob);
  if (!outcomes) {
    outcomes = new Map();
    byGlob.set(glob, outcomes);
  }
  const key = rejected ? "__rejected__" : result;
  let combos = outcomes.get(key);
  if (!combos) {
    combos = [];
    outcomes.set(key, combos);
  }
  combos.push(combo);
}

const lines = [...header];
let rows = 0;
let rejections = 0;
let skippedBackslash = 0;

for (const [glob, outcomes] of byGlob) {
  for (const [key, combos] of outcomes) {

    let mask = 0n;
    for (const c of combos) mask |= 1n << BigInt(c);
    const rejected = key === "__rejected__";
    if (rejected) rejections += combos.length;
    // A result may name a file holding a byte that is not a character, kept as
    // `0xDC00 + byte`; written as text that would not survive the round trip,
    // so such a row is JSON encoded and marked with a `j`.
    // A word zsh did not glob comes back with its backslashes intact, because
    // `zshtokenize()` marks them Bnullkeep under ZSHTOK_SUBST (what `${~g}`
    // uses) and `untokenize()` restores them; the shell's own lexer uses plain
    // Bnull and drops them, which is the contract this package implements.
    // Such a row is marked `p`: what both agree on is that the word passed
    // straight through, which is what the test then checks.
    const text = globTexts[Number(glob) - 1];
    const passthrough = !rejected && text?.includes("\\") && key === text;
    if (passthrough) skippedBackslash += combos.length;
    const needsJson = !rejected && /[\u0000-\u001f\udc80-\udcff]/.test(key);
    const results = needsJson ? JSON.stringify(key.split(SEPARATOR)) : key;
    lines.push(
      `${mask.toString(16)}${needsJson ? "j" : ""}${passthrough ? "p" : ""}${rejected ? "!" : ""}` +
        `\t${glob}\t${rejected ? "" : results}`,
    );
    rows++;
  }
}

process.stdout.write(`${lines.join("\n")}\n`);
process.stderr.write(
  `${byGlob.size} globs x ${comboCount} combinations -> ${rows} rows; ` +
    `${byGlob.size * comboCount - rejections - skippedBackslash} expansions, ` +
    `${rejections} rejections, ` +
    `${skippedBackslash} checked only for passing straight through\n`,
);

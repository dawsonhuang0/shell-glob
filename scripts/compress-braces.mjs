/**
 * Turns the raw output of the brace harness into test/fixtures/braces.txt.
 *
 *     node scripts/compress-braces.mjs /tmp/zg-braces-out.txt > test/fixtures/braces.txt
 *
 * Most words in the sweep have no expansion in them and come back as
 * themselves, so only the ones that change are recorded.  The test rebuilds
 * the same corpus and asserts that every word it does not find here is left
 * alone, which checks the other direction just as tightly: a word this package
 * expands and zsh does not is a difference the fixture cannot hide.
 */
import { readFileSync } from "node:fs";

const lines = readFileSync(process.argv[2], "utf8").split("\n");

let version = "";
const bySet = new Map();
let current = null;

for (const line of lines) {
  if (line.startsWith("#zsh\t")) {
    version = line.slice(5);
    continue;
  }
  if (line.startsWith("#word\t")) {
    // The alphabet holds no tab, quote or backslash, so the word survives the
    // trip through the shell as itself and the field needs no decoding.
    const [, set, word] = line.split("\t");
    if (!bySet.has(set)) bySet.set(set, []);
    current = { set, word, results: [] };
    bySet.get(set).push(current);
    continue;
  }
  if (line.startsWith("=") && current) {
    // The `Q` on either end was only there to keep the shell parsing.
    const body = line.slice(1);
    if (!body.startsWith("Q") || !body.endsWith("Q") || body.length < 2) {
      throw new Error(`unwrapped result: ${JSON.stringify(line)}`);
    }
    current.results.push(body.slice(1, -1));
  }
}

const out = [`#zsh\t${version}`];
for (const [set, cases] of bySet) {
  const changed = cases.filter(
    (c) => c.results.length !== 1 || c.results[0] !== c.word,
  );
  out.push(`#set\t${set}\t${cases.length}\t${changed.length}`);
  for (const c of changed) {
    out.push(JSON.stringify([c.word, c.results]));
  }
}
process.stdout.write(out.join("\n") + "\n");

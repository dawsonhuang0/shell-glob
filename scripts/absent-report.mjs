/**
 * Explains, one by one, every pattern zsh compiled that is not in the corpus.
 *
 *   node scripts/absent-report.mjs
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
    .filter((line) => line.length > 0 && !line.startsWith("#"));

const inCorpus = new Set([
  ...read("harvested.txt").map((line) => patternAt(line.split("\t")[2])),
  ...read("harvested-globs.txt").map((line) => globAt(line.split("\t")[1])),
]);

/** Patterns the shell was asked about but never answered for. */
const unanswered = new Set();
try {
  for (const line of readFileSync("/tmp/raw-patterns.txt", "utf8").split("\n")) {
    if (line) {
      unanswered.add(patternAt(line.slice(line.indexOf("\t", line.indexOf("\t") + 1) + 1)));
    }
  }
} catch {
  // The raw sweep is a build artifact; without it that category is folded in.
}

const logged = loadPatlog() ?? [];
const absent = logged.filter((entry) => !inCorpus.has(toUtf8(entry.pattern)));

const CATEGORIES = [
  [
    "invalid UTF-8 bytes",
    "impossible: a JavaScript string cannot hold them",
    (raw) => !isPortable(raw, {}) && !/[\t\n\r]/.test(raw),
  ],
  [
    "byte-level character class",
    "impossible: matches bytes that are not characters",
    (raw, text) => /\[:(INCOMPLETE|INVALID):\]/.test(text),
  ],
  [
    "tab or newline in the pattern",
    "fixture format: the fixtures are tab separated lines",
    (raw) => /[\t\n\r]/.test(raw),
  ],
  [
    "tilde expansion",
    "out of scope: `~` is filename expansion, an earlier stage",
    (raw, text) => text.startsWith("~"),
  ],
  [
    "zsh gives no answer",
    "the shell aborts on it under every option combination",
    (raw, text) => !unanswered.has(text),
  ],
];

const counts = new Map();
for (const entry of absent) {
  const raw = entry.pattern;
  const text = toUtf8(raw);
  const hit = CATEGORIES.find(([, , test]) => test(raw, text));
  const key = hit ? `${hit[0]} -- ${hit[1]}` : "unexplained";
  const list = counts.get(key) ?? [];
  list.push(text);
  counts.set(key, list);
}

console.log(`${absent.length} of ${logged.length} compiled patterns are not in the corpus\n`);
for (const [key, list] of [...counts].sort((a, b) => b[1].length - a[1].length)) {
  console.log(`${String(list.length).padStart(3)}  ${key}`);
  for (const text of list.slice(0, 2)) {
    console.log(`       e.g. ${JSON.stringify(text).slice(0, 56)}`);
  }
}

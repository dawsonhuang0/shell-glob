import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { compile, globSync, match, type ZshOptionsInput } from "../src/index.js";
import fixture from "./fixtures/ztst.json" with { type: "json" };

/**
 * Every case scripts/extract-ztst.mjs could lift out of zsh's own test suite,
 * across all of Test/*.ztst.  The expected values are zsh's; each case names
 * the file, block and line it came from.
 */

interface Base {
  name: string;
  file: string;
  line: number;
  options: ZshOptionsInput;
}
type Step =
  | { type: "setup"; command: string; path: string; file: string }
  | (Base & { type: "match"; string: string; pattern: string; matches: boolean })
  | (Base & { type: "glob"; word: string; expected: string[]; cwd: string })
  | (Base & {
      type: "expansion";
      kind: string;
      value: string;
      pattern: string;
      replacement?: string;
      before?: string;
      after?: string;
      expected: string;
    })
  | (Base & {
      type: "arraySearch";
      flag: string;
      elements: string[];
      pattern: string;
      expected: string;
    });

const steps = fixture.steps as Step[];
const prep = fixture.prep as Record<string, { command: string; path: string; target?: string }[]>;

/** One temporary tree per test file, built from that file's %prep section. */
const trees: Record<string, string> = {};

beforeAll(() => {
  for (const [file, commands] of Object.entries(prep)) {
    const root = mkdtempSync(join(tmpdir(), "zsh-ztst-"));
    trees[file] = root;
    for (const command of commands) {
      const path = join(root, command.path);
      if (command.command === "mkdir") mkdirSync(path, { recursive: true });
      else if (command.command === "symlink") symlinkSync(command.target!, path);
      else {
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, "");
      }
    }
  }
});

afterAll(() => {
  for (const root of Object.values(trees)) rmSync(root, { recursive: true, force: true });
});

/** Slice by character, matching how the matcher counts positions. */
const chars = (s: string) => Array.from(s);
const from = (s: string, i: number) => chars(s).slice(i).join("");
const upTo = (s: string, i: number) => chars(s).slice(0, i).join("");

function applyExpansion(step: Extract<Step, { type: "expansion" }>): string {
  const pattern = compile(step.pattern, step.options);
  const value = step.value;
  switch (step.kind) {
    case "stripShortestPrefix":
      return from(value, pattern.matchStart(value) ?? 0);
    case "stripLongestPrefix":
      return from(value, pattern.matchStart(value, { longest: true }) ?? 0);
    case "stripShortestSuffix":
      return upTo(value, pattern.matchEnd(value) ?? chars(value).length);
    case "stripLongestSuffix":
      return upTo(value, pattern.matchEnd(value, { longest: true }) ?? chars(value).length);
    case "replace":
      return pattern.replace(value, step.replacement ?? "");
    case "replaceAll":
      return pattern.replace(value, step.replacement ?? "", { global: true });
    default:
      throw new Error(`unknown expansion ${step.kind}`);
  }
}

function applyArraySearch(step: Extract<Step, { type: "arraySearch" }>): string {
  const pattern = compile(step.pattern, step.options);
  const hits = step.elements.map((element) => pattern.test(element));
  switch (step.flag) {
    case "r": {
      const i = hits.indexOf(true);
      return i === -1 ? "" : step.elements[i];
    }
    case "R": {
      const i = hits.lastIndexOf(true);
      return i === -1 ? "" : step.elements[i];
    }
    case "i": {
      const i = hits.indexOf(true);
      return String(i === -1 ? step.elements.length + 1 : i + 1);
    }
    default: {
      const i = hits.lastIndexOf(true);
      return String(i + 1);
    }
  }
}

const byFile: Record<string, Step[]> = {};
for (const step of steps) (byFile[step.file] ??= []).push(step);

describe("zsh's own test suite", () => {
  for (const [file, fileSteps] of Object.entries(byFile)) {
    describe(file, () => {
      for (const step of fileSteps) {
        if (step.type === "setup") {
          it(`${step.command} ${step.path}`, () => {
            const path = join(trees[step.file], step.path);
            if (step.command === "mkdir") mkdirSync(path, { recursive: true });
            else if (step.command === "touch") writeFileSync(path, "");
            else rmSync(path, { recursive: true, force: true });
          });
          continue;
        }

        const where = `${step.file}:${step.line} ${step.name}`;

        if (step.type === "match") {
          it(`[[ ${step.string} = ${step.pattern} ]] is ${step.matches} — ${where}`, () => {
            expect(match(step.string, step.pattern, step.options)).toBe(step.matches);
          });
        } else if (step.type === "glob") {
          it(`print ${step.word} — ${where}`, () => {
            const cwd = step.cwd ? join(trees[step.file], step.cwd) : trees[step.file];
            expect(globSync(step.word, { ...step.options, cwd })).toEqual(step.expected);
          });
        } else if (step.type === "expansion") {
          it(`${step.kind} ${step.pattern} on ${step.value} — ${where}`, () => {
            const produced = `${step.before ?? ""}${applyExpansion(step)}${step.after ?? ""}`;
            expect(produced).toBe(step.expected);
          });
        } else {
          it(`array (${step.flag})${step.pattern} — ${where}`, () => {
            expect(applyArraySearch(step)).toBe(step.expected);
          });
        }
      }
    });
  }
});

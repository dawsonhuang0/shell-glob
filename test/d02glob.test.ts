import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { globSync, match, type GlobOptions } from "../src/index.js";
import fixture from "./fixtures/d02glob.json" with { type: "json" };

/**
 * Cases lifted from zsh's own globbing test file, Test/D02glob.ztst, by
 * scripts/extract-d02glob.mjs.  The expected values are the ones zsh's test
 * suite asserts; the steps run in file order against the tree that file's
 * %prep section builds, since some blocks add to it as they go.
 */
type Step =
  | { type: "setup"; command: string; path: string }
  | { type: "glob"; word: string; expected: string[]; options: GlobOptions; name: string }
  | { type: "match"; string: string; pattern: string; matches: boolean; options: GlobOptions; name: string };

const steps = fixture.steps as Step[];
let tree: string;

beforeAll(() => {
  tree = mkdtempSync(join(tmpdir(), "zsh-d02-"));
  // %prep: mkdir glob.tmp; mkdir glob.tmp/dir{1,2,3,4}; mkdir glob.tmp/dir3/subdir
  //        : >glob.tmp/{,{dir1,dir2}/}{a,b,c}
  for (const dir of ["glob.tmp", "glob.tmp/dir1", "glob.tmp/dir2", "glob.tmp/dir3",
                     "glob.tmp/dir4", "glob.tmp/dir3/subdir"]) {
    mkdirSync(join(tree, dir));
  }
  for (const dir of ["glob.tmp", "glob.tmp/dir1", "glob.tmp/dir2"]) {
    for (const name of ["a", "b", "c"]) writeFileSync(join(tree, dir, name), "");
  }
});

afterAll(() => rmSync(tree, { recursive: true, force: true }));

describe("zsh Test/D02glob.ztst", () => {
  for (const [i, step] of steps.entries()) {
    if (step.type === "setup") {
      it(`${step.command} ${step.path}`, () => {
        const path = join(tree, step.path);
        if (step.command === "mkdir") mkdirSync(path, { recursive: true });
        else if (step.command === "touch") writeFileSync(path, "");
        else rmSync(path, { recursive: true, force: true });
      });
      continue;
    }
    if (step.type === "glob") {
      it(`${i}: print ${step.word} (${step.name})`, () => {
        expect(globSync(step.word, { ...step.options, cwd: tree })).toEqual(step.expected);
      });
      continue;
    }
    it(`${i}: [[ ${step.string} = ${step.pattern} ]] (${step.name})`, () => {
      expect(match(step.string, step.pattern, step.options)).toBe(step.matches);
    });
  }
});

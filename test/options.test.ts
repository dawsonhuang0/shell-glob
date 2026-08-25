import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  defaultOptions,
  expandWordsSync,
  globSync,
  NoMatchError,
  type GlobOptions,
} from "../src/index.js";
import { virtualFs } from "./helpers/virtual-fs.js";

/**
 * The options in zsh's "Expansion and Globbing" section that reach filename
 * generation.  Expected values were taken from the zsh built from ./zsh.
 */
let tree: string;

beforeAll(() => {
  tree = mkdtempSync(join(tmpdir(), "zsh-opt-"));
  mkdirSync(join(tree, "DirOne/Sub"), { recursive: true });
  writeFileSync(join(tree, "DirOne/Sub/File.TXT"), "");
  writeFileSync(join(tree, "DirOne/other.txt"), "");
  writeFileSync(join(tree, "plain.txt"), "");
});

afterAll(() => rmSync(tree, { recursive: true, force: true }));

const g = (word: string, options: GlobOptions = {}) =>
  globSync(word, { cwd: tree, nullGlob: true, ...options });

describe("GLOB", () => {
  it("is on by default", () => {
    expect(defaultOptions.glob).toBe(true);
    expect(g("*.txt")).toEqual(["plain.txt"]);
  });

  it("leaves the word alone when unset", () => {
    expect(g("*.txt", { glob: false })).toEqual(["*.txt"]);
    expect(g("DirOne/*", { glob: false })).toEqual(["DirOne/*"]);
    // Nothing is compiled, so even a malformed pattern passes through.
    expect(g("(unclosed", { glob: false, extendedGlob: true })).toEqual(["(unclosed"]);
  });
});

describe("CASE_GLOB and CASE_PATHS", () => {
  // A real macOS filesystem is case insensitive, which hides these rules
  // entirely -- as zsh's own documentation notes for CASE_PATHS -- so this
  // runs against a virtual, case sensitive filesystem.
  const fs = virtualFs({
    "/v": { DirOne: { type: "dir" }, "plain.txt": {} },
    "/v/DirOne": { "other.txt": {}, "Other.TXT": {} },
  });
  const c = (word: string, options: GlobOptions = {}) =>
    globSync(word, { cwd: "/v", fs, nullGlob: true, ...options });

  it("matches case sensitively by default", () => {
    expect(defaultOptions.caseGlob).toBe(true);
    expect(c("dirone/*.txt")).toEqual([]);
    expect(c("DirOne/*.TXT")).toEqual(["DirOne/Other.TXT"]);
  });

  it("reaches plain path components when CASE_GLOB is off", () => {
    // The component is found case insensitively and reported as it is on disk.
    expect(c("dirone/*.txt", { caseGlob: false })).toEqual([
      "DirOne/Other.TXT",
      "DirOne/other.txt",
    ]);
  });

  it("keeps plain components case sensitive under CASE_PATHS", () => {
    expect(defaultOptions.casePaths).toBe(false);
    // `dirone` no longer matches, because it holds no globbing character.
    expect(c("dirone/*.txt", { caseGlob: false, casePaths: true })).toEqual([]);
    // The component that does hold one is still case insensitive.
    expect(c("DirOne/*.txt", { caseGlob: false, casePaths: true })).toEqual([
      "DirOne/Other.TXT",
      "DirOne/other.txt",
    ]);
  });
});

describe("CSH_NULL_GLOB", () => {
  // `tree` is only assigned in beforeAll, so build the options lazily.
  const csh = (): GlobOptions => ({ cwd: tree, cshNullGlob: true });

  it("is an error when every pattern in the command failed", () => {
    expect(() => expandWordsSync(["*.nope"], csh())).toThrow(NoMatchError);
    // A word that is not a pattern does not rescue the command.
    expect(() => expandWordsSync(["*.nope", "plain"], csh())).toThrow(NoMatchError);
  });

  it("drops the failing pattern when another one matched", () => {
    expect(expandWordsSync(["*.nope", "*.txt"], csh())).toEqual(["plain.txt"]);
    expect(expandWordsSync(["*.txt", "*.nope", "literal"], csh())).toEqual([
      "plain.txt",
      "literal",
    ]);
  });

  it("treats a single failing word as a command whose patterns all failed", () => {
    expect(() => globSync("*.nope", csh())).toThrow(NoMatchError);
  });

  it("expands word by word when it is not set", () => {
    expect(expandWordsSync(["*.txt", "literal"], { cwd: tree })).toEqual([
      "plain.txt",
      "literal",
    ]);
    expect(() => expandWordsSync(["*.nope"], { cwd: tree })).toThrow(NoMatchError);
    expect(expandWordsSync(["*.nope"], { cwd: tree, nullGlob: true })).toEqual([]);
  });
});

describe("NULL_GLOB still wins", () => {
  it("returns nothing rather than erroring", () => {
    expect(globSync("*.nope", { cwd: tree, nullGlob: true, cshNullGlob: true })).toEqual([]);
  });
});

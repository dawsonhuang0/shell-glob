import * as fs from "node:fs";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  glob,
  globSync,
  type AsyncFsAdapter,
  type GlobOptions,
  type SyncFsAdapter,
} from "../src/index.js";

/**
 * The asynchronous walk reads the tree a level at a time so that the reads
 * overlap.  That is only sound if it reads the same directories the plain
 * walk would: reading ahead must warm the cache, never widen the search or
 * touch a directory the glob had no business in.
 */
let tree: string;

beforeAll(() => {
  tree = mkdtempSync(join(tmpdir(), "zsh-glob-prefetch-"));
  mkdirSync(join(tree, "a/b/c/d"), { recursive: true });
  mkdirSync(join(tree, ".hidden/deep"), { recursive: true });
  mkdirSync(join(tree, "x/.dot"), { recursive: true });
  for (const file of [
    "a/one.ts",
    "a/b/two.ts",
    "a/b/c/three.ts",
    "a/b/c/d/four.ts",
    ".hidden/h.ts",
    ".hidden/deep/h2.ts",
    "x/y.ts",
    "x/.dot/z.ts",
  ]) {
    writeFileSync(join(tree, file), "");
  }
  symlinkSync(join(tree, "a"), join(tree, "link"));
  // A symlink pointing back up the tree, which `***\/` must not loop on.
  symlinkSync("..", join(tree, "a/up"));
});

afterAll(() => rmSync(tree, { recursive: true, force: true }));

function countingSync(log: string[]): SyncFsAdapter {
  return {
    readdir(path) {
      log.push(path);
      try {
        return fs.readdirSync(path, { withFileTypes: true });
      } catch {
        return null;
      }
    },
    lstat: (path) => {
      try {
        return fs.lstatSync(path);
      } catch {
        return null;
      }
    },
    stat: (path) => {
      try {
        return fs.statSync(path);
      } catch {
        return null;
      }
    },
  };
}

function countingAsync(log: string[]): AsyncFsAdapter {
  const sync = countingSync(log);
  return {
    readdir: async (path) => sync.readdir(path),
    lstat: async (path) => sync.lstat(path),
    stat: async (path) => sync.stat(path),
  };
}

const PATTERNS = [
  "**/*.ts",
  "***/*.ts",
  "**/*",
  "a/**/*.ts",
  "*/*/*.ts",
  "(*/)#*.ts",
  "(a|x)/**/*.ts",
  "(a/)##*.ts",
  "**/",
  "a/b/c/d/four.ts",
  "**/*.ts~*three*",
  "*(/)",
  "**/*.ts(.)",
  "**/.*",
];

const VARIANTS: [string, GlobOptions][] = [
  ["default", {}],
  ["globDots", { globDots: true }],
  ["maxDepth 2", { maxDepth: 2 }],
];

describe("reading ahead", () => {
  for (const pattern of PATTERNS) {
    for (const [label, extra] of VARIANTS) {
      it(`${pattern} (${label}) reads the same directories either way`, async () => {
        const readSync: string[] = [];
        const readAsync: string[] = [];
        const options = { cwd: tree, extendedGlob: true, nullGlob: true, ...extra };
        const fromSync = globSync(pattern, { ...options, fs: countingSync(readSync) });
        const fromAsync = await glob(pattern, { ...options, fsAsync: countingAsync(readAsync) });

        expect(fromAsync).toEqual(fromSync);
        expect([...new Set(readAsync)].sort()).toEqual([...new Set(readSync)].sort());
        // Reading ahead must not read anything twice either: the cache is what
        // makes the batch free.
        expect(readAsync.length).toBe(new Set(readAsync).size);
      });
    }
  }
});

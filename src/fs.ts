import * as fs from "node:fs";
import * as fsp from "node:fs/promises";

/**
 * The filesystem operations the globber needs, and the plumbing that lets one
 * traversal serve both the synchronous and the asynchronous API.
 *
 * The walker is written as a generator that yields requests; `runSync` drives
 * it with `node:fs` and `runAsync` with `node:fs/promises`, so the traversal
 * logic exists only once.
 */

export interface GlobDirent {
  name: string;
  isDirectory(): boolean;
  isSymbolicLink(): boolean;
}

export interface GlobStats {
  isDirectory(): boolean;
  isFile(): boolean;
  isSymbolicLink(): boolean;
  isBlockDevice(): boolean;
  isCharacterDevice(): boolean;
  isFIFO(): boolean;
  isSocket(): boolean;
  mode: number;
  uid: number;
  gid: number;
  nlink: number;
  size: number;
  dev: number;
  ino: number;
  atimeMs: number;
  mtimeMs: number;
  ctimeMs: number;
}

export interface SyncFsAdapter {
  /** Directory entries, excluding `.` and `..`; `null` if unreadable. */
  readdir(path: string): GlobDirent[] | null;
  /**
   * The same, in the order the filesystem itself gives them.  `fs.readdir`
   * goes through libuv's `scandir`, which sorts with `alphasort`; zsh calls
   * `readdir` and takes what comes.  Only the `Y` short circuit can tell the
   * difference, since everything else is sorted afterwards anyway.  Optional:
   * an adapter without it is read through `readdir`.
   */
  readdirOrdered?(path: string): GlobDirent[] | null;
  /** `lstat`, or `null` if it fails for any reason. */
  lstat(path: string): GlobStats | null;
  /** `stat`, or `null` if it fails for any reason. */
  stat(path: string): GlobStats | null;
}

export interface AsyncFsAdapter {
  readdir(path: string): Promise<GlobDirent[] | null>;
  /** See `SyncFsAdapter.readdirOrdered`. */
  readdirOrdered?(path: string): Promise<GlobDirent[] | null>;
  lstat(path: string): Promise<GlobStats | null>;
  stat(path: string): Promise<GlobStats | null>;
}

export type FsRequest =
  | { op: "readdir"; path: string }
  /** `readdir`, in the filesystem's own order; see `readdirOrdered`. */
  | { op: "readdirOrdered"; path: string }
  /** Several listings at once, so the async driver can overlap them. */
  | { op: "readdirAll"; paths: string[] }
  | { op: "lstat"; path: string }
  | { op: "stat"; path: string };

export type FsResponse = GlobDirent[] | GlobStats | (GlobDirent[] | null)[] | null;

/** A traversal step: yields filesystem requests, returns a result. */
export type FsGenerator<T> = Generator<FsRequest, T, FsResponse>;

export function runSync<T>(gen: FsGenerator<T>, adapter: SyncFsAdapter): T {
  let step = gen.next(null);
  while (!step.done) {
    const req = step.value;
    const value =
      req.op === "readdir"
        ? adapter.readdir(req.path)
        : req.op === "readdirOrdered"
          ? (adapter.readdirOrdered ?? adapter.readdir).call(adapter, req.path)
          : req.op === "readdirAll"
          ? req.paths.map((path) => adapter.readdir(path))
          : req.op === "lstat"
            ? adapter.lstat(req.path)
            : adapter.stat(req.path);
    step = gen.next(value);
  }
  return step.value;
}

export async function runAsync<T>(gen: FsGenerator<T>, adapter: AsyncFsAdapter): Promise<T> {
  let step = gen.next(null);
  while (!step.done) {
    const req = step.value;
    const value =
      req.op === "readdir"
        ? await adapter.readdir(req.path)
        : req.op === "readdirOrdered"
          ? await (adapter.readdirOrdered ?? adapter.readdir).call(adapter, req.path)
          : req.op === "readdirAll"
          ? // The point of the batch: these go out together rather than one
            // after another, which a shell walking a tree cannot do.
            await Promise.all(req.paths.map((path) => adapter.readdir(path)))
          : req.op === "lstat"
            ? await adapter.lstat(req.path)
            : await adapter.stat(req.path);
    step = gen.next(value);
  }
  return step.value;
}

/** Typed helpers so the walker can `yield*` a request and get the right type back. */
export function* readdir(path: string): FsGenerator<GlobDirent[] | null> {
  const res = yield { op: "readdir", path };
  return res as GlobDirent[] | null;
}

export function* readdirOrdered(path: string): FsGenerator<GlobDirent[] | null> {
  const res = yield { op: "readdirOrdered", path };
  return res as GlobDirent[] | null;
}

export function* readdirAll(paths: string[]): FsGenerator<(GlobDirent[] | null)[]> {
  const res = yield { op: "readdirAll", paths };
  return res as (GlobDirent[] | null)[];
}

export function* lstat(path: string): FsGenerator<GlobStats | null> {
  const res = yield { op: "lstat", path };
  return res as GlobStats | null;
}

export function* stat(path: string): FsGenerator<GlobStats | null> {
  const res = yield { op: "stat", path };
  return res as GlobStats | null;
}

export function nodeSyncFs(): SyncFsAdapter {
  return {
    readdir(path) {
      try {
        return fs.readdirSync(path, { withFileTypes: true });
      } catch {
        return null;
      }
    },
    readdirOrdered(path) {
      // `opendir` reads the directory incrementally and does not sort.
      try {
        const dir = fs.opendirSync(path);
        try {
          const out: GlobDirent[] = [];
          let entry;
          while ((entry = dir.readSync()) !== null) out.push(entry);
          return out;
        } finally {
          dir.closeSync();
        }
      } catch {
        return null;
      }
    },
    lstat(path) {
      try {
        return fs.lstatSync(path);
      } catch {
        return null;
      }
    },
    stat(path) {
      try {
        return fs.statSync(path);
      } catch {
        return null;
      }
    },
  };
}

export function nodeAsyncFs(): AsyncFsAdapter {
  return {
    async readdir(path) {
      try {
        return await fsp.readdir(path, { withFileTypes: true });
      } catch {
        return null;
      }
    },
    async readdirOrdered(path) {
      try {
        const dir = await fsp.opendir(path);
        const out: GlobDirent[] = [];
        for await (const entry of dir) out.push(entry);
        return out;
      } catch {
        return null;
      }
    },
    async lstat(path) {
      try {
        return await fsp.lstat(path);
      } catch {
        return null;
      }
    },
    async stat(path) {
      try {
        return await fsp.stat(path);
      } catch {
        return null;
      }
    },
  };
}

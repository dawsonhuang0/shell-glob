import type { GlobDirent, GlobStats, SyncFsAdapter } from "../../src/index.js";

/**
 * A filesystem made of plain objects, so that qualifiers depending on file
 * types, permission bits, ownership and timestamps can be tested without
 * needing root, real devices or a particular platform.
 */
export type FileType = "file" | "dir" | "link" | "fifo" | "socket" | "block" | "char";

export interface VirtualFile {
  type?: FileType;
  mode?: number;
  uid?: number;
  gid?: number;
  nlink?: number;
  size?: number;
  dev?: number;
  ino?: number;
  atimeMs?: number;
  mtimeMs?: number;
  ctimeMs?: number;
  /** For a symlink: the path whose stats `stat()` should report. */
  target?: string;
}

/** A tree is a map of directory path to the files it holds. */
export type VirtualTree = Record<string, Record<string, VirtualFile>>;

function statsFor(file: VirtualFile): GlobStats {
  const type = file.type ?? "file";
  return {
    isDirectory: () => type === "dir",
    isFile: () => type === "file",
    isSymbolicLink: () => type === "link",
    isBlockDevice: () => type === "block",
    isCharacterDevice: () => type === "char",
    isFIFO: () => type === "fifo",
    isSocket: () => type === "socket",
    mode: file.mode ?? 0o644,
    uid: file.uid ?? 501,
    gid: file.gid ?? 20,
    nlink: file.nlink ?? 1,
    size: file.size ?? 0,
    dev: file.dev ?? 1,
    ino: file.ino ?? 1,
    atimeMs: file.atimeMs ?? 0,
    mtimeMs: file.mtimeMs ?? 0,
    ctimeMs: file.ctimeMs ?? 0,
  };
}

function direntFor(name: string, file: VirtualFile): GlobDirent {
  const type = file.type ?? "file";
  return {
    name,
    isDirectory: () => type === "dir",
    isSymbolicLink: () => type === "link",
  };
}

export function virtualFs(tree: VirtualTree): SyncFsAdapter {
  const lookup = (path: string): VirtualFile | null => {
    const clean = path.replace(/\/+$/, "") || "/";
    const slash = clean.lastIndexOf("/");
    const parent = slash <= 0 ? "/" : clean.slice(0, slash);
    const name = clean.slice(slash + 1);
    // Prefer the entry in the parent listing, which carries the metadata; fall
    // back to a plain directory for a path that only appears as a tree key.
    return tree[parent]?.[name] ?? (tree[clean] ? { type: "dir" } : null);
  };

  return {
    readdir(path) {
      const dir = tree[path.replace(/\/+$/, "") || "/"];
      if (!dir) return null;
      return Object.entries(dir).map(([name, file]) => direntFor(name, file));
    },
    lstat(path) {
      const file = lookup(path);
      return file ? statsFor(file) : null;
    },
    stat(path) {
      const file = lookup(path);
      if (!file) return null;
      if (file.type === "link") {
        if (!file.target) return null; // a broken link
        const targeted = lookup(file.target);
        return targeted ? statsFor(targeted) : null;
      }
      return statsFor(file);
    },
  };
}

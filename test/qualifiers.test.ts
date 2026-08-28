import { mkdirSync, mkdtempSync, opendirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { globSync, ZshPatternError, type GlobOptions } from "../src/index.js";
import { virtualFs, type VirtualTree } from "./helpers/virtual-fs.js";
import { hasUnixIds } from "./helpers/platform.js";

const DAY = 86_400_000;
const NOW = 1_700_000_000_000;

/** One directory holding a file of every type and shape a qualifier can test. */
const tree: VirtualTree = {
  "/v": {
    plain: { type: "file", mode: 0o644, size: 100, nlink: 1, uid: 501, gid: 20, dev: 1 },
    script: { type: "file", mode: 0o755, size: 2048 },
    setuid: { type: "file", mode: 0o4755 },
    setgid: { type: "file", mode: 0o2755 },
    setboth: { type: "file", mode: 0o6755 },
    sticky: { type: "dir", mode: 0o1777 },
    dir: { type: "dir", mode: 0o755 },
    empty: { type: "dir", mode: 0o755 },
    fifo: { type: "fifo", mode: 0o644 },
    socket: { type: "socket", mode: 0o644 },
    block: { type: "block", mode: 0o660 },
    char: { type: "char", mode: 0o666 },
    link: { type: "link", target: "/v/dir" },
    broken: { type: "link" },
    other: { type: "file", mode: 0o644, uid: 999, gid: 888, nlink: 3, dev: 42 },
    old: { type: "file", mtimeMs: NOW - 10 * DAY, atimeMs: NOW - 10 * DAY, ctimeMs: NOW - 10 * DAY },
    fresh: { type: "file", mtimeMs: NOW - 1000, atimeMs: NOW - 1000, ctimeMs: NOW - 1000 },
    huge: { type: "file", size: 5 * 1024 * 1024 },
    "no-perms": { type: "file", mode: 0o000 },
    "all-perms": { type: "file", mode: 0o777 },
  },
  "/v/dir": { inside: { type: "file" } },
  "/v/empty": {},
  "/v/sticky": {},
};

const g = (pattern: string, options: GlobOptions = {}) =>
  globSync(pattern, {
    cwd: "/v",
    extendedGlob: true,
    nullGlob: true,
    fs: virtualFs(tree),
    now: NOW,
    ...options,
  });

describe("qualifiers by file type", () => {
  it("selects each type", () => {
    expect(g("*(p)")).toEqual(["fifo"]);
    expect(g("*(=)")).toEqual(["socket"]);
    expect(g("*(%b)")).toEqual(["block"]);
    expect(g("*(%c)")).toEqual(["char"]);
    expect(g("*(%)")).toEqual(["block", "char"]);
    expect(g("*(@)")).toEqual(["broken", "link"]);
    expect(g("*(/)")).toEqual(["dir", "empty", "sticky"]);
    expect(g("*(*)")).toEqual(["all-perms", "script", "setboth", "setgid", "setuid"]);
  });

  it("follows symlinks with -", () => {
    expect(g("*(-/)")).toEqual(["dir", "empty", "link", "sticky"]);
    expect(g("*(-@)")).toEqual(["broken"]);
  });

  it("finds non-empty directories with F", () => {
    expect(g("*(F)")).toEqual(["dir"]);
    expect(g("*(/^F)")).toEqual(["empty", "sticky"]);
  });
});

describe("qualifiers by permission", () => {
  const executable = ["all-perms", "dir", "empty", "script", "setboth", "setgid", "setuid", "sticky"];

  it("tests single bits", () => {
    expect(g("*(s)")).toEqual(["setboth", "setuid"]);
    expect(g("*(S)")).toEqual(["setboth", "setgid"]);
    expect(g("*(t)")).toEqual(["sticky"]);
    expect(g("*(^r)")).toEqual(["no-perms"]);
    expect(g("*(w)")).toContain("plain");
    expect(g("*(x)")).toEqual(executable);
    expect(g("*(X)")).toEqual(executable);
    expect(g("*(E)")).toEqual(executable);
    expect(g("*(W)")).toEqual(["all-perms", "char", "sticky"]);
    expect(g("*(I)")).toEqual(["all-perms", "block", "char", "sticky"]);
    expect(g("*(A)")).toContain("plain");
    expect(g("*(R)")).toContain("plain");
  });

  it("tests an octal spec with f", () => {
    expect(g("*(f644)")).toContain("plain");
    expect(g("*(f644)")).not.toContain("script");
    // A three digit spec only compares the low nine bits, so a setuid file
    // with mode 4755 still matches 755, as it does in zsh.
    expect(g("*(f=755)")).toEqual(["dir", "empty", "script", "setboth", "setgid", "setuid"]);
    expect(g("*(f+100)")).toEqual(executable);
    expect(g("*(f-777)")).toEqual(["no-perms"]);
    expect(g("*(f7??)")).toEqual(executable); // `?` leaves those digits unchecked
  });

  it("tests a symbolic spec with f", () => {
    expect(g("*(f:u+w:)")).toContain("plain");
    expect(g("*(f:gu+w:)")).toEqual(["all-perms", "block", "char", "sticky"]);
    expect(g("*(f:o-rwx:)")).toEqual(["block", "no-perms"]);
    expect(g("*(f:a+r:)")).toContain("plain");
    expect(g("*(f:a+r:)")).not.toContain("no-perms");
    expect(g("*(f:u+x:)")).toEqual(executable);
    expect(g("*(f[u+x])")).toEqual(executable); // any bracket style delimits it
    // `s` means the setuid bit for `u` and the setgid bit for `g`, because the
    // class letters mask which bits the right applies to.
    expect(g("*(f:u+s:)")).toEqual(["setboth", "setuid"]);
    expect(g("*(f:g+s:)")).toEqual(["setboth", "setgid"]);
    expect(g("*(f:a+s:)")).toEqual(["setboth"]);
    expect(g("*(f:o+t:)")).toEqual(["sticky"]);
    // A digit stands for the same rights in each class named, so `u+7` asks
    // for owner rwx only; zsh answers the same way.
    expect(g("*(f:u+7:)")).toEqual(executable);
    expect(g("*(f:a+7:)")).toEqual(["all-perms", "sticky"]);
  });

  it("rejects an f spec it cannot read", () => {
    // zsh's own wording for a mode spec it cannot read.
    expect(() => g("*(f:z+w:)")).toThrow("invalid mode specification");
    // Inside a delimited spec a bad right is part of the spec, so this is
    // "invalid mode specification" too -- `*(f+q)` is the one where the `q`
    // is a separate qualifier and gets named.
    expect(() => g("*(f:u+q:)")).toThrow("invalid mode specification");
    // Unterminated, which `qgetmodespec` reports the same way as any other
    // spec it cannot read.
    expect(() => g("*(f:u+w)")).toThrow("invalid mode specification");
  });
});

describe("qualifiers by ownership and identity", () => {
  it("matches a user or group id", () => {
    expect(g("*(u999)")).toEqual(["other"]);
    expect(g("*(g888)")).toEqual(["other"]);
    expect(g("*(^u999)")).not.toContain("other");
  });

  it("resolves names through a hook", () => {
    const hooks = { resolveUser: (name: string) => (name === "them" ? 999 : 0) };
    expect(g("*(u:them:)", { qualifierHooks: hooks })).toEqual(["other"]);
    expect(g("*(u[them])", { qualifierHooks: hooks })).toEqual(["other"]);
  });

  it("needs a hook for a name", () => {
    expect(() => g("*(u:them:)")).toThrow(/resolveUser/);
    expect(() => g("*(g:them:)")).toThrow(/resolveGroup/);
  });

  it.skipIf(!hasUnixIds)("matches the effective user with U and G", () => {
    // The virtual files carry the current uid, so U and G select them.
    const mine = { ...tree, "/v": { plain: { uid: process.getuid?.(), gid: process.getgid?.() } } };
    expect(globSync("*(U)", { cwd: "/v", fs: virtualFs(mine), nullGlob: true })).toEqual(["plain"]);
    expect(globSync("*(G)", { cwd: "/v", fs: virtualFs(mine), nullGlob: true })).toEqual(["plain"]);
  });

  it("matches a device number and a link count", () => {
    expect(g("*(d42)")).toEqual(["other"]);
    expect(g("*(l3)")).toEqual(["other"]);
    expect(g("*(l+2)")).toEqual(["other"]);
    expect(g("*(l-2)")).not.toContain("other");
  });
});

describe("qualifiers by age and size", () => {
  it("compares modification, access and inode change times", () => {
    for (const key of ["m", "a", "c"]) {
      expect(g(`*(.${key}+5)`)).toContain("old");
      expect(g(`*(.${key}+5)`)).not.toContain("fresh");
      expect(g(`*(.${key}-1)`)).toContain("fresh");
    }
  });

  it("understands the unit suffixes", () => {
    expect(g("*(.mh+200)")).toContain("old");
    expect(g("*(.mm-60)")).toContain("fresh");
    expect(g("*(.ms-3600)")).toContain("fresh");
    // Ten days is one whole week and no whole months.
    expect(g("*(.mw+0)")).toContain("old");
    expect(g("*(.mw+1)")).not.toContain("old");
    expect(g("*(.mM+1)")).not.toContain("old");
    expect(g("*(.md+9)")).toContain("old");
  });

  it("compares sizes, rounding up to the unit", () => {
    expect(g("*(.L100)")).toContain("plain");
    expect(g("*(.Lk2)")).toEqual(["script"]);
    expect(g("*(.Lm5)")).toEqual(["huge"]);
    expect(g("*(.Lm-1)")).not.toContain("huge");
    // 100 bytes rounds up to one block, which is not *more* than one block.
    expect(g("*(.Lp+1)")).toEqual(["huge", "script"]);
    expect(g("*(.Lp1)")).toContain("plain");
    // "Less than" one gigabyte means rounding up to less than 1, i.e. empty.
    expect(g("*(.Lg-1)")).toContain("old");
    expect(g("*(.Lg-1)")).not.toContain("huge");
    expect(g("*(.Lt-1)")).not.toContain("huge");
  });
});

describe("sorting", () => {
  const last = (list: string[]) => list[list.length - 1];

  it("sorts by every documented key", () => {
    expect(g("*(.on)")).toEqual(g("*(.)"));
    expect(g("*(.On)")).toEqual([...g("*(.)")].reverse());
    // `huge` and `other` are the only files with a distinct size and link
    // count, so they are where the ordering is unambiguous.
    expect(last(g("*(.oL)"))).toBe("huge");
    expect(g("*(.OL)")[0]).toBe("huge");
    expect(last(g("*(.ol)"))).toBe("other");
    expect(g("*(.Ol)")[0]).toBe("other");
    expect(g("*(.om)")[0]).toBe("fresh"); // youngest first
    expect(g("*(.oa)")[0]).toBe("fresh");
    expect(g("*(.oc)")[0]).toBe("fresh");
    expect(last(g("*(.Om)"))).toBe("fresh");
  });

  it("breaks ties with a second key", () => {
    // Everything but `old` and `fresh` has the same timestamp, so the name
    // decides the order among them.
    const byTime = g("*(.omon)");
    expect(byTime[0]).toBe("fresh");
    expect(byTime[1]).toBe("old");
    expect(byTime.slice(2)).toEqual([...byTime.slice(2)].sort());
  });

  it("leaves the order alone for N", () => {
    expect(g("*(.oN)").sort()).toEqual(g("*(.)"));
  });

  it("needs a hook for oe and o+", () => {
    expect(() => g("*(.oe:code:)")).toThrow(/sortKey/);
    expect(() => g("*(.o+cmd)")).toThrow(/sortKey/);
  });

  it("uses the hook for o+cmd", () => {
    const sorted = g("*(.o+bysize)", {
      qualifierHooks: { sortKey: (_code, file) => String(file.lstat?.size ?? 0).padStart(9, "0") },
    });
    expect(sorted[sorted.length - 1]).toBe("huge");
  });

  it("rejects an unknown sort key", () => {
    expect(() => g("*(.oZ)")).toThrow(ZshPatternError);
    expect(() => g("*(.o)")).toThrow(ZshPatternError);
  });
});

describe("output shaping", () => {
  it("marks every file type with T, as zsh's file_type() does", () => {
    expect(g("dir(T)")).toEqual(["dir/"]);
    expect(g("link(T)")).toEqual(["link@"]);
    expect(g("broken(T)")).toEqual(["broken@"]);
    expect(g("fifo(T)")).toEqual(["fifo|"]);
    expect(g("socket(T)")).toEqual(["socket="]);
    expect(g("block(T)")).toEqual(["block#"]);
    expect(g("char(T)")).toEqual(["char%"]);
    expect(g("script(T)")).toEqual(["script*"]);
    expect(g("plain(T)")).toEqual(["plain "]); // a plain file gets a space
  });

  it("marks only directories with M", () => {
    expect(g("*(M)")).toContain("dir/");
    expect(g("*(M)")).toContain("plain");
  });

  it("takes subscripts counted from either end", () => {
    expect(g("*(.OL[1])")).toEqual(["huge"]);
    expect(g("*(.OL[2,3])")).toHaveLength(2);
    expect(g("*(.OL[-2,-1])")).toHaveLength(2);
    expect(g("*(.OL[1,-1])")).toEqual(g("*(.OL)"));
  });

  it("evaluates a non-numeric subscript as zero, selecting nothing", () => {
    // zsh evaluates a subscript arithmetically, where an unset name is 0, and
    // its subscripts are one based, so index 0 picks nothing.
    expect(g("*(.[x])")).toEqual([]);
    expect(() => g("*(.[1,2)")).toThrow(ZshPatternError);
  });

  it("combines lists with commas as OR", () => {
    expect(g("*(p,=)")).toEqual(["fifo", "socket"]);
    // `^` and `-` do not carry across a comma.
    expect(g("*(^p,=)")).toContain("plain");
  });

  it("reports an unknown qualifier and a missing argument", () => {
    expect(() => g("*(ü)")).toThrow(/unknown file attribute/);
    expect(() => g("*(l)")).toThrow(/number expected/);
    // These take shell code, which `glob_exec_string` reads, so they share
    // its wording rather than naming themselves as `u` and `g` do.
    expect(() => g("*(P)")).toThrow("missing end of string");
    expect(() => g("*(e)")).toThrow("missing end of string");
    expect(() => g("*(u)")).toThrow("missing delimiter for 'u' glob qualifier");
    expect(() => g("*(g)")).toThrow("missing delimiter for 'g' glob qualifier");
    expect(() => g("*(e:code:)")).toThrow(/qualifierHooks.evaluate/);
  });
});

describe("the e qualifier", () => {
  it("takes each bracket style as a delimiter", () => {
    const hooks = { evaluate: (code: string) => code === "keep" };
    for (const pattern of ["*(e:keep:)", "*(e[keep])", "*(e{keep})", "*(e<keep>)"]) {
      expect(g(pattern, { qualifierHooks: hooks })).toHaveLength(20);
    }
    // A bare qualifier list may not contain `(`, so the parenthesised
    // delimiter needs the unambiguous (#q...) form.
    expect(g("*(e(keep))", { qualifierHooks: hooks })).toEqual([]);
    expect(g("*(#qe(keep))", { qualifierHooks: hooks })).toHaveLength(20);
  });

  it("passes the file and can be negated", () => {
    const hooks = { evaluate: (_code: string, file: { name: string }) => file.name === "plain" };
    expect(g("*(e:x:)", { qualifierHooks: hooks })).toEqual(["plain"]);
    expect(g("*(^e:x:)", { qualifierHooks: hooks })).not.toContain("plain");
  });

  it("takes a bare word after +", () => {
    expect(
      g("*(+mine)", { qualifierHooks: { evaluate: (code) => code === "mine" } }),
    ).toHaveLength(20);
  });
});

/**
 * `Yn` is a short circuit, not a trim: "only the first n matches in directory
 * traversal order will be considered.  Any sorting specified with an oc or Oc
 * qualifier is applied after the n matches are returned; oN is implied
 * otherwise" (Doc/Zsh/expn.yo).  `scanner` checks `shortcircuit == matchct`
 * at every insertion and stops the walk there.
 *
 * Traversal order is the filesystem's own, which `fs.readdir` does not give:
 * it goes through libuv's `scandir`, which sorts with `alphasort`.  The walk
 * reads through `opendir` when a `Y` is in play, so the order matches what
 * zsh, and `ls -f`, see.
 */
describe("the Y short circuit", () => {
  let tree: string;
  let order: string[];

  beforeAll(() => {
    tree = mkdtempSync(join(tmpdir(), "zsh-glob-short-"));
    // Written in an order chosen so that traversal order and sorted order
    // differ, whatever the filesystem does with them.
    for (const name of ["mmm.t", "aaa.t", "zzz.t", "bbb.t", "kkk.t"]) {
      writeFileSync(join(tree, name), "");
    }
    const dir = opendirSync(tree);
    order = [];
    let entry;
    while ((entry = dir.readSync()) !== null) order.push(entry.name);
    dir.closeSync();
  });

  afterAll(() => rmSync(tree, { recursive: true, force: true }));

  const run = (pattern: string) =>
    globSync(pattern, { cwd: tree, extendedGlob: true, bareGlobQual: true, nullGlob: true });

  it("takes the first n in traversal order, unsorted", () => {
    expect(run("*.t(Y3)")).toEqual(order.slice(0, 3));
  });

  it("which is not the sorted order", () => {
    expect(run("*.t")).toEqual([...order].sort());
  });

  it("an explicit sort is applied to the n it kept, not to the whole set", () => {
    const first3 = order.slice(0, 3);
    expect(run("*.t(Y3on)")).toEqual([...first3].sort());
    // Sorting first and then trimming would give the three smallest names --
    // a different set, unless the filesystem hands names back in sorted order
    // to begin with, as NTFS does, in which case there is nothing to tell
    // apart and the check above is the whole of what can be asserted.
    const sortedFirst3 = [...order].sort().slice(0, 3);
    if (JSON.stringify(first3.slice().sort()) !== JSON.stringify(sortedFirst3)) {
      expect(run("*.t(Y3on)")).not.toEqual(sortedFirst3);
    }
  });

  it("counts files that survive the qualifiers, not candidates", () => {
    // `.` selects plain files; the directory must not use up the count.
    mkdirSync(join(tree, "adir.t"));
    try {
      expect(run("*.t(.Y2)")).toHaveLength(2);
      expect(run("*.t(.Y2)").every((n) => n.endsWith(".t"))).toBe(true);
    } finally {
      rmSync(join(tree, "adir.t"), { recursive: true });
    }
  });

  it("globs before the last path component", () => {
    mkdirSync(join(tree, "d1"));
    writeFileSync(join(tree, "d1", "f.t"), "");
    try {
      expect(run("d?/f.t(Y1)")).toEqual(["d1/f.t"]);
    } finally {
      rmSync(join(tree, "d1"), { recursive: true });
    }
  });
});

/**
 * `qgetmodespec` accepts a sign with no number after it, leaving the value at
 * zero, which constrains nothing.  So `*(f+x)` is not "f with +x": it is an
 * empty mode spec followed by the separate `x` qualifier, and selects what is
 * executable by its owner.  The class letters are only read when the spec is
 * delimited ("&& end"), so `*(fu+w)` is an error in zsh too.
 */
describe("the f qualifier's mode spec", () => {
  const tree: VirtualTree = {
    "/t": {
      exec: { mode: 0o755 },
      plain: { mode: 0o400 },
    },
  };

  const run = (pattern: string) =>
    globSync(pattern, {
      cwd: "/t",
      bareGlobQual: true,
      nullGlob: true,
      fs: virtualFs(tree),
    });

  const cases: [string, string[]][] = [
    // An empty spec, then the `x`, `w` or `r` qualifier.
    ["*(f+x)", ["exec"]],
    ["*(f=x)", ["exec"]],
    ["*(f-x)", ["exec"]],
    ["*(f+w)", ["exec"]],
    ["*(f+r)", ["exec", "plain"]],
    ["*(f:+:)", ["exec", "plain"]],
    ["*(f+0)", ["exec", "plain"]],
    // A real octal spec still means what it did.
    ["*(f755)", ["exec"]],
    ["*(f400)", ["plain"]],
    ["*(f+7)", []],
    ["*(f:u+w:)", ["exec"]],
  ];

  for (const [pattern, expected] of cases) {
    it(`${pattern} selects ${expected.join(", ") || "nothing"}`, () => {
      expect(run(pattern)).toEqual(expected);
    });
  }

  for (const pattern of ["*(fu+w)", "*(f::)", "*(f+q)"]) {
    it(`${pattern} is an error`, () => {
      expect(() => run(pattern)).toThrow(ZshPatternError);
    });
  }
});

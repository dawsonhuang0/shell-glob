import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { expandWordsSync, globSync, NoMatchError, ZshPatternError } from "../src/index.js";

/**
 * `message` is the text zsh prints after its `zsh:LINE:` prefix, and nothing
 * else.  Every string below was taken from the zsh built from ./zsh.
 *
 * All of them exit the shell with status 1 -- `zerr()` sets `errflag` and
 * `execlist` turns that into `lastval = 1` -- so there is no status worth
 * carrying: a glob error never has one of its own.
 */
let tree: string;

beforeAll(() => {
  tree = mkdtempSync(join(tmpdir(), "zsh-glob-msg-"));
  mkdirSync(join(tree, "sub"));
  for (const f of ["a.txt", "b.txt"]) writeFileSync(join(tree, f), "");
});

afterAll(() => rmSync(tree, { recursive: true, force: true }));

const run = (pattern: string) =>
  globSync(pattern, { cwd: tree, extendedGlob: true, bareGlobQual: true });

const cases: [string, string][] = [
  // A pattern that will not compile is only ever "a bad one", named by the
  // whole word rather than the path component that failed.
  ["(#z)a", "bad pattern: (#z)a"],
  ["[a", "bad pattern: [a"],
  ["sub/[a", "bad pattern: sub/[a"],
  ["a###", "bad pattern: a###"],
  ["*#", "bad pattern: *#"],
  ["(#se)a", "bad pattern: (#se)a"],
  ["(#a300)a", "bad pattern: (#a300)a"],
  ["(#qfoo", "bad pattern: (#qfoo"],
  ["[a(#q.)", "bad pattern: [a(#q.)"],
  // A glob qualifier names its own fault.
  ["*(z)", "unknown file attribute: z"],
  ["*(f+q)", "unknown file attribute: q"],
  ["*(o)", "unknown sort specifier"],
  ["*(ox)", "unknown sort specifier"],
  ["*(onon)", "doubled sort specifier"],
  ["*(Y)", "number expected"],
  ["*(m)", "number expected"],
  ["*(L)", "number expected"],
  ["*(Y2147483648)", "value too big: Y2147483648"],
  ["*(u)", "missing delimiter for 'u' glob qualifier"],
  ["*(g)", "missing delimiter for 'g' glob qualifier"],
  ["*(e)", "missing end of string"],
  ["*(P)", "missing end of string"],
  ["*(+)", "missing identifier after `+'"],
  ["*(f)", "invalid mode specification"],
  ["*(f:u+w)", "invalid mode specification"],
  ["*(om[)", "invalid subscript"],
  // A subscript is arithmetic, and its errors are the shell's own.
  ["*(om[])", "bad math expression: empty string"],
  ["*(om[5/0])", "division by zero"],
  ["*(om[1#1])", "invalid base (must be 2 to 36 inclusive): 1"],
  // Nothing matched.
  ["nope*", "no matches found: nope*"],
  ["sub/nope*(.)", "no matches found: sub/nope*(.)"],
];

describe("error messages are zsh's, word for word", () => {
  for (const [pattern, message] of cases) {
    it(`${pattern} → ${message}`, () => {
      expect(() => run(pattern)).toThrow(message);
      // and nothing else: no prefix, no explanation appended
      try {
        run(pattern);
        expect.fail(`${pattern} should have thrown`);
      } catch (err) {
        expect((err as Error).message).toBe(message);
      }
    });
  }

  it("reports a subscript that is not arithmetic", () => {
    // Only where the group is a qualifier list at all: with EXTENDED_GLOB a
    // `~` stops `checkglobqual` reading it as one, and it becomes an ordinary
    // pattern that matches nothing.
    const asQualifier = { cwd: tree, bareGlobQual: true };
    expect(() => globSync("*(om[^~])", asQualifier)).toThrow(
      "bad math expression: operand expected at `^~'",
    );
    expect(() => globSync("*(om[^~])", { ...asQualifier, extendedGlob: true })).toThrow(
      "no matches found: *(om[^~])",
    );
  });

  it("quoting is gone by the time the word is named", () => {
    expect(() => run("[a\\ b")).toThrow("bad pattern: [a b");
  });

  it("CSH_NULL_GLOB says only `no match`, being about a whole command", () => {
    const opts = { cwd: tree, cshNullGlob: true };
    expect(() => expandWordsSync(["nope*"], opts)).toThrow("no match");
    try {
      expandWordsSync(["nope*"], opts);
    } catch (err) {
      expect((err as Error).message).toBe("no match");
      expect(err).toBeInstanceOf(NoMatchError);
    }
  });

  it("keeps what it worked out in `detail`, out of the message", () => {
    try {
      run("[a");
    } catch (err) {
      const e = err as ZshPatternError;
      expect(e.message).toBe("bad pattern: [a");
      expect(e.detail).toBe("unmatched '['");
      expect(e.kind).toBe("pattern");
    }
  });

  it("says plainly when the fault is this package's own limit, not zsh's", () => {
    // zsh would run the code; there is no wording of its own to borrow.
    expect(() => run("*(e:x:)")).toThrow(/supply a 'qualifierHooks.evaluate'/);
    try {
      run("*(e:x:)");
    } catch (err) {
      expect((err as ZshPatternError).kind).toBe("unsupported");
    }
  });
});

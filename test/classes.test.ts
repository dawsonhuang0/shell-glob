import { describe, expect, it } from "vitest";
import { compile, match } from "../src/index.js";

const EXT = { extendedGlob: true } as const;

/**
 * The `[:name:]` character classes.  The table is what zsh 5.9 answers for
 * `[[ $ch = [[:name:]] ]]` in a UTF-8 locale.
 */
const SAMPLES = ["a", "Z", "5", " ", "\t", "\n", "_", "$", ".", "é"];

const TABLE: Record<string, string> = {
  alpha:  "1100000001",
  alnum:  "1110000001",
  ascii:  "1111111110",
  blank:  "0001100000",
  cntrl:  "0000110000",
  digit:  "0010000000",
  graph:  "1110001111",
  lower:  "1000000001",
  print:  "1111001111",
  punct:  "0000001110",
  space:  "0001110000",
  upper:  "0100000000",
  xdigit: "1010000000",
};

describe("POSIX character classes", () => {
  for (const [name, expected] of Object.entries(TABLE)) {
    it(`[[:${name}:]] matches the same characters as zsh`, () => {
      const actual = SAMPLES.map((ch) => (match(ch, `[[:${name}:]]`, EXT) ? "1" : "0")).join("");
      expect(actual).toBe(expected);
    });
  }

  it("treats a class it does not know as one that never matches", () => {
    expect(match("a", "[[:nosuch:]]", EXT)).toBe(false);
    expect(match("a", "[[:nosuch:]a]", EXT)).toBe(true);
  });

  it("mixes classes with ordinary characters and ranges", () => {
    expect(match("a", "[[:digit:]a-c]", EXT)).toBe(true);
    expect(match("7", "[[:digit:]a-c]", EXT)).toBe(true);
    expect(match("z", "[[:digit:]a-c]", EXT)).toBe(false);
    expect(match("z", "[^[:digit:]a-c]", EXT)).toBe(true);
  });

  describe("[:INCOMPLETE:] and [:INVALID:]", () => {
    // A byte that is not a character is held as `0xDC00 + byte`, which is what
    // zsh does too (`WCHAR_INVALID` in Src/pattern.c).  Expected values come
    // from the built zsh, and mirror its own Test/D07multibyte.ztst.
    const bytes = (...values: number[]) =>
      values.map((v) => String.fromCharCode(0xdc00 + v)).join("");

    it("tells a truncated sequence from an invalid one", () => {
      // A lone lead byte is merely incomplete...
      expect(match(bytes(0xe3), "[[:INCOMPLETE:]]", EXT)).toBe(true);
      // ...and a lead plus one continuation is incomplete, then invalid.
      expect(match(bytes(0xe3, 0x83), "[[:INCOMPLETE:]][[:INVALID:]]", EXT)).toBe(true);
      // A continuation byte on its own can start nothing.
      expect(match(bytes(0x83), "[[:INVALID:]]", EXT)).toBe(true);
      expect(match(bytes(0x83), "[[:INCOMPLETE:]]", EXT)).toBe(false);
    });

    it("never matches a character that is complete and valid", () => {
      expect(match("ホ", "[[:INCOMPLETE:][:INVALID:]]", EXT)).toBe(false);
      expect(match("a", "[[:INCOMPLETE:]]", EXT)).toBe(false);
      expect(match("é", "[[:INVALID:]]", EXT)).toBe(false);
      // The complete sequence is one character, so `?` matches it.
      expect(match("ホ", "?", EXT)).toBe(true);
    });

    it("is never true without MULTIBYTE, as the source says", () => {
      const bytesOff = { ...EXT, multibyte: false };
      expect(match(bytes(0xe3), "[[:INCOMPLETE:]]", bytesOff)).toBe(false);
      expect(match(bytes(0x83), "[[:INVALID:]]", bytesOff)).toBe(false);
    });

    it("splits the OS classes from zsh's own when MULTIBYTE is off", () => {
      const asBytes = { ...EXT, multibyte: false };
      // `IDENT` and `WORD` go through zsh's table, whose entries for bytes
      // above ASCII exist only in a build without multibyte support, so such a
      // byte has no type: `[[ $'\xe3' = [[:IDENT:]] ]]` is false in zsh too.
      expect(match(bytes(0xe3), "[[:IDENT:]]", asBytes)).toBe(false);
      // The rest go to the C library's macros on that byte, which this package
      // reads as the Latin-1 character of the same value.  zsh's answer there
      // follows the locale; this one does not.
      expect(match(bytes(0xc3), "[[:upper:]]", asBytes)).toBe(true);
      expect(match(bytes(0xe3), "[[:lower:]]", asBytes)).toBe(true);
    });
  });

  it("keeps [...] case sensitive even under (#i), as zsh does", () => {
    expect(match("A", "(#i)[a-z]", EXT)).toBe(false);
    expect(match("A", "(#i)a", EXT)).toBe(true);
  });
});

describe("bracket expression parsing", () => {
  it("takes a leading ] as an ordinary character", () => {
    expect(match("]", "[]]", EXT)).toBe(true);
    expect(match("]", "[]a]", EXT)).toBe(true);
    expect(match("a", "[]a]", EXT)).toBe(true);
    expect(match("[]", "[^]]]", EXT)).toBe(true);
  });

  it("takes a trailing or leading - literally", () => {
    expect(match("-", "[a-]", EXT)).toBe(true);
    expect(match("-", "[-a]", EXT)).toBe(true);
    expect(match("-", "[a-z]", EXT)).toBe(false);
  });

  it("accepts both ^ and ! for negation", () => {
    expect(match("b", "[^a]", EXT)).toBe(true);
    expect(match("b", "[!a]", EXT)).toBe(true);
    expect(match("a", "[^a]", EXT)).toBe(false);
  });

  it("understands a backslash escape inside the brackets", () => {
    expect(match("]", "[\\]]", EXT)).toBe(true);
    expect(match("-", "[a\\-c]", EXT)).toBe(true);
    expect(match("b", "[a\\-c]", EXT)).toBe(false);
  });

  it("compares a literal run byte by byte when multibyte is off", () => {
    expect(match("é", "é", { ...EXT, multibyte: false })).toBe(true);
    expect(match("🦄x", "🦄x", { ...EXT, multibyte: false })).toBe(true);
  });

  it("matches whole code points, or single bytes without multibyte", () => {
    expect(match("é", "?", EXT)).toBe(true);
    expect(match("🦄", "?", EXT)).toBe(true);
    expect(compile("?", EXT).exec("🦄")?.match).toBe("🦄");
    // Without MULTIBYTE a character is its UTF-8 bytes, so `é` needs two `?`
    // and `🦄` needs four, exactly as in zsh.
    const bytes = { ...EXT, multibyte: false };
    expect(match("é", "?", bytes)).toBe(false);
    expect(match("é", "??", bytes)).toBe(true);
    expect(match("🦄", "??", bytes)).toBe(false);
    expect(match("🦄", "????", bytes)).toBe(true);
  });
});

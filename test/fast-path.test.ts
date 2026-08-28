import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import { fixtureLines } from "./helpers/fixture.js";

/**
 * `*.ts`, `prefix*`, `*inner*`, a plain word and any fixed width pattern are
 * answered with one native string operation instead of a walk through the
 * matcher.  That is the one place in this package where speed could cost an
 * answer, so it is checked rather than assumed: every case in the approximate
 * corpus is answered both ways and the two must agree.
 *
 * The corpus caught two of these when they were written -- a leading `.` after
 * a literal, and byte semantics under NO_MULTIBYTE -- so the check earns its
 * keep.
 */
const CORPUS = fileURLToPath(new URL("./fixtures/approx.txt", import.meta.url));

const cases = fixtureLines(CORPUS)
  .filter((line) => line.length > 0 && !line.startsWith("#"))
  .map((line) => {
    const [, pattern, subject = ""] = line.split("\t");
    return { pattern, subject };
  });

const answer = (pattern: string, subject: string, noFastPath: boolean) => {
  try {
    return compile(pattern, { extendedGlob: true }, { noFastPath }).test(subject) ? "t" : "f";
  } catch {
    return "E";
  }
};

describe("the fast paths", () => {
  it("answer every corpus case exactly as the matcher does", () => {
    const differing: string[] = [];
    for (const { pattern, subject } of cases) {
      if (answer(pattern, subject, false) !== answer(pattern, subject, true)) {
        differing.push(`${pattern} vs ${JSON.stringify(subject)}`);
      }
    }
    expect(differing).toEqual([]);
  });

  it("and are actually being taken for the shapes they are for", () => {
    // Otherwise the check above would be vacuous.
    const shapes = ["*.ts", "prefix*", "*inner*", "plain", "a?c", "(#i)*README*"];
    for (const shape of shapes) {
      const fast = compile(shape, { extendedGlob: true }, {});
      expect((fast as unknown as { fastTest: unknown }).fastTest).not.toBeNull();
      const slow = compile(shape, { extendedGlob: true }, { noFastPath: true });
      expect((slow as unknown as { fastTest: unknown }).fastTest).toBeNull();
    }
  });
});

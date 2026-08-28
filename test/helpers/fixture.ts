import { readFileSync } from "node:fs";

/**
 * Reads a line-based fixture.
 *
 * The fixtures are captured from zsh byte for byte, so what is in them is
 * data rather than text -- and git's Windows default rewrites line endings on
 * checkout, which corrupts it: a subject recorded as `readme` comes back as
 * `readme\r` and stops matching `readme`. The `.gitattributes` at the root
 * marks them as never converted, which is the real fix; this undoes the
 * damage anyway, so a working copy checked out before that rule existed still
 * runs.
 *
 * Reversing the conversion cannot lose anything, because the format has no
 * way to carry a carriage return in the first place: a pattern or glob is
 * stored as an index into a JSON file, and a result holding a byte a line
 * cannot hold is JSON encoded and marked. No fixture contains one.
 */
export function fixtureLines(path: string): string[] {
  const text = readFileSync(path, "utf8");
  return (text.includes("\r\n") ? text.replace(/\r\n/g, "\n") : text).split("\n");
}

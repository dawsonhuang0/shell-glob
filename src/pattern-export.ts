/**
 * The pattern matching half of the package, with no dependency on `node:fs`,
 * for use in the browser or wherever filename generation is not wanted.
 *
 *     import { compile, match } from "zsh-glob/pattern";
 */
export { compile, match, ZshPattern } from "./pattern.js";
export type { PatternMatch, PatternSettings } from "./pattern.js";
export { defaultOptions } from "./options.js";
export type { ZshOptions, ZshOptionsInput, GlobFlags } from "./options.js";
export { NoMatchError, ZshPatternError } from "./errors.js";

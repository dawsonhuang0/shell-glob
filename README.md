# z-shell-glob

[![npm](https://img.shields.io/npm/v/z-shell-glob.svg)](https://www.npmjs.com/package/z-shell-glob)

zsh's pattern matching and filename generation, ported to TypeScript.

Not "glob syntax inspired by zsh" — the actual thing, including the parts other
libraries leave out: glob qualifiers (`*(.OL[1,3])`), globbing flags
(`(#i)`, `(#b)`, `(#a2)`), approximate matching, `^` and `~`, `**/` and
`(pat/)#`, and the ksh operators. The parser follows `patcompswitch` from
`Src/pattern.c`, the matcher follows `patmatch`, and filename generation
follows `Src/glob.c`.

## Installation

```
npm install z-shell-glob
```

## Usage

### Finding files

```ts
import { glob, globSync } from "z-shell-glob";

await glob("**/*.ts");         // async, via node:fs/promises
globSync("**/*.ts");           // sync, via node:fs
globSync("src/**/*.(ts|js)");  // grouping and alternation, no options needed
```

Both take the same options and return the same list. The traversal is written
once, as a generator that yields filesystem requests, so the two cannot drift.

**`extendedGlob` is off by default**, exactly as in a bare `zsh -f`, so `^`,
`~`, `#` and `(#...)` are ordinary characters until you ask for them:

```ts
const opts = { extendedGlob: true };

globSync("**/*.ts~*test*", opts);      // every .ts file except the tests
globSync("^*.md", opts);               // everything that is not a .md
globSync("(#i)**/*.TS", opts);         // case insensitively
globSync("src/**/(#a1)indx.ts", opts); // approximately: finds index.ts
```

### Glob qualifiers

The `(...)` suffix filters, sorts and reshapes the results — the reason to
reach for zsh's globbing rather than anyone else's:

```ts
globSync("**/*.ts(.)");         // plain files only
globSync("*(/)");               // directories only
globSync("**/*(.x)");           // executable by their owner
globSync("**/*(.mh-2)");        // modified in the last two hours
globSync("**/*.log(.Lm+1)");    // larger than one megabyte
globSync("**/*.ts(.OL[1,3])");  // the three largest, largest first
globSync("**/*.ts(:t)");        // basenames only, as with ${x:t}
globSync("*(/F)", { markDirs: true }); // non-empty dirs, with a trailing /
```

They combine with implicit AND, and with `,` for OR. Both the bare form and
`*(#q...)` are recognised.

### Matching a string

No filesystem involved. Import from `z-shell-glob/pattern` to leave `node:fs` out
of the bundle entirely — that entry point runs in a browser.

```ts
import { compile, match } from "z-shell-glob/pattern";

match("foo.c", "*.c~bar*", { extendedGlob: true });  // [[ foo.c = *.c~bar* ]]
match("README", "(#i)readme", { extendedGlob: true });
match("readme", "(#a1)raedme", { extendedGlob: true }); // one transposition
```

Compile once to reuse a pattern, and to read back what `(#b)` captured:

```ts
const p = compile("(#b)(*).ts", { extendedGlob: true });

p.test("app.ts");        // true
p.exec("app.ts")?.groups; // ["app"]
```

`$match`, `$mbegin` and `$mend` come back as `groups`, `mbegin` and `mend`,
with zsh's one-based indices and `-1` for a group that did not participate.

The forms parameter expansion uses are all there:

| zsh | z-shell-glob |
| --- | --- |
| `[[ $s = $pat ]]` | `p.test(s)` |
| `${s#pat}` | `s.slice(p.matchStart(s))` |
| `${s##pat}` | `s.slice(p.matchStart(s, { longest: true }))` |
| `${s%pat}` | `s.slice(0, p.matchEnd(s))` |
| `${s%%pat}` | `s.slice(0, p.matchEnd(s, { longest: true }))` |
| `${s/pat/rep}` | `p.replace(s, rep)` |
| `${s//pat/rep}` | `p.replace(s, rep, { global: true })` |

`replace` also takes a function, which receives the match and its groups.

### A filesystem of your own

Anything with `readdir`, `lstat` and `stat` will do, which makes virtual trees
and tests easy. Failures come back as `null` rather than exceptions, so an
unreadable directory contributes nothing instead of aborting the walk.

```ts
import { globSync, type SyncFsAdapter } from "z-shell-glob";

const fs: SyncFsAdapter = {
  readdir: (path) => entriesFor(path),
  lstat: () => null,
  stat: () => null,
};
globSync("**/*.md", { cwd: "/virtual", fs });
```

### Errors

`message` is the text zsh prints after its `zsh:LINE:` prefix, and nothing
else. What this package worked out is kept out of the way, in `detail`.

```ts
globSync("[a");         // ZshPatternError: bad pattern: [a
globSync("*(z)");       // ZshPatternError: unknown file attribute: z
globSync("nope*");      // NoMatchError:    no matches found: nope*

try { globSync("[a"); } catch (e) {
  e.message;  // "bad pattern: [a"   what zsh says
  e.detail;   // "unmatched '['"     what we found
  e.kind;     // "pattern" | "qualifier" | "unsupported"
}
```

`nullGlob: true` gives an empty list instead of `NoMatchError`;
`noMatch: false` gives the pattern back. `kind` decides whether
`badPattern: false` applies, because zsh parses qualifiers before the pattern
and only the latter reaches that option — so `*(` becomes an ordinary word
while `*(z)` still throws. `"unsupported"` is not zsh's: it marks the few
things this package will not do, such as running the shell code an `e`
qualifier holds.

## Options

zsh's options, with zsh's defaults.

| Option | Default | | Option | Default |
| --- | --- | --- | --- | --- |
| `extendedGlob` | `false` | | `caseGlob` | `true` |
| `kshGlob` | `false` | | `casePaths` | `false` |
| `shGlob` | `false` | | `numericGlobSort` | `false` |
| `globDots` | `false` | | `globStarShort` | `false` |
| `nullGlob` | `false` | | `markDirs` | `false` |
| `cshNullGlob` | `false` | | `listTypes` | `false` |
| `noMatch` | `true` | | `bareGlobQual` | `true` |
| `glob` | `true` | | `badPattern` | `true` |
| `multibyte` | `true` | | `posixIdentifiers` | `false` |

That is every option in zsh's "Expansion and Globbing" section that reaches
pattern matching or filename generation; the rest belong to earlier stages of
word expansion. For `glob`/`globSync` there are also `cwd`, `absolute`,
`fs`/`fsAsync`, `qualifierHooks`, `now`, `maxDepth` and `nfcNames`.

`CSH_NULL_GLOB` judges a whole command rather than a word, so
`expandWordsSync(words, options)` is what applies it.

## What is different from the shell

- **Quoting.** You pass a raw string rather than a word the lexer has already
  tokenised, so `\` escapes the next character: `\*` is a literal asterisk.
- **Shell code in qualifiers** — `e:...:`, `+cmd`, `oe:...:`, `o+cmd` — needs a
  hook, since this package does not run a shell. So do `u:name:` and `g:name:`,
  which Node cannot resolve on its own. Everything else needs nothing.
- **No tilde or brace expansion.** `~/foo` and `{a,b}` are earlier stages of
  word expansion, not filename generation. Here `~` is only the exclusion
  operator.
- **`[[:INCOMPLETE:]]` and `[[:INVALID:]]` never match**, since a JavaScript
  string cannot hold a partial or invalid character.
- **Unsupported colon modifiers** (`:A`, `:q`, `:Q`, `:P`) throw rather than
  being silently ignored.

## Performance

Against the zsh built from `./zsh`, both doing the same work in one process:

```
pattern matching       10.7x faster
filename generation     2.8x faster   (4.6x with the async API)
```

Filename generation is at the floor — 81% of its time is the `readdir`
syscall. The async API goes below that floor by reading a level at a time, so
the reads overlap, which a shell walking a tree cannot do.

Approximate matching is the exception: it is *slower* than zsh, because
matching zsh's answers there means reproducing state it leaves behind, and no
shortcut survives that. Accuracy won.

## Testing

```
npm test          # 130,538 assertions, nothing skipped
npm run coverage
```

The corpus is not scraped from zsh's test files — it is captured from zsh
itself, by patching `patcompile()` to log every pattern it compiles and then
running zsh's own test suite against that build. Each case is replayed under
every option combination that can change its result: **256,480 assertions**
over 4,647 patterns and 3,368 globs, all generated by
`npm run fixtures`.

There are no known divergences.

## Further reading

[`NOTES.md`](NOTES.md) collects the corners where following zsh meant
reproducing something surprising — the empty components in `a//b`, why
`(#a1)(#i)(#a1)` matches where `(#a1)(#a1)` does not, why `?#.foo` will not
match `.foo`, and what `zreaddir` does to names on macOS. Each is a decision
someone might otherwise take for a bug.

## Licence

MIT. This is an independent reimplementation from the zsh documentation and
sources; no zsh code is distributed here. The test corpus derived from zsh's
`Misc/globtests` carries the zsh licence, reproduced in `LICENSE`.

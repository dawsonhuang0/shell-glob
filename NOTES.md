# Notes on following zsh

Following zsh closely means reproducing behaviour nobody would design on
purpose. These are the corners that took reading `Src/pattern.c` and
`Src/glob.c` to get right — written down because each one looks like a bug
until you know why it is there, and someone will eventually try to "fix" it.

Every claim here is pinned by a test, and most were found by a differential
sweep against the zsh built from `./zsh` rather than by reading alone.

| | |
| --- | --- |
| [Performance](#performance) | Where the time goes, and the one place accuracy cost speed |
| [Approximate matching](#approximate-matching) | `(#a...)` depends on state zsh leaves behind, so no shortcut survives |
| [Qualifier subscripts](#glob-qualifier-subscripts) | `*(om[2*2])` is arithmetic, and zsh's precedence is not C's |
| [Empty path components](#a-glob-is-a-list-of-components-and-empty-ones-are-real) | `a//b` has three components, and the empty one is real |
| [Pure strings](#a-redundant-flag-group-truncates-only-a-flagless-pattern) | Why `a(#a0)b` matches `a` and not `ab` |
| [Where `~` belongs](#a-top-level-belongs-to-its-component) | Splitting an exclusion out of its component loses an interaction |
| [Which zsh a string means](#which-zsh-a-pattern-string-means) | The written-out word, not `${~var}` — they differ |
| [Before the path is split](#what-filename-generation-does-before-it-looks-at-the-path) | One leading `(#...)` is peeled, and a leading `(#e)` asserts nothing |
| [`Yn` and `MARK_DIRS`](#two-more-places-zsh-is-not-tidy) | A short circuit that must cut the walk, and a doubled slash |
| [Slash runs](#a-run-of-slashes-is-a-run-of-components) | `sub//x` keeps its run, even through a closure |
| [NFC on macOS](#names-come-back-composed-on-macos) | `zreaddir` composes names, and it changes what matches |
| [Flag position](#where-a-globbing-flag-sits-changes-what-it-does) | Start, middle and end are three different things |
| [`^` and `~`](#and-are-exclusions-and-see-different-flags) | Both are exclusions, and they see different flags |
| [Testing](#testing) | How the corpus is captured from zsh itself |

## Performance

`npm run bench` compares this package against the zsh built from `./zsh`, with
both doing the same work inside one process, so what is measured is matching
and walking rather than process start-up:

```
pattern matching       ours      4.3ms   zsh     48.0ms    11.21x faster
filename generation    ours    103.0ms   zsh    320.1ms     3.11x faster
  the same, async      ours     63.1ms   zsh    320.1ms     5.08x faster

nested closures over a 400 character subject, 200 rounds each:

(f#o#)#                ours      2.0ms   zsh      1.4ms     1.47x slower
*(*(f)*(o))            ours      2.1ms   zsh      1.0ms     2.20x slower
```

The matching figure flatters us a little — zsh's side pays shell-interpreter
overhead for the loop around each test — but filename generation is a fair
comparison: both walk the same tree, match the same names and sort the same
results, and both file-generation rows return identical file lists. Every row
above agrees with zsh on the answer; only the time differs.

### Matching

Most of this is zsh's own strategy, taken from `Src/pattern.c`, which is worth
saying plainly: reading how `patmatch` handles `P_WBRANCH`, `P_STAR` and
`P_ONEHASH` was more productive than any amount of profiling, and found a bug
besides.

- **Nested closures do not backtrack exponentially.** zsh's P_WBRANCH marks
  every subject position a closure has been entered at and refuses to enter it
  there twice — "to remove exponential behaviour in backtracking nested
  closures". Its two corpus cases, `(f#o#)#` and `*(*(f)*(o))`, took this
  matcher 181ms and 505ms on the 26-character subject zsh's own tests use, and
  would not have finished at all on a longer one. They are now flat in the
  length of the subject: 400 characters costs about 10µs. Those last two rows
  are the honest remaining gap — zsh is still faster there, by a factor of two
  rather than of ten thousand.
- **A `*` looks ahead at what follows it.** zsh keeps the first character of the
  next literal in `nextch` and only recurses at positions that could start it;
  the same idea here covers a following `[...]` and `<x-y>` as well. `*foo*bar*baz*`
  went from 4.2µs to 1.2µs on the benchmark's subjects.
- **A `*` stops early.** Each sequence knows the least its tail can consume, so
  the scan starts at the last position that could still work, and a tail
  spelling out more characters than are left fails without backtracking.
- **A closure over one unit counts greedily**, as `patrepeat` does, instead of
  recursing per iteration. This is zsh's `P_SIMPLE` path — `?#`, `[abc]##`,
  `x#` — and it is *not* only an optimisation: see the note below.
- **A run of nodes that can each match only one way is walked in a loop**, with
  no continuation per node. Nothing in such a run is ever backtracked into, so
  the closures were pure allocation.
- **Character classes are memoised per class**, ASCII in a table and the rest in
  a map. A class asks Unicode questions — `\p{L}` and friends — that cost far
  more than the comparison they stand for, and `[[:alpha:]]##` asks the same
  question of the same character over and over.
- **Common shapes bypass the matcher entirely.** `*.ts`, `prefix*`, `*inner*`
  and a plain word each reduce to one native string operation, as do patterns
  of literals and `?`, which have a fixed width, and the case-insensitive forms
  of both.
- **A literal's units are split once**, and a subject with no surrogate pair is
  indexed directly, since each UTF-16 unit is then one code point.
- **Nothing is allocated by a test that fails.** The end-of-pattern
  continuation, the capture array and the `*` continuations are all reused or
  gone; `compile` keys its cache on the options object itself rather than
  serialising it, which took a `match(str, pat, opts)` call from about 110ns to
  14ns.

Every shape was then checked against zsh one at a time, rather than in the
aggregate the table above reports, which is the only way to find the places
where we lose. Across 47 shapes we are between 1.03x and 18x faster on 42 of
them; the five we are behind on are all `(#a...)` approximate matching, by
between 1.0x and 1.4x — a four-way search with no shortcut left in it, run in
JavaScript against the same search in C. The worst of them, `(#a3)aaaaaaaaaa`,
started this round **19.7x slower** than zsh:

- **Width bounds now hold under approximation too.** An error moves what a
  pattern consumes by at most one unit, so a bound only has to be widened by
  the budget rather than abandoned. An anchored match also checks the whole
  pattern's span up front, which answers `(#a3)aaaaaaaaaa` against anything
  outside seven to thirteen characters without matching at all.
- **The `*` lookahead comes back once the budget is spent.** zsh switches its
  own off for as long as approximation is in play, because a node can then
  match a character it does not spell. With no errors left every node must
  match exactly again, so the lookahead is sound once more — which took
  `(#a1)a*b*c` from 3.2x slower to level.

### Filename generation

**The synchronous walk is at the floor.** A CPU profile puts **81%** of its time
in the `readdir` syscall itself and about 12% in this package, so even perfect
code would gain an eighth. Node's own `readdirSync(dir, { recursive: true })` is
3x *slower* than the manual recursion here, and `opendirSync` slower again.

So the only thing left is to stop waiting on those reads one at a time, and
that is something Node can do and a shell cannot:

- **`glob()` reads the tree a level at a time.** Before walking, it works out
  which directories the walk is going to want, segment by segment, and hands
  each level to the driver as one batch that goes out as a single
  `Promise.all`. On the benchmark tree that is **1.6x faster than the
  synchronous walk** — below the floor a shell is stuck with.
- It only warms the cache. `globSync` is left alone, since reading ahead costs
  it the same syscalls in the same order and buys it nothing, and a test asserts
  that the two paths read *exactly* the same set of directories, over 42
  combinations of pattern and option including symlinks, `***\/`, dotfiles and
  `maxDepth`. Reading ahead must never widen the search.
- **Directory listings are cached for the duration of an expansion**, so the
  two visits a recursive glob makes to each directory — one for the closure,
  one for the segment after it — cost one read.

## Approximate matching

`(#a...)` was the one corner no corpus reached: `harvested.txt` holds not one
approximate case, and zsh's own tests use the flag nineteen times on a handful
of shapes. `scripts/harvest-approx.mjs` generates **16,640** — 65 pattern
shapes against 64 subjects at every error budget from none to three — and zsh
answers them. It found 123 disagreements, then 557 once the corpus was widened.

**All of them are gone. `test/fixtures/approx-divergences.txt` is empty.**

Getting there meant giving up on writing a matcher that computes the same thing
a tidier way, because approximate matching in zsh is not a function of the
pattern and the subject alone. Six things had to be followed rather than
reimplemented:

- **A literal run is not a choice point.** zsh walks a `P_EXACTLY` exactly; if
  it matches in full, `scan = next` and it never comes back, so a later failure
  is repaired where it happens rather than by mis-spelling something that had
  already matched. `(#a1)ab?` does not match `ab`.
- **Everything that is not a literal run gets one repair** — omit a character
  from the subject, in a loop — and that includes `(#s)` and `(#e)`, which is
  why `(#a1)abc(#e)` matches `abcd`.
- **A pattern of nothing but flags is a string.** `(#a1)` is compiled to a
  plain empty string and compared as one, so it matches the empty string and
  nothing else; `(#a1)()` has a node in it and matches `a`.
- **`exactpos` and `exactend` outlive the attempt that set them.** They say how
  far into a run the four repairs have got. `exactpos` is copied into a local
  and put back between attempts; `exactend` is not, so an attempt that fails
  inside a *different* run leaves it pointing there and the repairs that follow
  measure against the wrong end. This is why `bc` does not match `(#a1)a?c`
  though it matches `(#a1)abc`. Reproducing it needs literal runs to know where
  they sit in the compiled pattern, which is what `StrNode.order` is for.
- **`errsfound` is put back only by a branch** — an alternation, a closure, a
  `*` — and not when a node or a counted iteration fails. An error spent on a
  failed `(#cN,M)` iteration stays spent, which is what stops `(#a1)a(#c1,3)b`
  matching `a`.
- **`(#cN,M)` is P_COUNT**, which keeps its count and the position it last tried
  on the pattern node; the count is put back when an iteration fails and the
  position is not.

The consequence runs the other way from everything else in this file: because a
node that fails leaves state behind, **reaching a node is part of the answer**.
Every optimisation that skips a node it can prove would fail — the width
bounds, the deterministic run, the closure fast path — is switched off wherever
approximation is in force. The one exception is the `*` lookahead, which is
switched off and on by the budget in force *at that star*, exactly as zsh's is:
off under `(#a...)`, and on inside an exclusion, where approximation has to be
asked for again. That last detail is not an optimisation at all — it decides
whether the node after the star is ever entered, and so whether it leaves
`exactend` behind. Without it `(#a2)abc~*x*` does not match `abx`.

So approximate matching here is **slower than zsh**, by between 1.2x and 3.8x,
where the rest of this package is faster. That is the right way round for a
port, and it is the honest price of the row above reading zero.

The examples the manual gives are pinned separately in `test/approx.test.ts`,
and 3,060 further cases the fixes were never made against were checked
afterwards: no disagreements there either.

## Glob qualifier subscripts

`*(om[1,3])` looks like a slice, but each half is a full arithmetic
expression, evaluated by the shell's own math. This package used to read them
as numbers and treat anything else as zero, which quietly turned an error into
an empty selection. `src/arith.ts` now evaluates them, and the surprises were
all in `Src/math.c`:

- **The precedence is not C's.** `prec = isset(CPRECEDENCES) ? c_prec : z_prec`,
  and `CPRECEDENCES` is off by default, so zsh uses its own table: the shifts
  and the bitwise operators bind *tighter* than multiplication, and `**` sits
  between them. `1|2*3` is **9**, not 7, because it groups as `(1|2)*3`;
  `1<<2+3` is **7**, not 32; and `-2**2` is **4**, because unary binds tighter
  still.
- **A leading zero is not octal.** That is `OCTAL_ZEROES`, an sh-emulation
  option, so `010` is ten.
- **The arithmetic is 64 bit**, as `zlong` is: `1<<31` is 2147483648.
- `^^` is a logical exclusive or, which C has no operator for; `1_000` may
  carry underscores; `16#ff`, `0xff` and `0b10` all work, and `zstrtol` stops
  where it cannot go on rather than complaining, so `0x` is zero.
- **The subscript splits at its top level comma only** — `getarg` counts
  brackets and parentheses — so `[(1,2)]` is one expression using the comma
  operator, not a range.

Reading `checkglobqual` fixed a second thing at the same time: a trailing group
stops being a bare qualifier list on a closing `)`, not an opening `(`, because
`case Outpar` falls through into `case Bar`. An explicit `(#q...)` is exempt,
which is why `*(#qom[(1,2)])` works and `*(om[(1,2)])` does not.

## A glob is a list of components, and empty ones are real

Every `/` separates two components, and an empty component matches the empty
name and contributes a slash of its own. A *leading* empty component is what
makes a path absolute — which is the whole of why these differ:

```
**/sub    →  sub          the closure may match nothing, and `sub` is relative
**//sub   →  nothing      the empty component is then the first, so it is /sub
```

A component of nothing but globbing flags compiles to an empty pure string, so
it is an empty component too: `(#i)/sub` is `/sub`, not `sub`. An *assertion*
is not a flag, though — `(#s)` and `(#e)` are "handled as a normal node", so a
component holding one has something in it. With an empty body an error can
still be spent on the subject, which is why `(#a1)(#e)` matches any one
character name.

The empty components written in front of a closure are components in their own
right, so they survive even when the closure takes no directory at all:
`sub//**/` gives `sub//`, not `sub/`. And a slash run can make what follows
absolute, including a second closure, which then walks from the root.

The path is therefore built by joining components rather than by appending to a
prefix, and "no component yet" is distinct from "one empty component so far".

## A redundant flag group truncates only a flagless pattern

`P_PURESTR` is cleared for a run compiled while approximation, `GF_LCMATCHUC`
or `GF_IGNCASE` is in force — "it's much simpler to turn off pure string mode
for any case-insensitive or approximate matching". So `a(#a0)b` still matches
`a` alone, but `(#i)a(#i).txt` keeps both of its runs and matches `a.txt`.

## A top level `~` belongs to its component

zsh keeps it in that component's own program, as a `P_EXCLUDP` that gets the
path so far put in front of it. Testing it separately gives the same answer
whenever the two cannot interact — but they do, through the sync node that
stops an exclusion being retried at an end the branch already reached:

```
*^        matches every non-empty name
~a.txt    excludes one of them
*^~a.txt  matches nothing at all
```

Where the whole word is one component there is no path to put in front, so it
is compiled as it stands and the interaction survives.

## Which zsh a pattern string means

Handed a raw string, this package does the shell lexer's job before globbing:
it resolves backslash quoting and tokenizes. That is the *written-out* word,
`zsh -c 'echo file<1-2>.txt'` — not `${~var}`, which turns pattern characters
on without doing quote removal or the lexer's tokenizing. The two really do
differ, and twice a differential harness built on `${~var}` sent this port
after a bug it did not have. Where they part company:

| word, under `SH_GLOB` | `${~var}` | written out |
|---|---|---|
| `file<1-2>.txt` | passes through | no matches found |
| `sub\/*.txt` | no match — a literal `\` in the name | `sub/b.txt` |

`haswilds` is what decides a word is a pattern at all, and it runs "before
zpc_special has been set up": `case Inang` has no `SH_GLOB` test, though
`case Inpar` right above it does. So a `<1-2>` makes the word a pattern even
where `SH_GLOB` renders the operator inert — the pattern then spells only its
own text, matches nothing, and reports that rather than being handed back. A
`(` is the other way round: neither the lexer nor `zshtokenize` makes it a
token under `SH_GLOB`, so the ksh arm of `case Inpar` tests for something that
cannot arrive, and `!(f)` is an ordinary word.

The generated corpus goes through `${~use}`, because that is the only way to
sweep thousands of words; the four globs where that matters are checked against
the written-out form instead, and `test/harvested-globs.test.ts` says so.

## What filename generation does before it looks at the path

`parsepat` peels one leading `(#...)` off the whole word "so that they don't
form a bogus path component", and only then splits it into components. Two
things follow that are easy to get wrong, and this package got both wrong:

- **`(#i)**/` still recurses.** The globstar test is `instr[0] == Star &&
  instr[1] == Star` on what is left after the peel, so a leading flag does not
  hide it — but a *second* group does, since only one is peeled. `(#i)**/`
  recurses; `(#i)(#l)**/` and `sub/(#i)**/` do not.
- **A leading `(#e)` asserts nothing.** `parsepat` collects the assertion into
  a local it never reads, so `(#e)a` matches the file `a` during filename
  generation. In plain matching it still asserts, and `[[ a = (#e)a ]]` is
  false.

The peeled flags apply to every component, as `patglobflags` does — but not to
an exclusion, where approximation is switched off unless asked for again.

## Two more places zsh is not tidy

**`Yn` is a short circuit, not a trim.** "Only the first n matches in directory
traversal order will be considered. Any sorting specified with an `oc` or `Oc`
qualifier is applied *after* the n matches are returned; `oN` is implied
otherwise." `scanner` checks `shortcircuit == matchct` at every insertion and
stops walking there, so sorting first and then trimming picks a different set
and defeats the point.

Traversal order is the one thing Node does not hand over: `fs.readdir` goes
through libuv's `scandir`, which sorts with `alphasort`, while zsh takes what
`readdir` gives. The walk reads through `opendir` when a `Y` is in play, which
matches zsh and `ls -f` exactly, and keeps the faster sorted read everywhere
else. The count is of files that *survive* the qualifiers, as `matchct` is, so
the walk only stops early when nothing downstream can reject a candidate.

**`MARK_DIRS` appends unconditionally.** `insert()` writes the mark at
`news[strlen(s)]` without looking at what is there, so a pattern that already
ends in a slash gets a second one: `**/` gives `sub//`. Ugly, and reproduced.

## A run of slashes is a run of components

`parsecomplist` recurses past each `/`, so `sub//x` is three components — the
middle one matching the empty name and contributing a slash of its own. The run
survives into the result, and `*//x` keeps it once the star has matched.
Collapsing it looked right only because a word of pure literals is never
globbed at all, so `sub//x` came back untouched for the wrong reason.

A closure that consumed nothing joins one slash fewer than it has components,
which is why `**/` reports nothing for that case while `**//` reports `/`.

## Names come back composed on macOS

`zreaddir` converts every directory entry from `UTF-8-MAC` to `UTF-8` with
`iconv`, keeping the original if that fails — and it does so **only** under
`#ifdef __APPLE__`. It is not cosmetic: a name stored as `e` + U+0301 is
eleven characters on disk and ten to zsh, so `?clair.txt` finds it and
`[a-z]*` does not.

```
disk (readdir)  65 cc 81 63 6c 61 69 72 …     e + combining acute
zsh (glob)      c3 a9 63 6c 61 69 72 …        é
zsh (a variable, or ls) — unchanged, since only readdir is converted
```

This package does the same, defaulting to on for darwin and off elsewhere, and
`nfcNames` overrides it either way. Composing is safe where zsh does it because
the filesystem is normalisation insensitive, so the composed name still opens
the file; on a filesystem that is not, the two are different names, which is
why zsh restricts it.

## Where a globbing flag sits changes what it does

`patcompbranch` has three cases for a `(#...)` group, and only the first is the
obvious one:

- **At the very start** it goes into the pattern header and applies throughout.
- **In the middle** it becomes a `P_GFLAGS` node, set when execution reaches it.
- **At the very end it emits nothing at all** — "just leave the flags for the
  next Patprog in the chain to pick up". So `??(#a1)` does not match `sub`,
  while `??(#a1)/x` matches `sub/x`: a `/` is more of the word, so there the
  group is no longer last. A `(#s)` or `(#e)` is exempt, being "handled as a
  normal node".
- **And a group that changes nothing emits nothing either** — "No effect".

That last pair decides whether a run of flag groups is a pattern at all. With
no node the whole thing is `PAT_PURES` holding an empty string, compared with
`strcmp`, so no flag reaches it and it matches only `""`. One node is enough to
stop that, and the flags are then in force when the end is reached, so an error
can absorb a character:

```
(#a1)                     matches only ""     no node: every group is first or last
(#a1)(#a1)(#a1)(#a1)      matches only ""     the middle ones change nothing
(#a1)(#i)(#a1)            matches "a"         the (#i) changes something, and is emitted
(#a1)(#a1)(#a1)(#i)(#a1)  matches "a"         likewise
```

The globber sees the same rule one group further along, since `parsepat` peels
the first group before the components are split — so `(#a1)(#i)(#a1)` matches
nothing as a glob while matching `a` as a pattern.

And one that only a generated corpus finds: a pattern of nothing but literal
text is compared as a plain string, and the code that extracts it takes the
first run and stops — "Only one string in a PAT_PURES, so now done". A flag
group that changes *nothing* emits no node, so it splits the text into two runs
while leaving it a pure string, and the second run is never looked at:
`a(#a0)b` matches `a` and not `ab`. `a(#i)b` is fine, because a group that does
change something emits a node.

The corpus grew to cover this: `scripts/harvest-approx.mjs` now places the flag
group at the front, at the end, in the middle and at both ends, which took it
from 21,312 cases to **85,248**, and it records a third answer — `E` — where
zsh rejects the pattern outright.

## `^` and `~` are exclusions, and see different flags

Both compile to the same machinery, and the flags they match with are not the
flags in force where they are written:

- **Approximation is off inside a `^`**, as it is inside a `~` — the doc says
  so for `~` and `patcompnot` inherits it. `(#a1)^ab` does not exclude `ac`.
- **A case flag does reach the exclusion** — `(#i)^ab` excludes `aB` — **unless
  it was set inside the group the `^` is in**. Inside parentheses the exclusion
  is compiled through `patcompswitch` rather than `patcompbranch`, and comes
  out matching with the flags the group was entered with: `((#i)^ab)` does not
  exclude `aB`, while `(#i)(^ab)` does. Instrumenting zsh showed both compile
  the exclusion with identical flags, so the difference is at run time.
- **An exclusion is not retried at an end another alternative already
  reached.** `P_EXCSYNC` marks the position — "if we already matched from here,
  this time we fail" — and every alternative runs into the same node, so
  `(^a|^b)~c` does not match `a` though `^b` alone would. The mark is the error
  count rather than a bit, as `P_WBRANCH`'s is, so arriving with fewer errors
  spent is still worth trying.
- **An exclusion may spend errors reaching the end the branch reached**, just
  as the whole pattern may: `(#a2)abc~(#a2)b` excludes `abc`.
- **A group holding a nested exclusion does not put its flags back.** The node
  that restores them is emitted only "if gfchanged", and an exclusion zeroes
  the error budget at compile time, which can leave the group looking
  unchanged. So `((#a2)(a~b)c)` matches `abcd` — the `c` absorbs the trailing
  character with a budget that should have ended at the parenthesis — while
  `((#a2)(a)c)` does not. Only the budget leaks, since that is all an exclusion
  clears, and only a *nested* one, since the group's own exclusion is compiled
  after `gfchanged` has been decided.

## Faithfulness came first

The largest wins here were found by reading zsh rather than by profiling, and
one of them was a bug:

`X#` over a single character compiles to `P_ONEHASH`, and that path *refuses*
the closure when it stands at the start of a filename before a leading dot,
rather than falling back on matching nothing. So `?#.foo` does not match
`.foo` — but `(?)#.foo` does, because a group is compiled as a branch, and
`<->#.foo` does too, because a number range is not one of the simple operands.
This package used to match all three. Implementing zsh's fast path fixed the
answer and sped the case up together.

P_WBRANCH went the other way: it looks like bookkeeping to stop a zero-width
closure looping for ever, and the comment beside it says it is also what keeps
nested closures from going exponential. Taking that at its word turned a
pattern from zsh's own corpus from 181ms into 10µs at six times the length.

A third came from a coverage report rather than a corpus: `matchStar` had no
test reaching it, which turned out to be because a closure over a bare `*`
cannot occur — `if (kshchar && (hash || count)) return 0`, "too much at once
doesn't currently work", and `case Star` sets `kshchar = -1` as "a sign that we
can't have #'s". So `*#`, `*##`, `*(#c2,3)`, `@(a|b)#` and every other
`ksh-operator`-plus-closure are bad patterns in zsh, and this package used to
accept them all. `(*)#` is still fine, because there the closure applies to the
group.

The fast paths are the one place where speed could cost an answer, so that is
checked rather than asserted: `test/fast-path.test.ts` answers every case in
the corpus both ways and requires the two to agree, and `noFastPath` turns them
off for anyone who would rather not have them at all. They are held to the same
corpus as everything else, and the sweep caught two cases where they were wrong — a leading `.` after a literal, and byte semantics under
`NO_MULTIBYTE`, where JavaScript's string operations disagree with zsh's units.

Speeding up approximate matching meant touching a corner that no corpus
reached: `harvested.txt` holds not one `(#a...)` case. `scripts/harvest-approx.mjs`
now generates 4,736 of them — 37 shapes against 32 subjects at every budget from
none to three — and zsh answers them. Running the same corpus with and without
the speedups above gives byte-identical results, so those are neutral; but it
surfaced 557 places where this port and zsh disagreed, all of which are now
closed. See below.

## Testing

```
npm test          # everything
npm run coverage  # with a coverage report
npm run typecheck
npm run build
```

Coverage of `src/` is over 99% of statements, with every function exercised.
What is left uncovered is defensive: `typeof process`
guards for non-Node hosts, `?? 0` fallbacks for stats that are always present
by the time a sort reads them, and a handful of unreachable `default` arms.

The corpus is not scraped from the test files — it is captured from zsh
itself. `Src/pattern.c` is temporarily patched so `patcompile()` logs every
pattern it compiles, then zsh's own test suite is run against that build:

`./zsh` is a clone of zsh's own source, and is not tracked here — it has its
own history and none of the tests need it, since the fixtures are committed
and `test/zsh-diff.test.ts` skips itself when the binary is absent. To
regenerate anything, or to run the differential tests against the real shell:

```
git clone https://git.code.sf.net/p/zsh/code zsh
npm run build:zsh   # build the zsh in ./zsh (5.9.999.3-test)
npm run patlog      # instrument, run `make check`, capture, revert
npm run fixtures    # regenerate every fixture from the capture
npm test
```

That records patterns assembled at run time from variables and command
substitution, which no amount of reading `.ztst` files can recover. From
142,005 logged compilations there are **4,085 distinct (pattern, options, kind)
tuples**, and **all 4,085 are in the corpus**. `npm run coverage:corpus`
prints that, and `scripts/absent-report.mjs` accounts for anything missing.

Getting there needed three things the zsh source supplies:

- **Bytes that are not characters.** `Src/pattern.c` defines
  `WCHAR_INVALID(ch)` as `0xDC00 + ch`, a lone surrogate — which a JavaScript
  string holds perfectly well. Patterns, subjects and results are decoded that
  way, so raw-byte cases round trip, and `[:INCOMPLETE:]` and `[:INVALID:]` are
  implemented against it.
- **A leading `~`.** Filename expansion applies only at the start of a word, so
  the sweep prefixes a sentinel to the pattern and to every subject.
- **Text that a line-based fixture cannot carry.** Patterns and globs are
  stored as indices into `patterns.json` and `globs.json`, and a result holding
  such a byte is JSON encoded and marked with a `j`.

Each case is then run under **every combination** of the options that can
change its result — chosen by reading the source, not by guessing:

| | Cases | Combinations | Assertions |
| --- | --- | --- | --- |
| Patterns × 58 subjects | 4,647 | 32 | 148,704 |
| Globs expanded in a recorded tree | 3,368 | 32 | 107,776 |
| | | | **256,480** |

Every case is swept under every combination — 4,647/4,647 and 3,368/3,368,
with all 256,480 (case, combination) pairs asserted. `npm run coverage:corpus`
reports that too, so neither number is a claim you have to take on trust.

Matching is swept over `EXTENDED_GLOB`, `KSH_GLOB`, `SH_GLOB`, `MULTIBYTE` and
`POSIX_IDENTIFIERS`; globbing over `EXTENDED_GLOB`, `KSH_GLOB`, `SH_GLOB`,
`GLOB_DOTS` and `BARE_GLOB_QUAL`. These are the options that change *which*
files match or *whether* a string matches; the rest — `MARK_DIRS`,
`LIST_TYPES`, `NUMERIC_GLOB_SORT`, `CASE_PATHS`, `CASE_GLOB`, the `NULL_GLOB`
family and `GLOB` — change presentation or error handling and have their own
tests in `test/options.test.ts`.

A pattern or glob the shell refuses is recorded as a rejection and asserted to
be refused here too. For the handful of words zsh does not glob at all, where
`${~g}` keeps the backslashes that this package resolves, what is compared is
that the word passed straight through. Most cases behave identically under most
combinations, so each is stored once per *distinct* outcome with a bitmask of
the combinations producing it.

One thing deliberately stays out of the sweep: the `[:alpha:]` family is
implemented with the operating system's own macros — `isalpha` on a byte,
`iswalpha` on a character — so zsh's answer for a non-ASCII byte follows the C
library and the locale, while this package is deterministic. Those classes are
covered against fixed, zsh-verified answers in `test/classes.test.ts` instead.

**No known divergences.** The two that stood here for a while are gone: the
approximation one needed the `exactpos`/`exactend` carry-over described above,
and the other needed a real arithmetic evaluator for qualifier subscripts,
which `src/arith.ts` now is. Nothing in the suite is skipped.

On top of the sweeps above, the corners that turned out to be hardest have
corpora of their own, all generated the same way and all at zero:

| Sweep | Cases |
| --- | --- |
| `(#a...)` approximate matching, flags in every position | 118,656 |
| Flag-group arrangements, matching and globbing | 4,928 × 2 |
| Error messages, compared byte for byte | 1,220 |
| Pattern shapes with `^` and `~` combined | 17,095 |
| Held-out approximation cases the fixes never saw | 3,060 |
| Qualifier subscripts, and arithmetic against `$(( ))` | 191 |


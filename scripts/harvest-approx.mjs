/**
 * Writes a zsh script that answers every approximate-matching case in the
 * sweep below, so `test/fixtures/approx.txt` records what zsh actually does.
 *
 *   node scripts/harvest-approx.mjs > /tmp/zg-approx.zsh
 *   ./zsh/Src/zsh -f /tmp/zg-approx.zsh > test/fixtures/approx.txt
 *
 * `(#a...)` is the one corner the harvested corpora never reached: zsh's own
 * tests use it nineteen times, all on the same handful of shapes.
 */

/** Shapes that exercise each thing the matcher does differently under `(#a)`. */
const BODIES = [
  "readme", "read", "reader", "r", "",
  "a?c", "?bc", "ab?", "??",
  "[a-c]bc", "a[b-d]c", "[^x]bc", "[[:alpha:]]bc",
  "a*c", "*bc", "ab*", "*b*", "a*b*c",
  "a#bc", "ab#c", "(ab)#c", "(a|b)c", "(ab|cd)e", "(a|b)#c", "(ab)##c",
  "<1-9>bc", "ab<0-9>",
  "a(#s)bc", "abc(#e)",
  "abc~*x*", "(ab|cd)~a*",
  "[a-c]#x", "?#x", "*x",
  "aXbXc", "abcdef", "abcdefgh",
  // Shapes added after the first sweep, when checking that the fixes
  // generalised rather than fitting the corpus they were made against.
  "hello", "he?lo", "h[a-z]llo", "hel*o", "h*l*o", "(he|wo)rld",
  "(hel)#lo", "(hel)##lo", "he#llo", "hell#o", "<10-99>x", "wor(#s)ld",
  "world(#e)", "hello~*z*", "[[:alpha:]]#lo", "?ello", "hell?", "h(#s)ello",
  "(a|bb|ccc)d", "x(y|z)#w", "pre[0-9]#post", "a??b", "(#i)HELLO",
  // Counted closures: `(#cN,M)` compiles to P_COUNT, which is neither a
  // simple closure nor a branch, and nothing else here reaches it.
  "he(#c2,3)llo", "he(#c2,2)llo", "a(#c2,2)b", "a(#c1,3)b", "(ab)(#c2,2)c",
  // A closure at the end of the pattern, and other shapes of bounded width:
  // these are what the span check in `match` decides without matching at all,
  // and they caught the run numbering being back to front.
  "ab(#c1,5)", "ab(#c1,2)", "abcdefgh", "aaaaaaaaaa", "??????",
  "[a-c][a-c]", "(ab|cdefgh)", "(a|b)(c|d)", "(#s)abc(#e)",
  // `^` and `~` together, and exclusions inside groups: the flags a `^`
  // exclusion sees depend on whether it is inside parentheses, and an
  // exclusion carries an error budget of its own.
  "^ab", "^a~b", "(^a|^b)", "(^a|^b)~c", "*~^a", "^(a|b)", "(^a)~b",
  "^(a~b)", "a~b", "ab~a*", "(ab~a)c", "^[ab]~c", "x^ab", "(^ab)",
  // A group whose branch contains a nested exclusion leaves its flags in
  // force after it, since the exclusion zeroed the compile time budget and no
  // restoring node was emitted.
  "((a~b)c)", "((a~b))", "(a~b)c", "((^a)b)", "((a~b)c)d", "(a(x~y)b)",
  // Runs of flag groups with nothing else.  A group in the middle that
  // changes something is emitted as a node, and one node is the difference
  // between an empty pure string and a pattern that can spend an error.
  "(#a1)", "(#i)(#a1)", "(#a1)(#i)", "(#a1)(#i)(#a1)", "(#a1)(#a1)(#i)(#a1)",
  "(#i)(#a1)(#i)", "(#a1)(#a1)", "(#l)(#a1)(#l)", "(#I)(#a1)(#I)",
];

const SUBJECTS = [
  "", "a", "ab", "abc", "abcd", "abd", "acb", "bc", "ac", "abx", "xbc",
  "readme", "readm", "eadme", "raedme", "readmee", "reame", "rdme", "README",
  "a1c", "a9c", "abbc", "aabc", "abcc", "aXbXc", "abcdef", "abcdefg",
  "x", "xx", "abcx", "xabc", "a-c",
  "hello", "helo", "hallo", "hlelo", "helloo", "ello", "hell", "world",
  "wrld", "worl", "hellox", "xhello", "10x", "99x", "5x", "100x",
  "prepost", "pre1post", "pre12post", "aabb", "abab", "zz", "zzzz",
  "xyw", "xyzw", "xw", "HELLO", "hEllO", "helloworld", "d", "ad", "bbd",
  "aaaaaaaaaaaa", "aaaaaaa", "aaaaa", "12", "123", "1234", "cdefgh", "aabbb",
];

const ERRORS = [0, 1, 2, 3];

/**
 * Where the flag group sits.  Everything above puts it at the front, which is
 * the one position `parsepat` treats specially and the one position that never
 * exercised `patcompbranch`'s two other cases: a group in the middle is a
 * `P_GFLAGS` node, and one at the very end emits nothing at all, being left
 * "for the next Patprog in the chain to pick up".
 */
const PLACEMENTS = [
  (flag, body) => `${flag}${body}`,
  (flag, body) => `${body}${flag}`,
  (flag, body) => (body.length > 1 ? `${body[0]}${flag}${body.slice(1)}` : `${flag}${body}`),
  (flag, body) => `${flag}${body}${flag}`,
];

const cases = [];
for (const body of BODIES) {
  for (const errors of ERRORS) {
    for (const subject of SUBJECTS) {
      for (const place of PLACEMENTS) {
        cases.push({ pattern: place(`(#a${errors})`, body), subject });
      }
    }
  }
}

const quote = (s) => `'${s.replace(/'/g, `'\\''`)}'`;

console.log(`emulate -L zsh
setopt extendedglob
patterns=(${cases.map((c) => quote(c.pattern)).join(" ")})
subjects=(${cases.map((c) => quote(c.subject)).join(" ")})
for (( i = 1; i <= $#patterns; i++ )); do
  pat=$patterns[i]
  str=$subjects[i]
  # A subshell, so that a pattern zsh rejects records an "E" rather than
  # aborting the sweep.  The placements can build one: a(#a0)#bc is a closure
  # over a flag group.
  out=$( { [[ $str = ${"${~pat}"} ]] && print -n t || print -n f } 2>&1 )
  case $out in (t|f) r=$out;; (*) r=E;; esac
  # The pattern and subject are echoed back so the reader can check that the
  # answers line up with the cases, rather than trusting the array indices.
  print -r -- "$r\t$pat\t$str"
done`.replace('${"${~pat}"}', "${~pat}"));

process.stderr.write(`${cases.length} cases\n`);

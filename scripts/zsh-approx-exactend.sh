#!/usr/bin/env bash
# Locates, in zsh's own source, what the divergences listed in
# test/fixtures/approx-divergences.txt turn on.  It does not show that zsh is
# wrong -- see the note at the end.
#
#   ./scripts/zsh-approx-exactend.sh
#
# `exactpos` and `exactend` (Src/pattern.c) carry "how far down an exact string
# we have got" between the four repairs zsh tries when a literal run fails
# under `(#a...)`.  They are file-static, and while `exactpos` is saved into a
# local and put back between attempts, `exactend` is not.  A nested attempt
# that fails on a *different* P_EXACTLY leaves `exactend` pointing into that
# other run, so the last repair -- "omit a character from the pattern" -- then
# advances `exactpos` against the wrong limit and compares against whatever
# lies between them in the compiled program.
#
# This patches zsh to save and restore `exactend` alongside `exactpos`, rebuilds,
# re-answers the corpus and reports how many disagreements are left.  It then
# reverts and rebuilds a clean zsh.
set -euo pipefail
cd "$(dirname "$0")/.."

# Reverting has to be checked by asking the binary, not by comparing the file:
# a `make` that fails late leaves a patched binary behind a pristine source,
# and every measurement after that is quietly wrong.
revert() {
  git -C zsh checkout -- Src/pattern.c 2>/dev/null || cp /tmp/zg-pattern-orig.c zsh/Src/pattern.c
  (cd zsh/Src && rm -f pattern.o zsh && make -j8 zsh >/dev/null 2>&1)
  if ./zsh/Src/zsh -f -c 'setopt extendedglob; [[ bc = (#a1)a?c ]]'; then
    echo "WARNING: zsh binary is still patched -- rebuild ./zsh before trusting any fixture" >&2
    return 1
  fi
  echo "reverted; zsh binary verified pristine"
}
trap revert EXIT
cp zsh/Src/pattern.c /tmp/zg-pattern-orig.c

python3 - <<'PY'
path = "zsh/Src/pattern.c"
src = open(path).read()
edits = [
    ("""		char *savexact = exactpos;
		save = patinput;""",
     """		char *savexact = exactpos;
		char *savexactend = exactend;
		save = patinput;"""),
    ("""		if (P_OP(scan) == P_EXACTLY) {
		    char *nextexact = savexact;""",
     """		if (P_OP(scan) == P_EXACTLY) {
		    char *nextexact;
		    exactend = savexactend;
		    nextexact = savexact;"""),
    ("""			errsfound = saverrsfound;
			exactpos = savexact;

			/*
			 * Try swapping two characters in patinput and""",
     """			errsfound = saverrsfound;
			exactpos = savexact;
			exactend = savexactend;

			/*
			 * Try swapping two characters in patinput and"""),
    ("""			errsfound = saverrsfound;
			exactpos = savexact;
		    }

		    DPUTS(exactpos == exactend,""",
     """			errsfound = saverrsfound;
			exactpos = savexact;
			exactend = savexactend;
		    }

		    DPUTS(exactpos == exactend,"""),
]
for old, new in edits:
    assert old in src, old[:40]
    src = src.replace(old, new, 1)
open(path, "w").write(src)
PY

(cd zsh && make -j8 >/dev/null)
node scripts/harvest-approx.mjs > /tmp/zg-approx-fix.zsh 2>/dev/null
./zsh/Src/zsh -f /tmp/zg-approx-fix.zsh > /tmp/zg-approx-fix.txt

node -e '
const { readFileSync } = require("node:fs");
const { match } = require("./dist/index.js");
const parse = (p) => readFileSync(p, "utf8").split("\n").filter((l) => l.length && !l.startsWith("#"))
  .map((l) => { const [r, pat, s = ""] = l.split("\t"); return { r, pat, s }; });
const shipped = parse("test/fixtures/approx.txt");
const patched = parse("/tmp/zg-approx-fix.txt");
let changed = 0, before = 0, after = 0;
for (let i = 0; i < patched.length; i++) {
  const ours = match(patched[i].s, patched[i].pat, { extendedGlob: true });
  if (shipped[i].r !== patched[i].r) changed++;
  if ((shipped[i].r === "t") !== ours) before++;
  if ((patched[i].r === "t") !== ours) after++;
}
console.log(`${patched.length} cases`);
console.log(`  zsh answers changed by restoring exactend: ${changed}`);
console.log(`  disagreements with zsh as shipped:         ${before}`);
console.log(`  disagreements with exactend restored:      ${after}`);
'

cat <<'NOTE'

Reading this
------------
`exactpos` and `exactend` say how far into a literal run zsh's four repairs
have got.  Both are file-static; `exactpos` is copied into a local and put back
between attempts, and `exactend` is not, so an attempt that fails inside a
different run leaves it pointing there.

"disagreements with zsh as shipped" should be 0: this package reproduces the
carry-over, in `matchExact` (src/matcher.ts), because it is what zsh does and
this is a port of zsh.  "disagreements with exactend restored" counts the cases
that turn on it -- take the carry-over away from zsh and the two part company
on exactly those.

That is a measurement, not a verdict.  Doc/Zsh/expn.yo describes `(#aN)`
operationally -- "the shell keeps a count of the errors found" -- never as an
edit distance, and documents where the edit-distance reading fails outright
(`(#a1)???` does not match a two character string).  The code is unchanged
since pattern.c's initial revision, and macOS's zsh 5.9 and the zsh built here
agree on every one of these cases.
NOTE

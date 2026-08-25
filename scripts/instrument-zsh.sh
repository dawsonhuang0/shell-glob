#!/usr/bin/env bash
# Builds the zsh in ./zsh with patcompile() instrumented to log every pattern
# it compiles, runs zsh's own test suite to capture them, then reverts the
# patch and rebuilds a clean binary.
#
#   ./scripts/instrument-zsh.sh   # writes /tmp/patlog.txt
#
# The log is what scripts/patlog.mjs reads, so the corpus covers every pattern
# the suite exercises -- including ones assembled at run time from variables or
# command substitution, which reading the test files cannot recover.
set -euo pipefail
cd "$(dirname "$0")/.."
ZSH_DIR=zsh
OUT=${1:-/tmp/patlog.txt}

if [ ! -f "$ZSH_DIR/configure" ]; then (cd "$ZSH_DIR" && ./Util/preconfig); fi
if [ ! -f "$ZSH_DIR/Makefile" ]; then
  (cd "$ZSH_DIR" && ./configure --disable-gdbm --disable-pcre)
fi

python3 - "$ZSH_DIR/Src/pattern.c" <<'PY'
import sys
path = sys.argv[1]
src = open(path).read()
if "ZSH_PATLOG" in src:
    sys.exit(0)
anchor = "    queue_signals();\n\n    startoff = sizeof(struct patprog);"
patch = '''    queue_signals();

    /* INSTRUMENTATION (not part of zsh): with $ZSH_PATLOG set, record every
     * pattern compiled, so a port can be tested against exactly the patterns
     * this test suite exercises.  Reverted by scripts/instrument-zsh.sh. */
    {
\tchar *patlog = getenv("ZSH_PATLOG");
\tif (patlog && *patlog) {
\t    FILE *plf = fopen(patlog, "a");
\t    if (plf) {
\t\tchar *pldup = ztrdup(exp);
\t\tint pllen;
\t\tuntokenize(pldup);
\t\tunmetafy(pldup, &pllen);
\t\tfprintf(plf, "%d\\\\t%d\\\\t%s\\\\n", inflags,
\t\t\t(int)isset(EXTENDEDGLOB), pldup);
\t\tfclose(plf);
\t\tzsfree(pldup);
\t    }
\t}
    }

    startoff = sizeof(struct patprog);'''
assert anchor in src, "could not find the patcompile anchor"
open(path, "w").write(src.replace(anchor, patch))
PY

(cd "$ZSH_DIR" && make -j8 >/dev/null)
rm -f "$OUT"
(cd "$ZSH_DIR" && ZSH_PATLOG="$OUT" make check >/dev/null 2>&1) || true
echo "captured $(wc -l < "$OUT") pattern compilations in $OUT"

# Revert the patch and rebuild a clean binary for fixture generation.
(cd "$ZSH_DIR" && git checkout -- Src/pattern.c && make -j8 >/dev/null)
echo "reverted Src/pattern.c and rebuilt a clean zsh"

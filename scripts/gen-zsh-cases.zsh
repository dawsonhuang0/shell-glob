#!/usr/bin/env zsh
# Regenerates test/fixtures/zsh-cases.txt: every "opts<TAB>string<TAB>pattern"
# case in scripts/cases.txt is evaluated by the real zsh and the exit status
# recorded, so the test suite can check this package against zsh offline.
emulate -L zsh
setopt no_nomatch
local dir=${0:a:h}
while IFS=$'\t' read -r opts str pat; do
  [[ -z $opts || $opts = '#'* ]] && continue
  (
    emulate -L zsh
    setopt extendedglob
    case $opts in
      (*k*) setopt kshglob ;;
    esac
    case $opts in
      (*K*) unsetopt extendedglob; setopt kshglob ;;
    esac
    case $opts in
      (*E*) unsetopt extendedglob ;;
    esac
    [[ $str = ${~pat} ]]
    print -r -- "$?"$'\t'"$opts"$'\t'"$str"$'\t'"$pat"
  )
done < $dir/cases.txt

#!/bin/sh
# Pure validation: no filesystem writes, downloads or source-policy changes.
set -eu
LC_ALL=C
export LC_ALL
[ "$#" -eq 2 ] || exit 78
cr=$(printf '\r')
lf='
'
# grep anchors are line-based: reject CR/LF BEFORE applying either expression.
for value in "$1" "$2"; do
  case "$value" in
    *"$cr"*|*"$lf"*) exit 78 ;;
  esac
done
printf '%s' "$1" | grep -Eq '^[-a-zA-Z0-9./:_]+@sha256:[a-f0-9]{64}$' || exit 78
printf '%s' "$2" | grep -Eq '^https://[a-zA-Z0-9.-]+(:[0-9]+)?/[a-zA-Z0-9/._-]*$' || exit 78

#!/bin/sh
# The test suite is a ratchet. Against a base ref (BASE_REF, default origin/main):
#   1. the number of test files never drops (a symlink or submodule at a *.test.ts path is
#      not a test file);
#   2. no focus, skip or todo markers are added to a JavaScript or TypeScript test file (a
#      *.test.* or *.spec.* file ending in .ts, .tsx, .js, .mjs or .cjs).
#      bin/check-test-markers.ts parses the base and head version of each changed one and
#      refuses the markers the head adds; its header holds the rules. It needs node and the
#      @babel/parser devDependency, and gate 2 fails without either.
# BASE_REF=none skips the check.

set -e

BASE="${BASE_REF:-origin/main}"
if [ "$BASE" = "none" ]; then
  echo "check-test-integrity: no base to compare with; skipped."
  exit 0
fi

if git rev-parse --verify --quiet "$BASE^{commit}" >/dev/null; then
  RESOLVED="$BASE"
elif git fetch --no-tags --quiet origin "${BASE#origin/}" 2>/dev/null; then
  RESOLVED="FETCH_HEAD"
else
  echo "check-test-integrity: cannot resolve the base ref '$BASE'." >&2
  exit 1
fi

# Gate 1 counts regular files only (mode 100xxx), so a test file turned into a symlink (120000)
# or a submodule (160000) at the same path counts as removed. core.quotePath=false lists a
# non-ASCII name as its bytes; a name git still C-quotes (a control character, " or \) ends in
# a quote, hence "?. The count reads bytes (LC_ALL=C), and each listing is captured first, so a
# failing git is an error rather than a count of 0.
TAB=$(printf '\t')
TEST_FILES='[.]test[.]ts"?$'
BASE_LIST=$(git -c core.quotePath=false ls-tree -r "$RESOLVED") || {
  echo "check-test-integrity: cannot list the files at $BASE; gate 1 cannot count." >&2
  exit 1
}
HEAD_LIST=$(git -c core.quotePath=false ls-files -s) || {
  echo "check-test-integrity: cannot list the files in the index; gate 1 cannot count." >&2
  exit 1
}

# grep -c exits 1 when it counts nothing, so only a status above 1 is a failure.
count_test_files() {
  COUNT_STATUS=0
  COUNT=$(printf '%s\n' "$1" | LC_ALL=C grep -acE "$2.*$TEST_FILES") || COUNT_STATUS=$?
  [ "$COUNT_STATUS" -le 1 ] || return 1
  printf '%s\n' "$COUNT"
}

BASE_COUNT=$(count_test_files "$BASE_LIST" "^100[0-7]{3} blob [0-9a-f]+$TAB") &&
  HEAD_COUNT=$(count_test_files "$HEAD_LIST" "^100[0-7]{3} [0-9a-f]+ 0$TAB") || {
  echo "check-test-integrity: the test-file count (grep) failed; gate 1 cannot count." >&2
  exit 1
}
if [ "$HEAD_COUNT" -lt "$BASE_COUNT" ]; then
  echo "check-test-integrity: test files dropped from $BASE_COUNT ($BASE) to $HEAD_COUNT." >&2
  exit 1
fi

# Gate 2 reads the raw list of the changed test files (`--raw -z --no-abbrev`: modes, full blob
# ids and unquoted paths, so no diff config or context line reaches the checker) through a temp
# file. Its status 0 is nothing refused, 3 is refused with the listing on its stdout, and
# anything else (1 included: node's status for an uncaught exception) means it could not judge,
# so the gate fails closed. dirname and cd are guarded one by one: in a single command
# substitution dash runs `cd -- ""` after a failing dirname and succeeds. `CDPATH=` keeps cd from
# printing the directory into the value.
DIR=$(dirname -- "$0") || {
  echo "check-test-integrity: cannot find the directory of $0; gate 2 cannot run check-test-markers.ts." >&2
  exit 1
}
SCRIPT_DIR=$(CDPATH='' cd -- "$DIR" && pwd) || {
  echo "check-test-integrity: cannot find the directory of $0; gate 2 cannot run check-test-markers.ts." >&2
  exit 1
}
if ! command -v node >/dev/null 2>&1; then
  echo "check-test-integrity: node is not on PATH; gate 2 cannot judge the test files." >&2
  exit 1
fi
LIST=$(mktemp) || {
  echo "check-test-integrity: mktemp failed; gate 2 cannot hand the diff list to check-test-markers.ts." >&2
  exit 1
}
trap 'rm -f "$LIST"' EXIT
trap 'exit 1' HUP INT TERM

# Gitattributes, an external diff and textconv drivers must not change what the checker sees. The
# pathspec variables would make the patterns match nothing, or only files at the top level, or
# also files whose name matches only ignoring case.
(
  unset GIT_LITERAL_PATHSPECS GIT_GLOB_PATHSPECS GIT_NOGLOB_PATHSPECS GIT_ICASE_PATHSPECS
  git diff --no-color --no-ext-diff --no-textconv --text --find-renames --no-relative \
    --raw -z --no-abbrev "$RESOLVED" HEAD -- \
    ':/*.spec.ts' ':/*.test.ts' ':/*.spec.tsx' ':/*.test.tsx' ':/*.spec.js' ':/*.test.js' \
    ':/*.spec.mjs' ':/*.test.mjs' ':/*.spec.cjs' ':/*.test.cjs'
) >"$LIST" || {
  echo "check-test-integrity: git diff against $BASE failed; gate 2 cannot see the diff." >&2
  exit 1
}

JS_STATUS=0
JS_LINES=$(node "$SCRIPT_DIR/check-test-markers.ts" "$LIST") || JS_STATUS=$?
case $JS_STATUS in
  0) ;;
  3)
    {
      echo "check-test-integrity: focus, skip or todo markers added:"
      printf '%s\n' "$JS_LINES"
      echo "check-test-integrity: allowed: { skip: !process.env.X } or another condition as a test's option, test(\"x\", { skip: cond }, fn); test.todo(\"name\") with no body; and an empty env-gated placeholder test with a skip option, test(\"... (set X to run)\", { skip: true }, () => {})."
      echo "check-test-integrity: each marker is listed as <file>:<line>: with the statement that holds it; the rules are in the header of bin/check-test-markers.ts."
    } >&2
    exit 1
    ;;
  *)
    {
      [ -z "$JS_LINES" ] || printf '%s\n' "$JS_LINES"
      echo "check-test-integrity: check-test-markers.ts exited $JS_STATUS; gate 2 cannot judge."
    } >&2
    exit 1
    ;;
esac

echo "check-test-integrity: OK"

#!/bin/sh
# The test suite is a ratchet. Against a base ref (BASE_REF, default origin/main):
#   1. the number of test files never drops;
#   2. no focus or unconditional skip markers are added.
# A conditional skip such as `it.skip(onCI, ...)` is allowed.
# BASE_REF=none skips the check (CI uses it for the first push of a branch).

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

TEST_FILES='[.]test[.]ts$'
BASE_COUNT=$(git ls-tree -r --name-only "$RESOLVED" | grep -Ec "$TEST_FILES" || true)
HEAD_COUNT=$(git ls-files | grep -Ec "$TEST_FILES" || true)
if [ "$HEAD_COUNT" -lt "$BASE_COUNT" ]; then
  echo "check-test-integrity: test files dropped from $BASE_COUNT ($BASE) to $HEAD_COUNT." >&2
  exit 1
fi

# Bracket classes instead of escapes keep the patterns portable across greps.
ADDED=$(git diff "$RESOLVED" HEAD -- '*.test.ts' | grep '^+' | grep -v '^+++' || true)
MARKERS='[.]only[(]|\bxdescribe[(]|\bfdescribe[(]|\bxit[(]|\bfit[(]|describe[.]skip[(]'
SKIP_LITERAL=$(printf '(it|test)[.]skip[(][[:space:]]*[\047\042\140]')
BAD=$(printf '%s\n' "$ADDED" | grep -nE "$MARKERS|$SKIP_LITERAL" || true)
if [ -n "$BAD" ]; then
  echo "check-test-integrity: focus or skip markers added:" >&2
  printf '%s\n' "$BAD" >&2
  exit 1
fi

echo "check-test-integrity: OK"

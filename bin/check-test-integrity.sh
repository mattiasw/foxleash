#!/bin/sh
# The test suite is a ratchet. Against a base ref (BASE_REF, default origin/main):
#   1. the number of test files never drops;
#   2. no focus or skip markers are added: .only and .fixme on any receiver, the x- and
#      f-prefixed forms, .each-style chains on them, and every .skip( on a receiver chain rooted
#      at test, describe, it, suite, context, specify or concurrent. A member access may have
#      whitespace before its dot or be optional (?.), and a call split over lines before a dot
#      or a parenthesis is joined first. node:test's conditional skip is the
#      `{ skip: !process.env.X }` option; t.skip() in a test body is not matched.
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

if ! printf 'fit(\n' | grep -qE '\bfit[(]' 2>/dev/null; then
  printf '%s\n' 'check-test-integrity: this grep does not read \b as a word boundary, so gate 2 would pass silently. Use GNU grep.' >&2
  exit 1
fi

# The join pass reads context lines, so their number is pinned; GIT_DIFF_OPTS overrides even
# --unified. The '>' indicator keeps an added line starting with '++' apart from the '+++' header.
DIFF_OUT=$(unset GIT_DIFF_OPTS; git diff --no-color --unified=3 --output-indicator-new='>' "$RESOLVED" HEAD -- '*.test.ts') || {
  echo "check-test-integrity: git diff against $BASE failed; gate 2 cannot see the diff." >&2
  exit 1
}

# Joins a call split over lines back into one line. Context lines above a run of added lines
# are merged by the same rule, so an edit under an unchanged receiver line is seen whole.
JOINED=$(printf '%s\n' "$DIFF_OUT" | LC_ALL=C awk '
  # Trailing whitespace and a trailing comment holding no quote are not part of the chain.
  function chainend(s) {
    sub(/[[:space:]]+$/, "", s)
    if (match(s, "//[^\"\047`]*$")) s = substr(s, 1, RSTART - 1)
    sub(/[[:space:]]+$/, "", s)
    return s
  }
  function joins(prev, more) {
    return (prev ~ /[A-Za-z0-9_$]$/ && more ~ /^([.]|[?][.]|[(]|`)/) ||
      (prev ~ /[)]$/ && more ~ /^[?]?[.]/)
  }
  function flush(   i, m, more, prev, head) {
    m = 0
    head = -1
    for (i = 0; i < n; i++) {
      more = added[i]
      sub(/^[[:space:]]+/, "", more)
      if (more ~ /^\/\//) { merged[m++] = added[i]; continue }
      prev = chainend(head >= 0 ? merged[head] : ctx)
      if (joins(prev, more)) {
        if (head < 0) { head = m; m++ }
        merged[head] = prev more
        continue
      }
      merged[m] = added[i]
      head = m
      m++
    }
    for (i = 0; i < m; i++) print merged[i]
    if (head >= 0) ctx = merged[head]
    n = 0
  }
  BEGIN { n = 0; ctx = "" }
  /^>/ { added[n++] = substr($0, 2); next }
  /^ / {
    flush()
    cline = substr($0, 2)
    cmore = cline
    sub(/^[[:space:]]+/, "", cmore)
    if (cmore ~ /^\/\//) next
    cprev = chainend(ctx)
    ctx = joins(cprev, cmore) ? cprev cmore : cline
    next
  }
  # A removed line and the no-newline marker end a run but keep the context.
  /^-/ { flush(); next }
  /^\\/ { flush(); next }
  # Headers and the bare empty line of diff.suppressBlankEmpty also clear it.
  { flush(); ctx = "" }
  END { flush() }
') || {
  echo "check-test-integrity: the added-line scanner (awk) failed; gate 2 cannot see the diff." >&2
  exit 1
}

# .only and .fixme are refused on any receiver; .skip only on a chain rooted at a test root, so
# a test body's t.skip("reason") passes. Whitespace may come before a dot, never after it, so
# prose such as "i.e. only (a, b)" is not a member access.
DOT='[[:space:]]*[?]?[.]'
IDENT='[A-Za-z_$][A-Za-z0-9_$]*'
ROOTS='test|describe|it|suite|context|specify|concurrent'
LINK="${DOT}${IDENT}"
MARKERS='fit|xit|xtest|xcontext|xspecify|fdescribe|xdescribe'
RECEIVER_SKIP="(${ROOTS})(${LINK})*${DOT}skip"
# The backtick must stay inside single quotes, or sh runs it as a command.
SKIP_PATTERN='(\b('"$MARKERS|$RECEIVER_SKIP"')|'"$DOT"'(only|fixme))([[:space:]]*[(]|('"$DOT"'[A-Za-z_]+)+[[:space:]]*[(`])'

# -a: a line holding a byte that is not valid UTF-8 is still matched as text.
MARKER_STATUS=0
BAD=$(printf '%s\n' "$JOINED" | grep -aE "$SKIP_PATTERN") || MARKER_STATUS=$?
if [ "$MARKER_STATUS" -gt 1 ]; then
  echo "check-test-integrity: the marker grep failed (exit $MARKER_STATUS); gate 2 cannot judge." >&2
  exit 1
fi
if [ -n "$BAD" ]; then
  echo "check-test-integrity: focus or skip markers added:" >&2
  printf '%s\n' "$BAD" >&2
  exit 1
fi

echo "check-test-integrity: OK"

#!/bin/sh
# The test suite is a ratchet. Against a base ref (BASE_REF, default origin/main):
#   1. the number of test files never drops;
#   2. no focus or skip markers are added: .only and .fixme on any receiver, the x- and
#      f-prefixed forms, .each-style chains on them, every .skip( on a receiver chain rooted
#      at test, describe, it, suite, context, specify or concurrent, and a bare .skip() on any
#      receiver. node:test's option-object spelling is refused too: an unconditional `skip:` or
#      `only:` option on a test. A member access may have whitespace before its dot or be
#      optional (?.), and a call split over lines before a dot or a parenthesis is joined first.
#      Allowed: the conditional `{ skip: !process.env.X }` option, t.skip("reason") in a test
#      body, and an empty env-gated placeholder test on one line (a skip option followed by an
#      empty body that closes the call).
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

# The option-object patterns. A key may be quoted or have whitespace before its colon, but it
# must start the line or follow {, , or a block comment's */, so prose such as "desktop only: 2
# per row" is not a key. VALUE is true, null, NaN or a string: node:test skips on any value but
# undefined and false. CALL_VALUE, a number or a negated or parenthesised literal, is refused
# only in an options object that is the second argument of a test call on the same line, because
# skip is also a pagination key. ONLY_OPTION goes to the marker grep, so no placeholder exempts a
# focus. PLACEHOLDER matches a skipped EMPTY test, registered inside an if (!process.env.X)
# branch: the options object ends at the first } outside a quoted value and is followed directly
# by an empty () => {}) or async () => {}) body that closes the call.
# The quote characters are written as printf octal (\047 ' \042 " \140 `) so they survive sh
# quoting; a complement built from $Q, '[^'"$Q"']', would be a class followed by a literal ].
# QS is a quoted string, closed by the quote that opened it, so "don't" is one string. NBQ also
# excludes }, so the placeholder check steps over a quoted value; ARG also excludes what ends a
# test call's first argument outside a string.
Q=$(printf '[\047\042\140]')
QS=$(printf '(\042[^\042]*\042|\047[^\047]*\047|\140[^\140]*\140)')
NBQ=$(printf '[^}\047\042\140]')
ARG=$(printf '[^,{}()\047\042\140]')
# A value that is never a condition: a keyword literal, a number or a string.
LITERAL='((true|false|null|undefined|NaN|Infinity)\b|[0-9]|'"$Q"')'
BARE_SKIP="${DOT}skip[[:space:]]*[(][[:space:]]*[)]"
KEY="(^|[{,]|[*]/)[[:space:]]*${Q}?"
VALUE="${Q}?[[:space:]]*:[[:space:]]*((true|null|NaN)\b|${Q})"
CALL_KEY="\b(test|it|describe|suite|context|specify)[[:space:]]*[(](${ARG}|${QS})*,[[:space:]]*[{]([^}]*,)?[[:space:]]*${Q}?"
CALL_VALUE="${Q}?[[:space:]]*:[[:space:]]*([0-9]|[!(][[:space:]!(]*${LITERAL})"
SKIP_OPTION="${KEY}skip${VALUE}|${CALL_KEY}skip${CALL_VALUE}"
ONLY_OPTION="${KEY}only${VALUE}|${CALL_KEY}only${CALL_VALUE}"
PLACEHOLDER="${KEY}skip${Q}?[[:space:]]*:(${NBQ}|${QS})*[}][[:space:]]*,[[:space:]]*(async[[:space:]]+)?[(][[:space:]]*[)][[:space:]]*=>[[:space:]]*[{][[:space:]]*[}][[:space:]]*[)]"

# -a: a line holding a byte that is not valid UTF-8 is still matched as text.
MARKER_STATUS=0
BAD=$(printf '%s\n' "$JOINED" | grep -aE "$SKIP_PATTERN|$BARE_SKIP|$ONLY_OPTION") || MARKER_STATUS=$?
if [ "$MARKER_STATUS" -gt 1 ]; then
  echo "check-test-integrity: the marker grep failed (exit $MARKER_STATUS); gate 2 cannot judge." >&2
  exit 1
fi

OPTION_STATUS=0
OPTION_LINES=$(printf '%s\n' "$JOINED" | grep -aE "$SKIP_OPTION") || OPTION_STATUS=$?
if [ "$OPTION_STATUS" -gt 1 ]; then
  echo "check-test-integrity: the option-object grep failed (exit $OPTION_STATUS); gate 2 cannot judge." >&2
  exit 1
fi

BAD_OPTION=""
if [ -n "$OPTION_LINES" ]; then
  PLACEHOLDER_STATUS=0
  BAD_OPTION=$(printf '%s\n' "$OPTION_LINES" | grep -avE "$PLACEHOLDER") || PLACEHOLDER_STATUS=$?
  if [ "$PLACEHOLDER_STATUS" -gt 1 ]; then
    echo "check-test-integrity: the placeholder grep failed (exit $PLACEHOLDER_STATUS); gate 2 cannot judge." >&2
    exit 1
  fi
fi

if [ -n "$BAD" ] || [ -n "$BAD_OPTION" ]; then
  echo "check-test-integrity: focus or skip markers added:" >&2
  [ -z "$BAD" ] || printf '%s\n' "$BAD" >&2
  [ -z "$BAD_OPTION" ] || printf '%s\n' "$BAD_OPTION" >&2
  echo "check-test-integrity: allowed: { skip: !process.env.X }, t.skip(\"reason\"), an empty env-gated placeholder test on one line." >&2
  exit 1
fi

echo "check-test-integrity: OK"

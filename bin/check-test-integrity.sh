#!/bin/sh
# The test suite is a ratchet. Against a base ref (BASE_REF, default origin/main):
#   1. the number of test files never drops (a symlink or submodule at a *.test.ts path is
#      not a test file);
#   2. no focus, skip or todo markers are added: .only and .fixme on any receiver, the x- and
#      f-prefixed forms, .each-style chains on them, every .skip( on a receiver chain rooted
#      at test, describe, it, suite, context, specify or concurrent, and a bare .skip() on any
#      receiver. node:test runs a todo's body but never fails on it, so a bare .todo() on any
#      receiver is refused, as is a .todo on a test-root chain unless it is called with one
#      quoted name that holds no backslash and closes on the line. node:test's option-object
#      spelling is refused too: an unconditional `skip:`, `only:` or `todo:` option on a test.
#      A member access may have whitespace before its dot or be optional (?.), a marker's call
#      may be optional too (?.()), and a call split over lines before a dot or a parenthesis is
#      joined first, across blank lines and comments closed on their line.
#      Allowed: the conditional `{ skip: !process.env.X }` and `{ todo: !process.env.X }`
#      options, t.skip("reason") and t.todo("reason") in a test body, a bodiless
#      test.todo("name"), and an empty env-gated placeholder test on one line (a skip option
#      followed by an empty body that closes the call).
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

if ! printf 'fit(\n' | grep -qE '\bfit[(]' 2>/dev/null; then
  printf '%s\n' 'check-test-integrity: this grep does not read \b as a word boundary, so gate 2 would pass silently. Use GNU grep.' >&2
  exit 1
fi

# The join pass reads context lines, so their number is pinned; GIT_DIFF_OPTS overrides even
# --unified. The '>' indicator keeps an added line starting with '++' apart from the '+++' header.
# Gitattributes, binary detection, an external diff and textconv drivers must not change what the
# scan sees, so the diff is always plain text of the real file contents. The pathspec variables
# would make '*.test.ts' match nothing, or only files at the top level, or also files whose name
# matches only ignoring case.
DIFF_OUT=$(unset GIT_DIFF_OPTS GIT_LITERAL_PATHSPECS GIT_GLOB_PATHSPECS GIT_NOGLOB_PATHSPECS GIT_ICASE_PATHSPECS; git diff --no-color --text --no-ext-diff --no-textconv --unified=3 --output-indicator-new='>' "$RESOLVED" HEAD -- '*.test.ts') || {
  echo "check-test-integrity: git diff against $BASE failed; gate 2 cannot see the diff." >&2
  exit 1
}

# Joins a call split over lines back into one line. Context lines above a run of added lines
# are merged by the same rule, so an edit under an unchanged receiver line is seen whole. Context
# lines below an added line are joined onto it and printed too, so an edit above an unchanged
# .skip( line is seen whole as far as the diff's context lines reach. Blank lines and comments
# closed on their line do not break a chain. The join runs twice and both outputs are scanned:
# codeend reads strings but not regex literals, so a quote in a regex can make it misread the
# rest of the line. With plain=1 the join reads no strings: chainend cuts only a trailing //
# comment holding no quote, and only blank and // lines are stepped over.
JOIN='
  # A blank line or one holding only comments.
  function nocode(s) {
    return plain ? (s == "" || s ~ /^\/\//) : codeend(s) == 0
  }
  # Trailing whitespace and trailing comments are not part of the chain.
  function chainend(s) {
    if (!plain) return substr(s, 1, codeend(s))
    sub(/[[:space:]]+$/, "", s)
    if (match(s, "//[^\"\047`]*$")) s = substr(s, 1, RSTART - 1)
    sub(/[[:space:]]+$/, "", s)
    return s
  }
  # The index of the last character of s that is neither whitespace nor in a // or closed /* */
  # comment outside a string, 0 when there is none. Regex literals and ${...} in template
  # literals are not tracked; a line ending inside a string falls back to cutting a trailing //
  # comment that holds no quote.
  function codeend(s,   n, i, c, q, blk, last, blast) {
    n = length(s)
    q = ""
    blk = 0
    last = 0
    for (i = 1; i <= n; i++) {
      c = substr(s, i, 1)
      if (blk) {
        if (c == "*" && substr(s, i + 1, 1) == "/") { blk = 0; i++ }
        else if (c !~ /[[:space:]]/) blast = i
      } else if (q != "") {
        if (c !~ /[[:space:]]/) last = i
        if (c == "\\") {
          i++
          if (i <= n && substr(s, i, 1) !~ /[[:space:]]/) last = i
        } else if (c == q) q = ""
      } else if (c == "/" && substr(s, i + 1, 1) == "/") {
        break
      } else if (c == "/" && substr(s, i + 1, 1) == "*") {
        blk = 1
        i++
        blast = i
      } else {
        if (c == "\"" || c == "\047" || c == "`") q = c
        if (c !~ /[[:space:]]/) last = i
      }
    }
    if (blk) last = blast
    else if (q != "" && match(s, "//[^\"\047`]*$")) {
      last = RSTART - 1
      while (last > 0 && substr(s, last, 1) ~ /[[:space:]]/) last--
    }
    return last
  }
  function joins(prev, more) {
    return (prev ~ /[A-Za-z0-9_$]$/ && more ~ /^([.]|[?][.]|[(]|`)/) ||
      (prev ~ /[)]$/ && more ~ /^[?]?[.]/) ||
      (prev ~ /[?][.]$/ && more ~ /^[(]/)
  }
  function flush(   i, m, more, prev, head) {
    m = 0
    head = -1
    for (i = 0; i < n; i++) {
      more = added[i]
      sub(/^[[:space:]]+/, "", more)
      if (nocode(more)) { merged[m++] = added[i]; continue }
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
    # hot: ctx ends in an added line, so context lines that join it are printed.
    if (head >= 0) { ctx = merged[head]; hot = 1 }
    n = 0
  }
  BEGIN { n = 0; ctx = "" }
  # JavaScript whitespace outside ASCII becomes a space: U+00A0, U+1680, U+2000 to U+200A,
  # U+2028, U+2029, U+202F, U+205F, U+3000 and U+FEFF, as UTF-8 bytes.
  { gsub(/\302\240|\341\232\200|\342\200[\200-\212\250\251\257]|\342\201\237|\343\200\200|\357\273\277/, " ") }
  /^>/ { added[n++] = substr($0, 2); next }
  # The bare empty line of diff.suppressBlankEmpty is a blank context line.
  /^( |$)/ {
    flush()
    cline = substr($0, 2)
    cmore = cline
    sub(/^[[:space:]]+/, "", cmore)
    if (nocode(cmore)) next
    cprev = chainend(ctx)
    if (joins(cprev, cmore)) {
      ctx = cprev cmore
      if (hot) print ctx
    } else {
      ctx = cline
      hot = 0
    }
    next
  }
  # A removed line and the no-newline marker end a run but keep the context.
  /^-/ { flush(); next }
  /^\\/ { flush(); next }
  # Headers clear the context.
  { flush(); ctx = "" }
  END { flush() }
'
JOINED=$(printf '%s\n' "$DIFF_OUT" | LC_ALL=C awk -v plain=1 "$JOIN" &&
  printf '%s\n' "$DIFF_OUT" | LC_ALL=C awk -v plain=0 "$JOIN") &&
  JOINED=$(printf '%s\n' "$JOINED" | LC_ALL=C awk '!seen[$0]++') || {
  echo "check-test-integrity: the added-line scanner (awk) failed; gate 2 cannot see the diff." >&2
  exit 1
}

# .only and .fixme are refused on any receiver; .skip only on a chain rooted at a test root, so
# a test body's t.skip("reason") passes. Whitespace may come before a dot, never after it, so
# prose such as "i.e. only (a, b)" is not a member access.
DOT='[[:space:]]*[?]?[.]'
CALL='[[:space:]]*([?][.][[:space:]]*)?[(]'
IDENT='[A-Za-z_$][A-Za-z0-9_$]*'
ROOTS='test|describe|it|suite|context|specify|concurrent'
LINK="${DOT}${IDENT}"
MARKERS='fit|xit|xtest|xcontext|xspecify|fdescribe|xdescribe'
RECEIVER_SKIP="(${ROOTS})(${LINK})*${DOT}skip"
RECEIVER_TODO="(${ROOTS})(${LINK})*${DOT}todo"
# The backtick must stay inside single quotes, or sh runs it as a command.
SKIP_PATTERN='(\b('"$MARKERS|$RECEIVER_SKIP"')|'"$DOT"'(only|fixme))('"$CALL"'|('"$DOT"'[A-Za-z_]+)+('"$CALL"'|[[:space:]]*`))'

# The option-object patterns. A key may be quoted or have whitespace before its colon, but it
# must start the line or follow {, , or a block comment's */, so prose such as "desktop only: 2
# per row" is not a key. VALUE is true, null, NaN or a string: node:test skips on any value but
# undefined and false. CALL_VALUE, a number (which may start with a sign or .), Infinity, or a
# literal after a run of signs, ~, ! and ( (-1, .5, -true, ~0, !void 0, (true)), is refused only
# in an options object that is the first or second argument of a test call on the same line,
# because skip is also a pagination key. ONLY_OPTION and TODO_OPTION go to the marker grep, so no
# placeholder exempts a focus or a todo. todo is no pagination key, so TODO_OPTION refuses a
# CALL_VALUE after any key; the price is that a todo: key holding a literal in plain test data,
# at the start of a line or after {, , or */, is refused too. That is what catches a todo option
# in an options object over several lines. PLACEHOLDER matches a skipped EMPTY test, registered
# inside an if (!process.env.X) branch: the options object holds no nested object, ends at the
# first } outside a quoted value and is followed directly by an empty () => {}) or
# async () => {}) body that closes the call. Each placeholder is replaced with } before the
# skip-option grep, so it exempts only itself, not another skip option on its joined line, and
# no key match runs across it. PLACEHOLDER must hold no #, the sed delimiter.
# The quote characters are written as printf octal (\047 ' \042 " \140 `) so they survive sh
# quoting; a complement built from $Q, '[^'"$Q"']', would be a class followed by a literal ].
# QS is a quoted string, closed by the quote that opened it, so "don't" is one string. The
# placeholder steps over quoted values with ESC_QS, which also reads backslash escapes, and over
# block comments; NBQ excludes quotes, braces and /, so it steps over no nested object, regex or
# line comment. ARG excludes what ends a test call's first argument outside a string, and
# its strings are read with ESC_QS, so an escaped quote in a test name does not end one.
Q=$(printf '[\047\042\140]')
QS=$(printf '(\042[^\042]*\042|\047[^\047]*\047|\140[^\140]*\140)')
ESC_QS=$(printf '(\042([^\042\\\\]|\\\\.)*\042|\047([^\047\\\\]|\\\\.)*\047|\140([^\140\\\\]|\\\\.)*\140)')
COMMENT='/[*]([^*]|[*]+[^*/])*[*]+/'
NBQ=$(printf '[^{}/\047\042\140]')
ARG=$(printf '[^,{}()\047\042\140]')
# The void keyword only when the byte after it cannot continue an identifier: \b would not do,
# since $ continues an identifier (void$x and voidable are names).
VOID_KEYWORD='void[^A-Za-z0-9_$]'
# A value that is never a condition: a keyword literal, the void keyword, a number (which may
# start with .) or a string.
LITERAL='((true|false|null|undefined|NaN|Infinity)\b|'"$VOID_KEYWORD"'|[.]?[0-9]|'"$Q"')'
BARE_SKIP="${DOT}skip${CALL}[[:space:]]*[)]"
KEY="(^|[{,]|[*]/)[[:space:]]*${Q}?"
VALUE="${Q}?[[:space:]]*:[[:space:]]*((true|null|NaN)\b|${Q})"
CALL_KEY="\b(test|it|describe|suite|context|specify)${CALL}((${ARG}|${ESC_QS})*,)?[[:space:]]*[{]([^}]*,)?[[:space:]]*${Q}?"
CALL_VALUE="${Q}?[[:space:]]*:[[:space:]]*([.]?[0-9]|Infinity\b|[-+~!(][-+~[:space:]!(]*${LITERAL})"
SKIP_OPTION="${KEY}skip${VALUE}|${CALL_KEY}skip${CALL_VALUE}"
ONLY_OPTION="${KEY}only${VALUE}|${CALL_KEY}only${CALL_VALUE}"
TODO_OPTION="${KEY}todo(${VALUE}|${CALL_VALUE})"
BARE_TODO="${DOT}todo${CALL}[[:space:]]*[)]"
# A todo may hold only one quoted name, closed on its line. ERE has no lookahead, so the refused
# shapes are spelled out: arguments that do not close on the line, a first argument that is not
# a quoted string (NOT_NAME), a name that holds a backslash, a ${ that holds more than an
# identifier or member path, or does not close on its line (OPEN_NAME, since QS ends at the
# first matching quote), and a quoted name followed by anything but ). TODO_CHAIN refuses a
# chain after .todo, as SKIP_PATTERN does after .skip. A name long enough that the formatter
# breaks the call is refused too: shorten it.
NOT_NAME=$(printf '[^\047\042\140[:space:])]')
OPEN_NAME=$(printf '((\042[^\042]*|\047[^\047]*|\140[^\140]*)(\\\\|$)|\140[^\140]*[$][{][A-Za-z0-9_$.[:space:]]*[^A-Za-z0-9_$.[:space:]}])')
TODO_CALL="\b${RECEIVER_TODO}${CALL}([[:space:]]*\$|[[:space:]]*${NOT_NAME}|[[:space:]]*${OPEN_NAME}|[[:space:]]*${QS}[[:space:]]*(\$|[^[:space:])]))"
TODO_CHAIN='\b'"$RECEIVER_TODO"'('"$DOT"'[A-Za-z_]+)+('"$CALL"'|[[:space:]]*`)'
PLACEHOLDER="${KEY}skip${Q}?[[:space:]]*:(${NBQ}|${ESC_QS}|${COMMENT})*[}][[:space:]]*,[[:space:]]*(async[[:space:]]+)?[(][[:space:]]*[)][[:space:]]*=>[[:space:]]*[{][[:space:]]*[}][[:space:]]*[)]"

# -a stops grep treating a line with a byte that is not valid UTF-8 as binary; LC_ALL=C lets
# that byte match a bracket expression, which a UTF-8 locale never does. [[:space:]] is then
# ASCII only, so the join pass has turned the other JavaScript whitespace into spaces.
MARKER_STATUS=0
BAD=$(printf '%s\n' "$JOINED" | LC_ALL=C grep -aE "$SKIP_PATTERN|$BARE_SKIP|$ONLY_OPTION|$TODO_CALL|$TODO_CHAIN|$BARE_TODO|$TODO_OPTION") || MARKER_STATUS=$?
if [ "$MARKER_STATUS" -gt 1 ]; then
  echo "check-test-integrity: the marker grep failed (exit $MARKER_STATUS); gate 2 cannot judge." >&2
  exit 1
fi

STRIP_STATUS=0
STRIPPED=$(printf '%s\n' "$JOINED" | LC_ALL=C sed -E "s#$PLACEHOLDER#}#g") || STRIP_STATUS=$?
if [ "$STRIP_STATUS" -ne 0 ]; then
  echo "check-test-integrity: the placeholder strip (sed) failed (exit $STRIP_STATUS); gate 2 cannot judge." >&2
  exit 1
fi

OPTION_STATUS=0
BAD_OPTION=$(printf '%s\n' "$STRIPPED" | LC_ALL=C grep -aE "$SKIP_OPTION") || OPTION_STATUS=$?
if [ "$OPTION_STATUS" -gt 1 ]; then
  echo "check-test-integrity: the option-object grep failed (exit $OPTION_STATUS); gate 2 cannot judge." >&2
  exit 1
fi

if [ -n "$BAD" ] || [ -n "$BAD_OPTION" ]; then
  echo "check-test-integrity: focus, skip or todo markers added:" >&2
  [ -z "$BAD" ] || printf '%s\n' "$BAD" >&2
  [ -z "$BAD_OPTION" ] || printf '%s\n' "$BAD_OPTION" >&2
  echo "check-test-integrity: allowed: { skip: !process.env.X }, t.skip(\"reason\"), test.todo(\"name\") on one line with no body, an empty env-gated placeholder test on one line." >&2
  exit 1
fi

echo "check-test-integrity: OK"

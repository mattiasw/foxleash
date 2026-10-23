#!/bin/sh
# The test suite is a ratchet. Against a base ref (BASE_REF, default origin/main):
#   1. the number of test files never drops (a symlink or submodule at a *.test.ts path is
#      not a test file);
#   2. no focus, skip or todo markers are added: .only and .fixme on any receiver, the x- and
#      f-prefixed forms, .each-style chains on them, every .skip( on a receiver chain rooted
#      at test, describe, it, suite, context, specify or concurrent, and a bare .skip() on any
#      receiver. node:test runs a todo's body but never fails on it, so a bare .todo() on any
#      receiver is refused, as is a .todo on a test-root chain unless it is called with one
#      quoted name that holds no backslash and closes on the line. node:test's expected
#      failure exits 0 too, so .expectFailure( on any receiver and a bare expectFailure( are
#      refused. node:test's option-object spelling is refused too: an unconditional `skip:`,
#      `only:`, `todo:` or `expectFailure:` option on a test, a function or an array or object
#      literal as its value, and a method-shorthand key (`{ todo() {} }`). A member access may
#      have whitespace before its dot or be optional (?.), a marker's call may be optional too
#      (?.()) and carry TypeScript type arguments (`test.only<T>(`), and a call split over
#      lines before a dot or a parenthesis is joined first, across blank lines and comments,
#      block comments over several lines included. Each line is also read as the engine reads
#      its names: through a computed literal key (`test["only"](`), an escaped name
#      (`test.\u006fnly(`) and a block comment inside the line (`test./* x */only(`).
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
# closed on their line do not break a chain. The join runs four times and every output is
# scanned: codeend reads strings but not regex literals, so a quote in a regex can make it
# misread the rest of the line. With plain=1 and carry=0 the join reads no strings: chainend
# cuts only a trailing // comment holding no quote, and only blank and // lines are stepped
# over. With carry=1 a block comment's state is carried from one line of the new file to the
# next: lines inside it are stepped over and a link starts after the comments before it. The
# carry=0 runs stay because a /* in a regex literal, or with plain=1 in a string, opens a
# comment that is not one and would hide the lines below it.
JOIN='
  # A blank line or one holding only comments; st is the comment state at its start.
  function nocode(s, st) {
    return plain && !carry ? (s == "" || s ~ /^\/\//) : codeend(s, st) == 0
  }
  # Trailing whitespace and trailing comments are not part of the chain.
  function chainend(s, st) {
    if (!plain || carry) return substr(s, 1, codeend(s, st))
    sub(/[[:space:]]+$/, "", s)
    if (match(s, "//[^\"\047`]*$")) s = substr(s, 1, RSTART - 1)
    sub(/[[:space:]]+$/, "", s)
    return s
  }
  # The index of the last character of s that is neither whitespace nor in a // or closed /* */
  # comment outside a string, 0 when there is none. Regex literals and ${...} in template
  # literals are not tracked; a line ending inside a string falls back to cutting a trailing //
  # comment that holds no quote. st is 1 when s starts inside a block comment. A comment left
  # open ends the code at its last byte that is not whitespace, or with carry set before it. Sets
  # cend to 1 when s ends inside a block comment and cfirst to the index of its first byte of
  # code, 0 when there is none. With plain set it reads no strings, so it reads a /* right after
  # code ("suite/*") that does not close on its line as code: it may be in a string, and the
  # string text before it could join the next link.
  function codeend(s, st,   n, i, c, q, blk, last, blast) {
    n = length(s)
    q = ""
    blk = st
    last = 0
    cfirst = 0
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
      } else if (c == "/" && substr(s, i + 1, 1) == "*" && !(plain && last && last == i - 1 &&
        !index(substr(s, i + 2), "*/"))) {
        blk = 1
        i++
        blast = i
      } else {
        if (!plain && (c == "\"" || c == "\047" || c == "`")) q = c
        if (c !~ /[[:space:]]/) { last = i; if (!cfirst) cfirst = i }
      }
    }
    if (blk) { if (!carry) last = blast }
    else if (q != "" && match(s, "//[^\"\047`]*$")) {
      last = RSTART - 1
      while (last > 0 && substr(s, last, 1) ~ /[[:space:]]/) last--
    }
    cend = blk
    return last
  }
  # s from its first byte of code; with carry set, the comments before it are dropped.
  function linkstart(s, st) {
    if (carry) { codeend(s, st); s = substr(s, cfirst) }
    sub(/^[[:space:]]+/, "", s)
    return s
  }
  function joins(prev, more) {
    return (prev ~ /[A-Za-z0-9_$]$/ && more ~ /^([.]|[?][.]|[(]|`)/) ||
      (prev ~ /[)]$/ && more ~ /^[?]?[.]/) ||
      (prev ~ /[?][.]$/ && more ~ /^[(]/)
  }
  # cmt: the new file is inside a block comment at the start of its next line. cs and hs: the
  # state at the start of ctx and of merged[head].
  function flush(   i, m, more, prev, head, st) {
    m = 0
    head = -1
    for (i = 0; i < n; i++) {
      st = cmt
      if (carry) { codeend(added[i], st); cmt = cend }
      more = added[i]
      sub(/^[[:space:]]+/, "", more)
      if (nocode(more, st)) { merged[m++] = added[i]; continue }
      prev = chainend(head >= 0 ? merged[head] : ctx, head >= 0 ? hs : cs)
      more = linkstart(more, st)
      if (joins(prev, more)) {
        if (head < 0) { head = m; m++; hs = cs }
        merged[head] = prev more
        continue
      }
      merged[m] = added[i]
      head = m
      hs = st
      m++
    }
    for (i = 0; i < m; i++) print merged[i]
    # hot: ctx ends in an added line, so context lines that join it are printed.
    if (head >= 0) { ctx = merged[head]; cs = hs; hot = 1 }
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
    st = cmt
    if (carry) { codeend(cline, st); cmt = cend }
    cmore = cline
    sub(/^[[:space:]]+/, "", cmore)
    if (nocode(cmore, st)) next
    cprev = chainend(ctx, cs)
    cmore = linkstart(cmore, st)
    if (joins(cprev, cmore)) {
      ctx = cprev cmore
      if (hot) print ctx
    } else {
      ctx = cline
      cs = st
      hot = 0
    }
    next
  }
  # A removed line and the no-newline marker end a run but keep the context.
  /^-/ { flush(); next }
  /^\\/ { flush(); next }
  # Headers clear the context.
  { flush(); ctx = ""; cmt = 0; cs = 0 }
  END { flush() }
'
# Prints each joined line as written, then twice more as jsnorm() reads it, with its block
# comments removed and kept. Every later stage judges all three, so a reading only adds
# refusals; the dedupe below drops a reading equal to its line.
READINGS='
  # A line as the engine reads its names, in three steps: (1) when strip is set, every block
  # comment that closes inside the line is removed with the whitespace on both sides of it
  # (`test./* x */ only(` reads `test.only(`), leaving one space where two identifier bytes
  # would meet; step 1 does not know strings, so a `/*` in one string and a `*/` in a later one
  # would remove the code between them, which is why the line is also read with strip unset;
  # (2) an escape of an ASCII identifier byte is decoded: `\uXXXX`, `\u{...}` (leading zeros
  # allowed), `\xHH`, and an identity escape (a backslash before a letter, `_` or `$` that
  # starts no escape sequence, so `\b`, `\f`, `\n`, `\r`, `\t`, `\v`, `\u` and `\x` stay); any
  # other escape stays as written, so no escape can make a quote, bracket or paren; (3) a
  # computed member access with a literal key, `X["name"]` or
  # `X?.["name"]`, reads `X.name` / `X?.name` when the byte right before it is an identifier
  # byte, `)` or `]`, with no space: `return ["skip"].map(f)` is an array literal. Each loop
  # ends: a comment removal and a key rewrite shorten the string, and the escape loop moves
  # past every escape it matched.
  function jsnorm(s, strip,   out, h, k, pre, gap, c) {
    # A string, not a /.../ literal: busybox awk ends a literal at a `/` inside brackets.
    while (strip && match(s, "[[:space:]]*/[*]([^*]|[*]+[^*/])*[*]+/[[:space:]]*")) {
      gap = (substr(s, 1, RSTART - 1) ~ /[A-Za-z0-9_$]$/ &&
        substr(s, RSTART + RLENGTH) ~ /^[A-Za-z0-9_$]/) ? " " : ""
      s = substr(s, 1, RSTART - 1) gap substr(s, RSTART + RLENGTH)
    }
    out = ""
    while (match(s, /\\(u([0-9A-Fa-f][0-9A-Fa-f][0-9A-Fa-f][0-9A-Fa-f]|[{][0-9A-Fa-f]+[}])|x[0-9A-Fa-f][0-9A-Fa-f]|[ac-eg-mo-qswyzA-Z_$])/)) {
      if (RLENGTH == 2) c = substr(s, RSTART + 1, 1)
      else {
        h = substr(s, RSTART + 2, RLENGTH - 2)
        gsub(/[{}]/, "", h)
        h = tolower(h)
        sub(/^0+/, "", h)
        c = (h in uesc) ? uesc[h] : substr(s, RSTART, RLENGTH)
      }
      out = out substr(s, 1, RSTART - 1) c
      s = substr(s, RSTART + RLENGTH)
    }
    s = out s
    while (match(s, /[]A-Za-z0-9_$)]([?][.])?[[][[:space:]]*["\047`][A-Za-z_$][A-Za-z0-9_$]*["\047`][[:space:]]*[]]/)) {
      k = substr(s, RSTART + 1, RLENGTH - 1)
      pre = (substr(k, 1, 2) == "?.") ? "?." : "."
      sub(/^([?][.])?[[][[:space:]]*["\047`]/, "", k)
      sub(/["\047`][[:space:]]*[]]$/, "", k)
      s = substr(s, 1, RSTART) pre k substr(s, RSTART + RLENGTH)
    }
    return s
  }
  BEGIN {
    # The escape table: lowercase hex without leading zeros to an ASCII identifier byte.
    for (c = 36; c < 123; c++) {
      ch = sprintf("%c", c)
      if (ch ~ /^[A-Za-z0-9_$]$/) uesc[sprintf("%x", c)] = ch
    }
  }
  { print; print jsnorm($0, 1); print jsnorm($0, 0) }
'
JOINED=$(printf '%s\n' "$DIFF_OUT" | LC_ALL=C awk -v plain=1 -v carry=0 "$JOIN" &&
  printf '%s\n' "$DIFF_OUT" | LC_ALL=C awk -v plain=0 -v carry=0 "$JOIN" &&
  printf '%s\n' "$DIFF_OUT" | LC_ALL=C awk -v plain=1 -v carry=1 "$JOIN" &&
  printf '%s\n' "$DIFF_OUT" | LC_ALL=C awk -v plain=0 -v carry=1 "$JOIN") &&
  JOINED=$(printf '%s\n' "$JOINED" | LC_ALL=C awk "$READINGS") &&
  JOINED=$(printf '%s\n' "$JOINED" | LC_ALL=C awk '!seen[$0]++') || {
  echo "check-test-integrity: the added-line scanner (awk) failed; gate 2 cannot see the diff." >&2
  exit 1
}

# .only, .fixme and the MARKERS names (among them node:test's expectFailure) are refused on any
# receiver; .skip only on a chain rooted at a test root, so a test body's t.skip("reason")
# passes. Whitespace may come before a dot, never after it, so prose such as "i.e. only (a, b)"
# is not a member access. A call may be optional (?.) and carry TypeScript type arguments, one
# nesting level (`test.skip<Array<string>>(`); TYPE_ARGS needs a byte right after `<` that is
# neither a space, which formatters always write around a comparison, nor =, so a comparison
# (`filters.only < 1`, `fit <= max`) is not read as type arguments.
DOT='[[:space:]]*[?]?[.]'
TYPE_ARGS='<[^[:space:]<>()=]([^<>()]|<[^<>()]*>)*>'
CALL="[[:space:]]*([?][.][[:space:]]*)?(${TYPE_ARGS}[[:space:]]*)?[(]"
IDENT='[A-Za-z_$][A-Za-z0-9_$]*'
ROOTS='test|describe|it|suite|context|specify|concurrent'
LINK="${DOT}${IDENT}"
MARKERS='fit|xit|xtest|xcontext|xspecify|fdescribe|xdescribe|expectFailure'
RECEIVER_SKIP="(${ROOTS})(${LINK})*${DOT}skip"
RECEIVER_TODO="(${ROOTS})(${LINK})*${DOT}todo"
# The backtick must stay inside single quotes, or sh runs it as a command.
SKIP_PATTERN='(\b('"$MARKERS|$RECEIVER_SKIP"')|'"$DOT"'(only|fixme))('"$CALL"'|('"$DOT"'[A-Za-z_]+)+('"$CALL"'|[[:space:]]*`))'

# The option-object patterns. A key (option_key) may be plain, quoted or computed (`["skip"]`,
# spaces allowed inside the brackets) and have whitespace before its colon, but it must start
# the line or follow {, , or a block comment's */, so prose such as "desktop only: 2 per row" is
# not a key. VALUE is true, null, NaN or a string: node:test skips on any value but undefined and
# false. CALL_VALUE, a number (which may start with a sign or .), Infinity, a literal after a run
# of signs, ~, ! and ( (-1, .5, -true, ~0, !void 0, (true)), a function (`() => x`,
# `function () {}`, the function keyword only: `function$enabled` is a name) or an array or
# object literal followed by , or } (`[]`, `{}`, `!![]`; `["darwin"].includes(p)` starts an
# expression and passes), bare or after such a run, is refused only in an options object that
# is the first or second argument of a test call on the same line, because skip is also a
# pagination key. A method-shorthand key on the test call's line is a function too
# (`{ todo() {} }`, `{ get skip() { return true; } }`, `{ *skip() {} }`): METHOD_OPTION.
# ONLY_OPTION, TODO_OPTION, EXPECT_OPEN and METHOD_OPTION go to the marker grep, so no
# placeholder exempts them. todo and expectFailure are no pagination keys, so TODO_OPTION
# refuses a CALL_VALUE after either on any line; the price is that such a key holding a literal,
# a function or an array or object literal in plain test data (`{ todo: [], done: [] }`), at the
# start of a line or after {, , or */, is refused too. That is what catches a todo or
# expectFailure option in an options object over several lines.
# expectFailure also takes a validator, as assert.throws does. On any line EXPECT_OPEN refuses
# a value that starts with an object, since an object Biome wraps closes lines later, and a
# regex literal or an error class (a capitalised name ending in Error or Exception:
# `TypeError`, `assert.AssertionError`, `DOMException`) followed by , or } or the end of the
# line, so `/^win/.test(p)` passes. An array validator is matched index by index against the
# thrown value, which a plain Error does not match, so the test fails; EXPECT_OPEN leaves arrays
# alone and `["win32"].includes(p)` passes. PLACEHOLDER matches a skipped EMPTY test,
# registered inside an if (!process.env.X) branch: the options object holds no nested object,
# ends at the first } outside a quoted value and is followed directly by an empty () => {}) or
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
ARROW_HEAD="(async[[:space:]]+)?([(][^)]*[)]|${IDENT})[[:space:]]*=>"
FUNCTION_START="(${ARROW_HEAD}|(async[[:space:]]+)?function[^A-Za-z0-9_\$])"
# An array or object literal holding no ] or }: always truthy. A nested one is not matched.
COMPOSITE='([[][^]]*[]]|[{][^}]*[}])'
option_key() {
  printf '%s' "(${Q}?($1)${Q}?|[[][[:space:]]*${Q}($1)${Q}[[:space:]]*[]])"
}
BARE_SKIP="${DOT}skip${CALL}[[:space:]]*[)]"
KEY="(^|[{,]|[*]/)[[:space:]]*"
VALUE="[[:space:]]*:[[:space:]]*((true|null|NaN)\b|${Q})"
CALL_KEY="\b(test|it|describe|suite|context|specify)${CALL}((${ARG}|${ESC_QS})*,)?[[:space:]]*[{]([^}]*,)?[[:space:]]*"
CALL_VALUE="[[:space:]]*:[[:space:]]*([.]?[0-9]|Infinity\b|[-+~!(][-+~[:space:]!(]*${LITERAL}|([-+~!(][-+~[:space:]!(]*)?${FUNCTION_START}|([-+~!(][-+~[:space:]!(]*)?${COMPOSITE}[[:space:])]*[,}])"
SKIP_OPTION="${KEY}$(option_key skip)${VALUE}|${CALL_KEY}$(option_key skip)${CALL_VALUE}"
ONLY_OPTION="${KEY}$(option_key only)${VALUE}|${CALL_KEY}$(option_key only)${CALL_VALUE}"
TODO_OPTION="${KEY}$(option_key 'todo|expectFailure')(${VALUE}|${CALL_VALUE})"
EXPECT_OPEN="${KEY}$(option_key expectFailure)[[:space:]]*:[[:space:]]*([-+~!(][-+~[:space:]!(]*)?([{]|(/([^/*\\]|\\\\.)([^/\\]|\\\\.)*/[A-Za-z]*|(${IDENT}[.])*([A-Z][A-Za-z0-9_\$]*)?(Error|Exception))[[:space:])]*([,}]|\$))"
METHOD_OPTION="${CALL_KEY}((get|async)[[:space:]]+)?([*][[:space:]]*)?$(option_key 'skip|only|todo|expectFailure')[[:space:]]*[(]"
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
PLACEHOLDER="${KEY}$(option_key skip)[[:space:]]*:(${NBQ}|${ESC_QS}|${COMMENT})*[}][[:space:]]*,[[:space:]]*(async[[:space:]]+)?[(][[:space:]]*[)][[:space:]]*=>[[:space:]]*[{][[:space:]]*[}][[:space:]]*[)]"

# -a stops grep treating a line with a byte that is not valid UTF-8 as binary; LC_ALL=C lets
# that byte match a bracket expression, which a UTF-8 locale never does. [[:space:]] is then
# ASCII only, so the join pass has turned the other JavaScript whitespace into spaces.
MARKER_STATUS=0
BAD=$(printf '%s\n' "$JOINED" | LC_ALL=C grep -aE "$SKIP_PATTERN|$BARE_SKIP|$ONLY_OPTION|$TODO_CALL|$TODO_CHAIN|$BARE_TODO|$TODO_OPTION|$EXPECT_OPEN|$METHOD_OPTION") || MARKER_STATUS=$?
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
  echo "check-test-integrity: a line can be listed as the gate reads it (escaped and computed names spelled out, with and without its block comments), in place of or beside the line as written." >&2
  exit 1
fi

echo "check-test-integrity: OK"

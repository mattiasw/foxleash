# Tools

What each Foxleash tool does, with its limits and timings. The [README](../README.md) has the
overview, and [security.md](security.md) describes the safeguards.

## Sites and approval

Before a session opens a page on a site you have not approved, with `tab_open` or `navigate`,
Foxleash asks you in that tab whether to allow it: this session, always, or not at all. The
agent's call waits up to 30 seconds for your answer. After three refused or closed prompts, a
session stops asking.

For a tab on a site you have not approved, the agent sees only the site's address (scheme, host
and port), with no path, query or title. A local file shows only as `file:`.

The tools that read or act in a page work only on a tab showing a site you approved, and never
ask: `read_page`, `get_page_text`, `read_console`, `read_network`, `screenshot`, `click`,
`hover`, `scroll`, `drag`, `type`, `fill_form`, `press_key`, `upload_file`, and `wait_for` when
it waits for text or a selector.

## Sessions and tabs

### The tab group

Each agent session's tabs open in an orange tab group titled Foxleash, and Foxleash acts only on
tabs in that group, including tabs you move into it and tabs that a page in the group opens,
also after your own click. When the agent session ends, Foxleash closes its group if the group
holds only blank tabs, so pages you may still be reading stay open. Those tabs no longer show ON
on the toolbar button, unless the same session reconnects.

The Foxleash button in the toolbar shows ON on the tabs an agent session can use, and ! on tabs
outside an agent session's group when the program is too old for the add-on or newer than it;
clicking it opens Foxleash's settings. The button's title names which of the two it is, and the
settings page says what to do. While the program is too old, a visible settings or first-run page
checks again at most every 10 seconds, and each check restarts the program Firefox runs, which
ends the agent's connection to it (the program refuses every request anyway). After updating the
program, restart the app the agent runs in.

### A window for each session

The setting "Open each agent session in its own window" is off by default. With it on:

- A session's first tab opens in a new window beside yours that holds the session's group, and
  its later tabs open there too, so the tab selected in your window stays as it is. Firefox may
  bring that window to the front when it opens it.
- A page in it that asks you something (whether to allow a site, to save or run a recipe, or to
  allow the sites a task needs) brings that window to the front if your desktop allows it, so
  the question does not wait unseen behind your window.
- The blank tab Firefox opens the window with closes once another tab in it is selected, and the
  window closes at once if the session's first tab cannot be opened.
- When the session ends, Foxleash closes that window if it holds only blank tabs and is not your
  last window.
- If you close the window, the agent's next tab opens a new one.

### Agents that share a session

Subagents or parallel agents started from one agent session (for example Claude Code
subagents) share that session's MCP connection, so Foxleash sees them as one session. They
share its tab group and the sites you approved for it, and you are not asked again for a site
already approved.

Foxleash cannot tell them apart, so any of them can act on any tab in the group; each agent
should keep to the tabs it opened, the tabs its own actions opened and the tabs you point it
to, and leave the others alone.

### `tabs_list`, `tab_select`, `tab_close`, `resize_window`

- `tabs_list` lists the tabs in the session's group. A tab's `active` field is Firefox's: it
  marks the active tab of its window, which changes whenever any tab in that window is opened or
  selected.
- For a tab on a site you approved, the agent gets the tab's title cut to 500 characters and its
  address cut to 2,000, each ending with `…` when cut, in every result that shows the tab. The
  address an action's result reports after a page load is cut the same way.
- The agent can switch to (`tab_select`) and close (`tab_close`) only tabs in its own group, and
  never closes the last tab of a window.
- `resize_window` resizes the whole window that holds the agent's group, your own tabs in it
  included, and first returns a maximized, minimized or full-screen window to its normal state.
  With each session in its own window, that is the session's window, not yours.

While Foxleash is asking you something in a tab of the agent's group (whether to allow a site,
to save or run a recipe, or to allow the sites a task needs), the agent cannot switch to another
tab, and a tab it opens with `tab_open` meanwhile is not selected, though Firefox may still
select a tab a page opens, also after the agent's click.

When a tab's page asks you to confirm leaving it, because the agent closes the tab or loads
another page in it (a new address, a reload, going back or forward), Firefox selects that tab to
ask you, even while Foxleash is asking you something, and a tab you leave for another page
stays selected; `tab_close` tells the agent so, and Firefox closes the tab once you choose to
leave the page.

### `tab_open` and `navigate`

`tab_open` opens a new tab in the session's group, and `navigate` loads an address in a tab,
reloads it, or goes back or forward. `navigate` also takes a path, as `read_page` shows a link
to the page's own site, and loads it on the site the tab shows; `tab_open` needs the whole
address.

- `navigate` to a URL and `tab_open` with a URL return once the page's document is ready, after
  giving its images and other parts at most 0.4 seconds more to load, so the agent can read and
  act in a page that is still loading them. When Foxleash cannot tell that the document is
  ready, they return once the whole page has loaded.
- A tab returned while it still loads has an empty title.
- Going back or forward, or reloading the page the tab already shows, waits until the whole page
  has loaded.
- Before asking about a site you have not approved, `tab_open` and `navigate` refuse an address
  whose host is not a domain name or an IP address, such as one with parentheses or commas, or is
  longer than 253 characters, as `request_sites` does, because the prompt shows the site as it is.

### While a tab is loading another page

A read, an action or a screenshot made while the tab is loading another page, as right after a
click on a link or a form submit, waits up to 10 seconds for that page and then works on it.
When the page has not arrived by then, the agent is told the tab is still loading.

A click or a drag at a point, or a key pressed without an element, is refused and not sent when
the tab was loading another page, or loaded one, before the action could be sent: the point or
the key was chosen for the page before, so the agent reads the new page first.

## Reading a page

### `read_page`

`read_page` returns the page as an accessibility tree: one line per element with its role, name
and state (such as checked, disabled, the value of a field or an editable area, or a link's
address), and the page's visible text, indented by one space per level.

- Each element line carries a short element reference, such as `b12`, that later tools use to
  act on that element; references are valid only for the page they came from.
- A link to the page's own site shows its address as a path starting with `/`, on that site, and
  a link to another site its whole address. `navigate` takes such a path and loads it on the
  site the tab shows, while `tab_open` and `download` need the whole address.
- A file field's line is marked `file field`, so the agent can find it for `upload_file` even
  when the page gives it no label.
- Hidden elements are left out, and frames are noted but not read.
- The agent can read only the interactive elements (`filter: "interactive"`), fewer levels
  (`depth`) or one element and what it contains (`ref`).
- The tree is cut at 50,000 characters, and the agent is told when it was.

With `find`, the agent gets only the lines that contain a text, ignoring case, optionally only
those of one role (`role`), each after the lines of the elements it is in: at most 20, and it is
told how many more match, or how many lines were searched when none did. `find` searches the
whole page, also past the 50,000-character cut, but never the value of a protected field.

`find` searches names, field values, text and link addresses, never role words, state words such
as `frame content not read`, or element references. A `find` that is a role name and matches
nothing says so and points to `role`.

With `role` alone, the agent gets the lines of one role, such as a page's frames (`iframe`),
headings, images (`img`) or links, in the same way: each after the lines of the elements it is in,
at most 20, told how many more there are, or how many lines were searched when none has that role,
across the whole page past the cut.

### `get_page_text`

`get_page_text` returns the text as the page shows it, the main content first (the page's main
element or article, else its largest block of text), then the rest of the page.

- Text hidden with display, visibility or the hidden attribute and the values of form fields are
  left out, and frames are not read.
- The text is cut at 50,000 characters unless the agent asks for more (at most 200,000), and the
  agent is told when it was; it can then read on from where the cut read stopped, without
  reading the start again.

### `screenshot`

`screenshot` takes a PNG of the part of the page a tab shows, also when the tab is in the
background, or with `ref` of one element from `read_page`. For an element screenshot Foxleash
scrolls the page to bring the element into view, then captures its box, cut to the part inside
the window.

A screenshot larger than about 6 MB is too large to return; the agent can then take one of a
single element or save it.

With `saveTo`, Foxleash also saves the PNG as a new file in the folder `foxleash mcp` was
started in, normally the agent's working folder:

- the path must be inside that folder, end in `.png` and be in a folder that exists,
- no folder or file name in it may start with a dot,
- an existing file is never replaced,
- saved files are readable only by you (mode 0600).

Screenshots hide the text of password fields, of one-time code and card number fields that the
page marks as such for autofill, and of text fields that Firefox filled in from your saved
logins, addresses or cards, until you edit them (see
[Protected fields](security.md#protected-fields)).

Some pages and frames cannot be captured:

- When a frame of the page loads while the screenshot is taken, Foxleash refuses it and the
  agent can try again.
- A page Foxleash cannot get into, such as a PDF shown in Firefox's viewer, cannot be captured,
  and neither can a page with such a PDF in a frame or with a frame that never finishes loading.
- A frame showing a certificate error or a blocked-site warning stops a screenshot.

These frames do not stop a screenshot:

- a frame showing Firefox's error page for a page that could not be loaded or does not allow
  being shown in a frame,
- a frame of another add-on, such as a password manager's menu: Foxleash hides it and every
  other frame of the same page or frame, which show blank in the screenshot.

### `read_console`

`read_console` returns what a page wrote to its console: its `console.log`, `info`, `warn`,
`error` and `debug` calls, uncaught errors and unhandled promise rejections, oldest first, each
with its level, kind, text and time.

- Foxleash starts recording a page shortly after it starts loading, in a tab of the agent's
  group on a site you approved, so anything the page logs before then is missed. A page that
  loads quickly, such as a small page served from your own computer, can finish loading first,
  so what it logs while it loads, in its `load` event included, can be missed; what it logs once
  recording has started is recorded.
- A page that is already open starts being recorded, with no messages, when you approve its site
  for the agent's session (in a prompt, through a recipe or a request for sites, or in Foxleash's
  settings) or move its tab into the agent's group, without loading it again, so its form keeps
  what you typed. What it logged before then is never returned.
- The result gives `since`, the time from which the page has been recorded, when it is
  recording: earlier messages may be missing.
- Frames are not recorded.
- Loading a new page in the tab starts with no messages.
- Foxleash keeps the newest 300 messages of a page, each cut to 1,000 characters, and counts the
  older ones it let go.
- The agent can ask for messages of a minimum level, those whose text matches a regular
  expression, and at most a number of the newest ones (100 unless it asks for up to 300).
- When you withdraw the approval or the tab leaves the agent's group, what was recorded is gone,
  and nothing the page logs meanwhile is ever returned. Approving the site again or moving the
  tab back starts recording again, with no messages.
- Recording also ends when the agent's session ends, on every site, also one you allowed always:
  pages loaded afterwards in its tabs are not recorded. When the same session reconnects, its tabs
  start being recorded again, with no messages.
- The result says it is not recording, with no messages, when Foxleash could not start its
  recorder in the page (some pages prevent it), or when recording stopped and nothing started it
  again, for example when the tab went to another site without loading a page. A later approval,
  a change in Foxleash's settings or a move into the agent's group tries again; loading the page
  again always does.

### `read_network`

`read_network` returns a page's network requests, oldest first: each request's URL, method,
resource type, start time, duration, status, redirect target, error and whether it came from
the cache.

- Each request's request and response headers are included only when the agent asks for them
  (`headers`). Foxleash still records them, so a later read can ask for the headers of requests
  an earlier one left them out of.
- The values of the `Cookie`, `Set-Cookie`, `Authorization` and `Proxy-Authorization` headers,
  and of a request's `Content-Length` header, are replaced with `[redacted]`.
- With `body`, each request that sent a body includes `requestBody`: its shape, never a value, a
  length or a size. Its `kind` is `form`, `json` or `other`. A form lists each field name once,
  filled by its first value. A JSON object or array lists its keys, at most 4 deep, and of an
  array only its first element, named `[]`. Each field gives its depth, the kind of its value
  (`text` for a form value; `string`, `number`, `boolean`, `null`, `object` or `array` for JSON)
  and, for text, strings, objects and arrays, whether it is `filled`. At most 100 fields are
  listed, the shallowest first, so a large object cannot hide a later key; `truncated` in
  `requestBody` says more were left out.
- A field name or key is shown only when it looks like a field name: an ASCII letter or `_`
  first, then ASCII letters, digits, `_ . : $ [ ] -`, at most 100 characters. Other names, such
  as an email address or a number used as a key, could be values: one `(name withheld)` field
  stands for all of them in an object or form. Of names that differ only in numbers in brackets,
  such as `items[0]` and `items[1]`, the way a form sends an array, only the first is listed,
  since their count could follow a value's length.
- A multipart file field shows as a text field, filled when the file has a name; its size is not
  shown. A body that is not a form although its content type says so, such as JSON or a token
  sent as a form, shows as `other` with no fields, and so does a form of one field that is empty
  or holds only white space. So does a body that Firefox cut because it is over its limit for
  request bodies (16,777,216 bytes by default), or one that is not JSON in strict UTF-8, which
  says whether it is filled. When Firefox gives a file instead of the body's bytes, `other` does
  not say whether it is filled.
- With `responseBody`, each fetch or XMLHttpRequest request whose response Foxleash captured
  includes `responseBody`: the response's text as it arrived in the page, so the agent can read
  what a form's POST got back without sending it again. Foxleash captures the responses to
  requests whose own URL is on a site you approved for the session and not on the blocklist,
  whether the page or one of its frames made them, and only with a text content type: `text/*`
  (not `text/event-stream`), JSON, XML, JavaScript and form data, also as `+json` and `+xml`
  types.
- A body keeps the first 65,536 bytes of the response, decoded with the charset its
  `Content-Type` names, or as UTF-8 when it names none or one Firefox does not know; bytes that do
  not decode show as U+FFFD. The text is cut to 32,768 characters, and `truncated` in
  `responseBody` says either cut took something.
- The page gets every response whole and in order: a response Foxleash copies from passes
  through it to its end, also past the 65,536 bytes it keeps.
- As a best effort, the values of `access_token`, `refresh_token` and `id_token` fields (also with
  a prefix such as `oauth_access_token`, in camelCase such as `accessToken`, or with a hyphen) in
  JSON, JavaScript, XML elements and form or query text, and every JWT-shaped string, are replaced
  with `[redacted]`, also when the text ends inside one. Other secrets are not: a field named
  `token` or `apiKey`, a key written with escapes, a value that is not a string, a body encoded
  another way, or a response that repeats what a request sent.
- A request has no `responseBody` when the agent does not ask for it; when it is not a fetch or
  XMLHttpRequest; when its URL is on another site or on the blocklist, also as a redirect's next
  hop; when its site stopped being approved or was blocklisted after it was captured; when its
  response has no `Content-Type`, more than one, a type that is not text, a charset in which ASCII
  bytes can decode to other characters (UTF-16, ISO-2022-JP, Shift_JIS, GBK, gb18030, Big5,
  EUC-KR), or text Foxleash cannot redact reliably; when a service worker answered it; while its
  response is still arriving; when it ended in an error such as a refused connection (a response
  with an error status, such as 500, keeps its body); when it was redirected; when it started
  before recording began, or recording stopped and started again while it arrived; when it
  started in the moment after recording began, before Foxleash could capture; when part of it
  arrived, or the agent reads, just as your approvals or blocklist changed; when 64 responses of
  the page were being captured already; and when its body was dropped to make room.
- Requests made by the page's frames are included.
- Foxleash records a page's requests from when it starts loading in a tab of the agent's group
  on a site you approved, and loading a new page in the tab starts a new list, beginning with that
  page's own request.
- A page that is already open starts being recorded, with no requests, when you approve its site
  for the agent's session (in a prompt, through a recipe or a request for sites, or in Foxleash's
  settings) or move its tab into the agent's group, without loading it again. Requests that
  started before then are never returned, with one exception: when such a request is redirected
  after then, the redirect's next request is listed.
- The result gives `since`, the time from which the page has been recorded, when it is
  recording: requests that started earlier are missing. After a page load, `since` is the time the
  page was committed, and the page's own request, which starts just before it, is listed.
- Foxleash keeps the newest 500 requests of a page, fewer when their headers, body shapes or
  response bodies are long. While response bodies take more than half of the page's 4,000,000
  characters, the oldest bodies are dropped first, keeping their requests.
- The agent can ask for the requests whose URL contains a piece of plain text (`pattern`).
- It can ask for the requests of up to 20 resource types (`types`), such as `main_frame` for the
  page itself, `script`, `stylesheet`, `image`, `font` or `xmlhttprequest` for fetch and
  XMLHttpRequest. A type matches only when it is exactly the one Firefox reports, so a misspelled
  type returns no requests.
- It can ask for only the requests that failed (`failed`): those with status 400 or above, or with
  an error such as a refused connection or a blocked or cancelled request. A redirect has not
  failed, nor has a request with no status or error yet.
- These filters apply together, and before the limit: of the requests that match all of them, the
  newest are returned, 100 unless the agent asks for up to 500. The result says it is truncated
  when matching requests were left out or the page made more requests than Foxleash kept;
  requests a filter leaves out do not count.
- When you withdraw the approval or the tab leaves the agent's group, what was recorded is gone,
  and nothing the page requests meanwhile is ever returned. Approving the site again or moving the
  tab back starts recording again, with no requests.
- Recording also ends when the agent's session ends, on every site, also one you allowed always:
  pages loaded afterwards in its tabs are not recorded. When the same session reconnects, its tabs
  start being recorded again, with no requests.
- The result says it is not recording, with no requests, when recording stopped and nothing
  started it again, for example when the tab went to another site without loading a page. A later
  approval, a change in Foxleash's settings or a move into the agent's group tries again; loading
  the page again always does.

## Acting in a page

### `click`, `hover`, `scroll`, `drag`

These act on an element from `read_page` (scrolled into view first) or at a point in the tab's
viewport, as in a screenshot. They send the pointer and mouse events a real mouse sends, in
order: a click is pointerdown, mousedown, pointerup, mouseup and click, after the pointer moves
onto the element.

- `scroll` sends a wheel event and then scrolls what that wheel would scroll, or brings an
  element into view.
- `drag` sends HTML drag-and-drop events when the element is draggable, and otherwise moves the
  pointer to the end in steps.
- The events are simulated, so CSS `:hover` styles do not apply and pages that ignore simulated
  input do not react.
- Foxleash refuses an element that another one covers, naming the covering element, and does not
  act inside frames.
- It refuses clicks on links and form buttons that lead to another site or out of the browser,
  such as to an email address: the agent opens a page on another site with `navigate`, which
  asks you first.
- Firefox's pop-up blocker stops a link or form button that opens a new tab unless you allow
  pop-ups for the site; a new tab that does open joins the agent's tab group, while a new window
  is out of the agent's reach.

### `type`

`type` types text into a text field or an editable area from `read_page`. Foxleash focuses the
element, adds the text and reads it back.

- A text field gets the text after what it already holds.
- An editable area gets it at its caret when the caret is in it, and otherwise at its start, so
  in an email body the text goes above a signature that is already there.
- Text typed in several calls follows on, but once the agent types into another field, the next
  text goes at the start of the area again.
- In an editable area each newline in the text becomes a line break.
- In an email body whose first line is empty above the signature, the text fills that line as
  yours would, so the agent ends it with a newline to keep a blank line before the signature.

Foxleash sends no key events: it inserts the text the way the browser inserts typed text, and
when that changes nothing and the page did not receive it, once more by setting the field's
value the way a page's own scripts do. When an editor cannot be read back, such as the body of a
Google Docs document, the result says the text was sent but not confirmed.

`type` refuses a field that Firefox filled in from your saved logins, addresses or cards, until
you edit it.

### `fill_form`

`fill_form` fills several form fields in one call, each given by its reference from
`read_page`: text fields, selects, checkboxes and radio buttons.

- The text replaces what a field holds and goes in as with `type`.
- A select takes the value or label of an option.
- A checkbox or radio button is clicked when its state differs.
- The result says for each field whether it was filled or why not, and never contains a field's
  value.
- `fill_form` never submits the form.
- It refuses a text field that Firefox filled in from your saved logins, addresses or cards, as
  `type` does.

### `press_key`

`press_key` presses a key, such as `Enter`, `Tab`, `Shift+Tab`, `Escape`, `ArrowDown` or
`Control+a`, on an element from `read_page` or on the focused element. Foxleash sends the key's
events and then does what the browser would do, unless the page cancels the key:

- Enter submits the form or clicks the button or link,
- Tab and Shift+Tab move focus,
- Escape closes an open popover or dialog,
- the arrow keys choose an option in a list.

Other keys reach only the page's own key handlers and do not insert or delete text.

Enter on a link or in a form that leads to another site or out of the browser is refused, as
clicks are. Enter on a link or in a form that opens a new tab meets the pop-up blocker, as
clicks do.

### What an action's result says

After each action (`click`, `hover`, `scroll`, `drag`, `type`, `press_key`, `fill_form` and
`upload_file`), Foxleash waits for the page to settle before it answers:

- for a page the action loads, until that page is ready, up to 10 seconds;
- otherwise until the page has not changed for a tenth of a second and no request it began after
  the action is still open, at most 2 seconds.

When a fetch or XMLHttpRequest the page began after the action has answered, Foxleash also waits
until the page changes or 1.2 seconds have passed since that answer, within the same 2 seconds,
because some pages show an answer only after a short timer, which Firefox runs only after about
a second in a tab that is not selected. So an action whose request changes nothing on the page,
such as an analytics request, takes up to about 1.1 seconds longer. An action on a quiet page
takes about 120 to 150 ms longer than the action itself.

The result then says which element took the action (its role and name, as `read_page` shows
them) and what followed: the tab loaded another page (with its address, shown as `tabs_list`
shows it), is still loading one, the page changed, nothing changed, the page was still changing
at 2 seconds, or the tab closed. It also lists tabs that opened in the agent's group and counts
the requests the page began after the action.

Foxleash watches the elements, attributes and text of the page's own document and its shadow
roots, and its fields' values, not frames, canvas drawing, or CSS animations and transitions, so
the agent reads the page before repeating an action whose result says nothing changed.

### The view of the page

The results of these actions, and of `tab_open`, `navigate` and `wait_for`, end with a view of
the tab's page, so the agent does not read the page again after each step.

- The first time the agent's session gets a page in a tab, the view is the page as `read_page`
  shows it. Past 8,000 characters it keeps the most relevant lines (the element the action aimed
  at and the lines around it, status messages and dialogs, headings and landmarks, fields and
  buttons, then links) and says how many lines it left out, each run of them shown as one
  `… N lines` line, which the agent reads with `read_page` and `ref` or `find`.
- After that, for the same page, the view holds only the lines that changed since the session's
  last view of it, after the lines that contain them, or one line saying nothing changed; a
  `read_page` of the whole page counts as such a view.
- The view is read exactly as `read_page` reads the page, so it shows protected fields as
  protected and works only on a site you approved: a tab that went to another site shows only
  that site's address.
- The argument `view: false` leaves the view out.

## `wait_for`

`wait_for` waits until a page shows some text, until an element matching a CSS selector exists
in it, or until a navigation in a tab finishes: 10 seconds unless the agent asks for up to 30.

- When no navigation is in progress in the tab, one that began and finished since the session's
  last `click`, `hover`, `scroll`, `drag`, `type`, `press_key` or `fill_form` there, or since
  `navigate` there returned, counts at once, unless an earlier `wait_for` already returned for
  it.
- A page that changes its address with its own scripts (`history.pushState` or `replaceState`)
  counts as a navigation.
- Text is matched in the text the page shows, without the values of form fields.
- A selector that contains `[` together with `value` or `ng-reflect` is refused, since it could
  test what a password field holds, which Angular development builds can copy into `ng-reflect`
  attributes.
- Waiting for text or a selector while the tab loads another page, as right after a click or a
  form submit, checks that page once it has arrived.

## `batch`

`batch` runs several tool calls in one call, up to 20, one after the other in order, with
arguments the agent already has: a step cannot use what an earlier step returns.

- It stops at the first step that fails, a `fill_form` with a field that was not filled
  included, and says which steps did not run.
- Since each action waits for the page to settle, a read after it in the same batch sees what
  the action changed.
- Only the last step's result ends with a view of the page, and the batch's own `view: false`
  leaves that out too.
- A batch also stops before a click or a drag at a point, or a key pressed without an element,
  in a tab where an earlier step loaded another page, since that step's point or key was chosen
  before the page was seen.
- Each step is checked exactly as when its tool is called on its own: a step that reads or acts
  in a page on a site you have not approved fails, and a `tab_open` or `navigate` step asks you
  first.

An MCP client that asks you before each tool call asks once for the whole batch, and a rule in
your client that denies or asks for one tool does not cover that tool inside `batch`: deny or
ask for `batch` too to keep it. Foxleash's own checks apply to every step.

## Files

### `upload_file`

`upload_file` uploads files from your computer, given the files and an element from
`read_page`. A file field gets the files as if you had picked them; any other element gets them
dropped on it, which works only where the page takes dropped files.

Foxleash reads files only from the upload folders, never files or folders whose names start with
a dot, files named like keys or files that hold a PEM, OpenSSH, PuTTY, PGP or age private key,
and at most 100 files and 10 MB per upload. [Uploads](security.md#uploads) names the folders and
how to change them.

### `download`

`download` saves a file from the web, given its whole URL (with the page's site in front of a
link address that `read_page` shows as a path) and a plain file name such as `receipt.pdf`.
Foxleash fetches the file with all your cookies for the site, as a request from that site's own
page would, saves it in your Firefox download folder and returns its absolute path and size; the
agent can move it from there.

- The file is saved even where Firefox would open it in another application, such as a PDF set
  to open in a PDF viewer.
- The URL, and the address the file comes from after any redirects, must be on sites you
  approved, and `download` never asks. A redirect on the way can still make Firefox request an
  address on a site you have not approved or on the blocklist, with all your cookies for that
  site, including those that a link from another site would not carry; no file from such a site
  is saved.
- The name must not contain a slash or backslash, control or formatting characters, or start
  with a dot, and Firefox refuses some others, such as names ending in `.desktop`. Firefox adds
  a number when the name is taken, so an existing file is never replaced.
- At most 100 MiB and 50 seconds per file, one download at a time.
- Each download shows in Firefox's downloads panel and history.

## Recipes and site requests

A recipe is a task's steps written down with the sites it uses, kept in Firefox on this
computer. You write, edit and delete recipes in the extension's settings page.

### `propose_recipe`

`propose_recipe` proposes a recipe, giving its name, description, sites and steps. Foxleash
opens a page in the session's tab group that shows them in fields you can edit, and saves the
recipe only when you click Save there; Discard drops it.

- When you have a recipe with that name, the page shows your saved version and the changes to
  its steps.
- The call returns at once with the page's tab id and does not tell the agent whether you saved.
- While the page is open, the session cannot open another recipe page or page asking for sites,
  or ask you about a site, and cannot close the page's tab or load another page in it.
- After three recipe pages or pages asking for sites that you discarded, refused or closed,
  Foxleash opens no more in that session.
- A page still open when the session ends stays open and can still save.

### `list_recipes` and `get_recipe`

`list_recipes` gives each saved recipe's name, description, sites and the time you saved it,
sorted by name, without the steps. `get_recipe` gives one recipe with its steps by its name.

Foxleash hands the agent a recipe as your instructions, outside the untrusted marking it puts on
page content; what the agent reads on pages while following a recipe is still marked untrusted.

### `start_recipe`

Before it opens a recipe's sites, the agent calls `start_recipe` with the recipe's name.
Foxleash opens a page in the session's tab group that lists the recipe's sites and what allowing
does for each, and when you click Allow there, the sites are allowed for that session only,
never always.

- Sites already allowed, on the blocklist or refused in the session are not asked: the blocklist
  and your earlier answers still win.
- The call waits up to 30 seconds for your answer and returns the sites now allowed, blocked and
  refused; when no site needs asking, it returns at once without a page.
- The page is a recipe page, so the rules under `propose_recipe` apply to it: one recipe page or
  page asking for sites at a time, and none after three discarded, refused or closed without an
  answer.
- Like a site prompt, it no longer opens once the session has stopped asking after three refused
  or closed prompts.
- Sites outside the recipe are still asked one by one.

### `request_sites`

Without a recipe, the agent can call `request_sites` at the start of a task with the sites the
task needs, at most 20; each address is reduced to its site. Foxleash opens a page in the
session's tab group that lists those sites and what allowing does for each, with nothing else
from the agent, and when you click Allow there, they are allowed for that session only, never
always.

- Sites already allowed, on the blocklist or refused in the session are not asked, and when no
  site needs asking the call returns at once without a page.
- The call waits up to 30 seconds for your answer and returns the sites now allowed, blocked and
  refused.
- Don't allow, or closing the page, fails the call and refuses nothing: each site still asks on
  its own when the agent opens it.
- The same limits as for recipe pages apply: one such page or recipe page at a time, none beside
  a site prompt, none after three discarded, refused or closed without an answer, and none once
  the session has stopped asking.
- Sites outside the list are still asked one by one.

### The `run_recipe` prompt

You can also start a saved recipe from your MCP client with the `run_recipe` prompt: in Claude
Code, `/mcp__foxleash__run_recipe <name>`, where a part of the name that only one recipe has is
enough. It tells the agent to call `start_recipe` and then follow the recipe's steps.

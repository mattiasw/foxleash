# Questions to the user

Measurements behind [ADR 0057](../adr/0057-an-open-question-stays-in-view-and-is-answered-only-by-input-made-for-it.md).

## The session's own window on a desktop, by hand (2026-11-14)

Checked by hand on Ubuntu 26.04, GNOME on Wayland, Firefox from Mozilla's APT repository, a
development build, with the session's window a second window of the same Firefox as the user's:

- **Focus**: the session's window took focus when Firefox opened it, also when its first tab was
  a page on a site allowed beforehand, so no prompt was shown. `focused: false` is not honoured
  there either, as 0044 measured for headless Firefox; Firefox's own reason was not looked into.
  Later `tab_open` calls neither raised the window nor changed the user's selected tab.
- **Attention**: with the session's window behind the user's, a second approval prompt (a new
  site) showed nothing the user noticed, and the agent's call timed out after 30 s. Every prompt
  called only `windows.update(windowId, { drawAttention: true })`; whether that has any visible
  effect there is not established.
- **Tools**: `screenshot`, `wait_for` and `click` worked with the window behind or minimized.

## Keys typed into a prompt that took the keyboard (2026-11-14)

Shown end to end by `e2e/approval.test.ts` in headless Firefox 156.0.1 with WebDriver keys, before
the first keyboard rule of 2026-11-14, when an Enter or Space answered whenever it went down while
the page was armed, wherever the focus on the button came from. "Answered" means the prompt took
the button's answer.

A prompt page that takes keyboard focus while the user types in another window (a prompt selected
in the window the user types in, or the session's own window brought to the front by ADR 0057)
received the user's next keys: Tab, Tab in the first second, then Enter at one second or later, put
focus on "Allow this session" and answered it, because Firefox's keyboard activation of a button
is a trusted click with `detail` 0 (the end-to-end test in `e2e/approval.test.ts` shows it). Three
Tabs then Enter stored "Always allow"; on the run page two Tabs reach "Allow". Typing that simply
went on for more than a second reached armed buttons the same way with a later Tab, Tab, Enter.

## Key sequences and focus on the prompt pages (2026-11-14)

Measured end to end in Firefox 156, headless, with WebDriver keys, under the first keyboard rule of
2026-11-14 (an Enter or Space answered on a button focused while armed, and Enter or Space on an
answer button did not restart the arming second). Key sequences meant for another window (a
terminal, an agent's prompt) still answered:

1. **Shift+Tab, then Enter, from where the page left focus.** None of the pages focused anything
   while asking. Measured end to end in Firefox 156 with WebDriver keys: on a fresh approval
   prompt `document.activeElement` is the body, and after the buttons armed Shift+Tab focused
   "Always allow" and Enter answered it. On the propose page, `changed()` focused `#status`, which
   follows the buttons, when the stored recipe had been removed meanwhile; Shift+Tab from a
   focused `#status` left the page in that measurement, so this one did not reproduce in Firefox
   156, but nothing in the code kept it from reaching Save.
2. **Refused presses fill the pause.** A refused Enter or Space on an answer button did not
   restart the second, and focus that sat on a button whose focus did not count still made its
   neighbour count after one armed Tab: Tab, Tab before the buttons arm, a pause, Tab, Enter
   answered "Always allow"; so did Enter, a pause, Enter, Tab, Enter from a button whose focus
   came back with the window.
3. **Space held while Enter is pressed** clicks twice; the Space keyup rule of ADR 0057 already
   refuses it.
4. **Firefox's menus.** On Linux a lone Alt (or F10, Shift+F10, the Menu key) may open a menu that
   takes the following keys without blurring the window, so they never restart the second. This
   needs Firefox on a desktop; WebDriver keys reach the page whatever has focus.

Measured end to end in Firefox 156 with WebDriver keys:

- `heading.focus()` on an `<h1 tabindex="-1">` while the prompt's tab is hidden makes it the
  active element; when the tab is shown, the window's `focus` fires, then the heading's.
- `FocusEvent.relatedTarget` on a button's `focus` is the element focus left: the heading, the
  previous button, or a text field before the buttons.
- Tab past the last button, Shift+Tab from the heading, and Shift+Tab from a focused `#status`
  leave the page: the window blurs and the page disarms. Focus coming back into the page (the
  window returns, or Tab from the browser's toolbar) fires the window's `focus` first, then the
  element's with `relatedTarget` null.
- With no element focused, Tab and Shift+Tab start from where focus last was, with
  `relatedTarget` null.
- Enter clicks a button at keydown, Space at its keyup. `preventDefault()` on the keydown stops
  either click, and so does moving focus to the heading during the keydown.
- Quick find (`/`) blurs the window, which disarms the page.

## Firefox's leave dialog on a close or a load (2026-11-14)

We measured it in Firefox 156.0.1, headless, with
`dom.require_user_interaction_for_beforeunload` set to false, which stands in for the user's
interaction with the page, and "Open each agent session in its own window" off. One session had a
site prompt open in its own group tab, selected. Each case opened a page that asks to confirm
leaving it with `tab_open` (the tab opened unselected, as ADR 0057 says), selected the question's
tab again with `tab_select`, then made the call:

| Call | Selected while the leave prompt is open | Selected after the user leaves the page |
|---|---|---|
| `tab_close` | the page's tab | the tab closed; Firefox picked the next tab |
| `navigate` to a URL | the page's tab | the page's tab, on the new URL |
| `navigate` reload | the page's tab | the page's tab |
| `navigate` back | the page's tab | the page's tab, on the earlier page |
| `navigate` forward | the page's tab | the page's tab, on the later page |

The prompt opened 42 to 91 ms after the call, and the tab was still selected a second later. So a
load the agent starts in such a tab gets the same dialog and the same select as a close, and after
the user leaves, Firefox does not select the question's tab again. The end-to-end tests in
`e2e/tab-close.test.ts` now pin these selects, beside a control in which the same calls on a page
that does not ask leave the question's tab selected. Two things seen on the way, not asserted: a
reload, back or forward returns after its one-second load wait with the page still shown while the
dialog holds the load, and the load of the page's address that follows a history step
([0025](../adr/0025-history-loads-and-autofilled-fields.md)) can raise the same dialog.

## Firefox's menu bar after a lone Alt (2026-11-14)

Measured in Firefox 156.0.1, not headless, under Xvfb on X11 without a window manager, with real X
key events, on an approval prompt opened by `tab_open` and armed:

- **Alt, q, w, z, Escape, then Tab, Tab, Enter** 100 to 320 ms after the Escape answered "Allow
  this session". After the Alt the menu bar was active. The page's capture log:
  `keydown:Alt@50, keyup:Alt@80, keyup:Escape@670, keydown:Tab@771, focusin:no@773,
  keyup:Tab@801, keydown:Tab@881, focusin:once@883, keyup:Tab@911, keydown:Enter@992`. The page
  saw no keydown for q, w, z or Escape.
- **Alt, v (opens the View menu), q, z, Escape, Tab, Tab, Enter** answered "Don't allow". The page
  saw no keydown for v, q, z, Escape or the first Tab, only that Tab's keyup.
- Controls: without the Alt every keydown reached the page and the Enter was refused; armed, Tab,
  Tab, Enter alone answered.

While the menu bar held the keyboard the page saw neither keydowns nor keyups: no keyup for q, w
or z, nor for the Escape that only closed the View menu. What it does see is the lone Alt's
keydown and keyup, and, once the menu bar lets go, keyups whose keydown it never saw. Whether the
page receives pointer events while the menu bar is active was not measured. End-to-end tests
cannot show the menu bar: WebDriver keys are dispatched in the page whatever has focus.

## Firefox's other menus, before and with the hold at every menu input (2026-11-14)

Measured in Firefox 156.0.1, not headless, under Xvfb on X11 without a window manager, with real X
key and pointer events, on an approval prompt opened by `tab_open` and armed. Each trial opens a
menu, types keys into it for 1.3 s (arrow keys into a popup, q, w, z into the bare menu bar),
closes it, and 80 to 150 ms later presses Tab, Tab, Enter. "Answered" means the prompt answered
Allow this session; "refused" means it was not answered within 3 s. Times in the page's capture
logs are milliseconds from the trial's start. No key typed into any menu reached the page. The
controls held in every run: armed, Tab, Tab, Enter answered; with no menu, q, w, z, Escape, Tab,
Tab, Enter was refused. Before the hold at every menu input (only a lone Alt held):

- **F10** opens the menu bar and its File menu. The page saw F10's keydown and restarted the
  second there. Closed with Escape, Escape, or with F10 again, the closing key's keyup reached the
  page and the Tab path was refused; after one Escape the menu bar stayed active and took the first
  Tab's keydown. Closed with a click on the tab strip or in the page, the page saw nothing after
  F10's keydown (`keydown:F10@52, ARMED@1052, pointer-left@1738, keydown:Tab@1873`; F10's keyup
  taken; the click in the page did not reach it), and the Tab path **answered**.
- **Shift+F10** fires `contextmenu` in the page and opens the context menu:
  `keydown:Shift@46, keydown:F10@47, contextmenu@59, keyup:F10@83, keyup:Shift@84`, so the
  opening keys' keyups reach the page after the `contextmenu` event. Closed with Escape (its keyup
  reached the page) it was refused; closed with a click on the tab strip (`keydown:Shift@55,
  keydown:F10@56, contextmenu@57, ARMED@1168`) it **answered**.
- **The Menu key**: `keydown:ContextMenu@54, contextmenu@55`, its keyup taken. Refused when closed
  with Escape; **answered** when closed with a click on the tab strip
  (`keydown:ContextMenu@59, contextmenu@60, ARMED@1059`).
- **A right-click** in the page: `pointerdown:b2@107, mousedown:b2@107, contextmenu:b2@119`, so the
  secondary pointer press arrives before the menu opens. Refused when closed with Escape; when
  closed with a click on the tab strip the page stayed armed throughout and the Tab path
  **answered**. Closed with a click in the page, the click did not reach the page.
- **Alt+V** (the View menu): `keydown:Alt@55, keydown:v@85`, no keyups. Refused when closed with
  Escape, Escape; **answered** when closed with a click on the tab strip
  (`keydown:Alt@31, keydown:v@62, ARMED@1062`).
- **A seen-down key a menu took the keyup of**: Tab down, F10, Tab up, arrows, a Tab that closes
  the menus, the question refocused by script: `keydown:Tab@50, keydown:F10@150, ARMED@1151,
  keyup:Tab@1946`. The closing Tab's keydown was taken; its keyup counted as the keyup of the Tab
  the page saw go down and left the page armed, and the Tab path **answered**.
- **A lone Alt the page did not hold for**: an Alt sent right after `tab_open` was called did not
  open the menu bar (q, w, z reached the page), and one sent when the prompt's page first appeared
  found the question already showing, a plain lone Alt that held; both refused. An Alt pressed in
  another tab and released on the prompt opened the menu bar (`blur@20, focus@174, keyup:Alt@198,
  ARMED@1198`) and **answered**. An Alt with a click and no pointer press between its keydown and
  keyup opened the menu bar (`keydown:Alt@51, click(untrusted)@57, keyup:Alt@87`, which ended the
  candidate) and **answered**. AltLeft down, AltRight down, AltLeft up and AltRight up sent at
  once all reached the page at 47 ms; the second Alt keyup ended the hold, the menu bar opened,
  and the Tab path **answered**.
- **The menu access key set to Control** (`ui.key.menuAccessKey` 17, an `about:config` setting): a
  lone Control opened the menu bar, and the page saw only Control's keydown and keyup, a modifier
  it saw go down, so nothing restarted. Refused when closed with Escape; **answered** when closed
  with a click on the tab strip. A lone Alt then did not open the menu bar.
- **Menus of Firefox's own window opened with the mouse**: the application menu button's panel
  blurred the page when it opened (`blur@448`, `focus@1794` when it closed), which disarms it, so
  the Tab path was refused. A right-click on the tab strip opens its context menu with no event in
  the page (the pointer had left the page earlier): refused when closed with Escape, whose keyup
  reached the page; **answered** when closed with a click on the tab strip.

The same trials repeated against the rules of the hold at every menu input, in the same setup,
with the controls holding again:

- **Every trial above that answered was refused**, and every trial closed with Escape stayed
  refused: F10 closed with a click on the tab strip or in the page; Shift+F10, the Menu key and a
  right-click on the heading, each closed with a click on the tab strip; Alt+V closed with a click
  on the tab strip; the seen-down Tab whose keyup a menu took; an Alt pressed in another tab and
  released on the prompt; a script click between Alt's keydown and keyup; AltLeft and AltRight
  released together. With F10 closed by a click on the tab strip the page stayed unarmed from the
  F10 until the first Tab, and armed a second after it: `UNARMED@52, keydown:F10@52,
  pointer-left@1715, keydown:Tab@1848, ..., keydown:Enter@2070, ARMED@3100`.
- **A right-click with Shift held** fires no `contextmenu` event in the page
  (`dom.event.contextmenu.shift_suppresses_event` is true by default): the page saw
  `keydown:Shift, pointerdown:b2, mousedown:b2, keyup:Shift`. Closed with a click on the tab strip,
  it answered before the hold at every menu input and was refused with it, held by the
  secondary-button press. With `dom.event.contextmenu.enabled` set to false the `contextmenu` event
  still reached the extension page; a right-click there answered before the hold at every menu
  input and was refused with it.
- **A key pressed just after the opening input**: before the join window was added, a Down
  pressed 0 ms after F10 reached the page and ended the hold, and the Tab path answered; so did a
  Down 5 ms after the Menu key. A Down 5 ms after F10, a right-click or Alt+V, or 15 ms or more
  after the Menu key, was taken by the menu. With the 100 ms join window every such trial was
  refused: 0 ms after F10, and 5, 15, 30, 60 and 120 ms after F10, the Menu key, a right-click and
  Alt+V. In the 0 ms trial the page saw `keydown:F10@35, keydown:ArrowDown@36, keyup:F10@36,
  keyup:ArrowDown@37` and stayed unarmed until the first Tab.
- **A lone Alt while the prompt tab loads**: sent right after `tab_open` was called, before the
  prompt page's script ran, it opened the menu bar in this run (with the same timing it had not
  before), the page saw nothing of it and armed a second after the question showed, and the Tab
  path **answered** after the menu bar was closed with a click on the tab strip. Sent once the
  question was showing, it held as a lone Alt and was refused. Neither timing hit the moment
  between the page's script starting and the question showing.
- **Unchanged**: with the menu access key set to Control, a lone Control and a right-click on the
  tab strip were each refused when the menu was closed with Escape and **answered** when it was
  closed with a click on the tab strip; the application menu panel's blur disarmed the page, and
  the Tab path was refused.
- **Keyups of keys held through the opening input**: Shift+F10's Shift keyup reached the page
  25 ms after the `contextmenu` event, and a Shift's 40 ms after a right press.

Measured as covered by the hold at every menu input:

- A key pressed just after a menu-opening input, before the menu takes the keyboard: it reached
  the page only when pressed less than 15 ms after that input (0 ms after F10, 5 ms after the Menu
  key), and it now joins the hold, so the 100 ms join window leaves a margin of more than 85 ms.
- A right-click with Shift held, which fires no `contextmenu` event in the page, and a right-click
  with `dom.event.contextmenu.enabled` false: the secondary-button press holds for both.
- The application menu panel: it blurs the page, which disarms it.

Wayland and GNOME were not measured: no Wayland compositor was available. End-to-end tests cannot
show Firefox's menus: WebDriver keys are dispatched in the page whatever has focus.

## Firefox's sign-in dialog on a load (2026-11-18)

Measured in Firefox 160.0.1 (release pin) and 153.7.0esr (ESR pin), headless, with listeners
registered from an extension page of the installed add-on, which holds `webRequest`,
`webRequestBlocking` and `<all_urls>`. A top-level load of a page that answers `401` with a Basic
challenge, started three ways (Foxleash's `tab_open`, `tabs.create` from the extension page, and
a tab opened over WebDriver BiDi), behaved the same in both versions:

- a non-blocking `webRequest.onAuthRequired` listener, filtered to `<all_urls>` alone or also to
  `types: ["main_frame"]`, was never called;
- a non-blocking `webRequest.onHeadersReceived` listener for `main_frame` was called once for each
  load, with `statusCode` 401, the tab's id and `frameId` 0;
- Firefox selected the new tab for its dialog, and the tab's top frame committed nothing until the
  tab was closed at the 30-second timeout. No question was open in that run.

Why Firefox calls no non-blocking `onAuthRequired` listener for a document load is not known. The
end-to-end test in `e2e/tab-close.test.ts` pins the select with a question open, in the same two
versions, with "Open each agent session in its own window" off: one session has a site prompt open
in its own group tab, selected; `tab_open` of a page on an approved site that answers `401` with a
Basic challenge; Firefox selects the new tab for its dialog. A control test pins that a `401`
without a challenge loads as a page and is not selected.

Not measured: `navigate` in another tab, a reload that loads the address, an approved address
that redirects to such a page, an act or the page itself starting such a load, a challenge on a
subresource or a frame, a proxy's challenge, each session in its own window, and Firefox's TLS
client-certificate dialog ("User Identification Request"), which may hold a load the same way
without a `401` or `407` response, so the detection ADR 0057 describes would not see it
(unverified).

## A resize under the answer buttons (2026-11-18)

Measured in Firefox 156.0.1 headless: 16 resizes down to the 500 px minimum moved a site
prompt's buttons 72 px down (their top from 331 to 403), and they stayed armed (0 unarmed);
no button's centre landed inside another button. With a 24 px root font size (a stand-in for
Firefox's font size setting or a zoom of about 150 %, neither measured) the button row wraps, and
a resize from 600 to 660 px put "Always allow" where "Don't allow" was: 40 such
centre-in-another-button pairs, with 0 buttons unarmed right after the resize. A trusted click at
that point right after the resize answered Always allow.

## A question's window behind a terminal on GNOME (2026-11-19)

Measured with Firefox Developer Edition 160.0b5 on Ubuntu 26.04.1, GNOME Shell 50.1 on Wayland,
with "Open each agent session in its own window" on and Firefox behind a terminal: the question
opened in the session's window, the window did not come to the front, and GNOME showed no notice
that Firefox wanted attention. Nothing told the user that Foxleash was waiting, and the call
returned after 30 s. With the setting off, the question gets only `drawAttention`, which users did
not notice either.

Whether Firefox then reports the refused window as not focused has not yet been measured on that
desktop. In Firefox, `windows.Window.focused` and a page's `document.hasFocus()` come from the
same top-level window activation.

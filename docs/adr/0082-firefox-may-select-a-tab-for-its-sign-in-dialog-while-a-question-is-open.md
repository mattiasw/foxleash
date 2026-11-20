# 0082: Firefox may select a tab for its sign-in dialog while a question is open

**Status:** Accepted, 2026-11-18. Amends
[0062](0062-an-open-question-guards-only-the-tab-selects-foxleash-makes.md): adds Firefox's
sign-in dialog on a load to its accepted list.

## Context

While a session's question is open in a tab of its group (a site prompt, a recipe page, a
site-request page), the agent calls `tab_open` with an address on an approved site that answers
`401` with `WWW-Authenticate: Basic`. `openOnPage` creates the tab unselected and loads it, and
Firefox then selects that tab to show its HTTP sign-in dialog, so the question's tab is no longer
the selected one, with no user action. The dialog holds the navigation: the tab's top frame
commits nothing until the user answers. `waitForLoad` with a known URL waited only for a commit,
so `tab_open` failed with `navigation_timeout` after the 30-second load timeout, and
`openOnPage` then closed the tab the user was looking at. MCP clients usually give up on the call
before that.

The add-on listing said, with no exception, that tabs Foxleash opens while it asks are not
selected, and [0062](0062-an-open-question-guards-only-the-tab-selects-foxleash-makes.md)'s
accepted list has no sign-in dialog. The selects Firefox makes for its leave dialog and those
pages make were in `docs/tools.md`, but not in the listing either.

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
without a `401` or `407` response, so the detection below would not see it (unverified).

## Decision

**The select is accepted** under 0062's test for a further instance: Foxleash does not make it,
and closing it would mean refusing `tab_open` and `navigate`, which a well-behaved agent uses on
its other tabs while it waits. This record adds it to 0062's list of selects outside the bound.

**Loads that wait on the dialog answer within seconds.** For a wait with a known URL,
`waitForLoad` (`wait-for-load.ts`) also listens to `webRequest.onHeadersReceived` for the tab's
top-level responses (`types: ["main_frame"]` and the tab's id, with `responseHeaders`). A response
is a challenge when it is a `401` with a `WWW-Authenticate` header or a `407` with a
`Proxy-Authenticate` header, header names compared without regard to case; the scheme is not read.
A challenge arms a timer of `SIGN_IN_GRACE_MS` (2 seconds), a later challenge arms it again from
then. A top-frame commit of a document in the tab clears it, as do the start of a new top-level
navigation in the tab other than to about:blank, which ends the load the dialog held, and a
top-level response in the tab that is no challenge: while a dialog holds the load no other
top-level response comes in the tab, so such a response answers the repeated request or a new
navigation's.
When it fires, the wait fails with the `ToolError` code `sign_in_needed`, whose message names only
the tab and tells the agent to read it after the user signs in or cancels. A load timeout while
the timer runs fails with `sign_in_needed` too, so a challenge that comes late in the load does not
make `tab_open` close the tab Firefox shows the dialog in. The listener is added when the wait starts and removed, with
the timer, when it settles; it counts also after the tab arrived, as the file guard's refusal does
([0081](0081-session-tabs-cancel-files-from-sites-the-session-may-not-act-on.md)). On that error
`openOnPage` and `openOnPrompt` (`handlers.ts`) neither remove the tab nor select it: Firefox shows
the dialog in it and selected it to do so, and while a question is open Foxleash adds no select of
its own. `navigate` to a URL gets the same error through the shared wait.

The grace is there because a challenge does not always mean a dialog. Firefox answers a challenge
by itself when it already holds a login for the realm, another add-on may answer it, and Firefox
shows the response as a page for a scheme it cannot answer or once it stops showing dialogs to a
page that keeps asking. In each case a response that is no challenge, or a commit, comes soon
after the challenge, and either means no dialog holds the load. Failing at the challenge would fail `tab_open`
and `navigate` on such pages, for instance every new directory of a site the user already signed
in to. The cost is that a real sign-in answers 2 seconds after the challenge instead of at once,
still far below the 30-second timeout.

Waits without a URL (a reload of the page the tab shows, back, forward, and the load of the page's
address that follows a history step, [0025](0025-history-loads-and-autofilled-fields.md))
do not listen; they never failed on the timeout, they return the tab as it is after it. The loads
that carry a URL do listen: the load of the address in a tab Firefox unloaded or in place of a
blank entry a reload landed on, and a reload on a site question the user answered.

**The listener is non-blocking.** It is registered with `responseHeaders` only, never `blocking`,
and returns nothing, so Foxleash still never changes a request and blocks only in the two places
`browser-api.ts` names. It reads only the status and whether a challenge header is present, and it
selects nothing, so 0062's checkpoint in `browser-api.ts` still holds: this adds no call that can
select a tab or focus a window.

A proxy's `407` that Firefox reports for the tab's top-level request fails the wait the same way,
and the message holds for both. For an https address the proxy answers the request that opens the
tunnel, which Firefox may not report as the tab's response; such a challenge is not measured and
may still end in the load timeout. One false failure stays: when Firefox answers a challenge by
itself, or another add-on does, and the server takes more than 2 seconds to answer the repeated
request, the call fails with `sign_in_needed` although no dialog shows; the tab is kept, its page
loads, and the message tells the agent to read the tab.

**The risk that stays.** A key meant for the question goes to Firefox's dialog. The dialog may
hold a login Firefox saved for the site that asked, and Enter sends it there. After a redirect on
an approved site that site can be one the session may not act on; once the user signs in its page
loads in the session's tab, where it reaches the agent redacted to its site, as "Tabs on other
sites" in `docs/security.md` describes, and the acts refuse it. Text the user is typing into the
propose page's fields, where a recipe is read, edited and saved, goes into the dialog's user and
password fields once Firefox selects the dialog's tab, and Enter sends it to the host that asked,
which after a redirect can be a host the agent picked. Before, the tab was closed after 30
seconds, and the dialog with it; now it stays until the user answers or closes it, so an agent
misled by a page can open any number of such tabs, each answered within seconds, kept, and
selected by Firefox in turn.

What holds is the question's buttons. `createArming` (`prompt-arming.ts`) disarms at once when the
page stops being visible or focused, and arms again only `ARMING_DELAY_MS` (one second) after it is
both again. `armButtons` (`page-ui.ts`) feeds it the page's `visibilitychange` and the window's
`focus` in `watch`, and the window's `blur` from page load. The site prompt (`approve.ts`), the
propose page (`propose.ts`) and the run page (`run.ts`, also for `request_sites`) all arm through
`armButtons` ([0007](0007-per-site-approval-and-tab-redaction.md),
[0058](0058-prompt-keys-answer-only-on-a-button-focused-after-arming.md),
[0063](0063-a-lone-alt-holds-a-prompts-arming-until-the-page-sees-input.md)). So while Firefox shows
the dialog in another tab the question's buttons answer nothing, and once its tab is shown again
they need a full second of being visible and focused.

## Alternatives rejected

- Refusing the loads Foxleash starts in the group's other tabs while a question is open: it
  refuses `tab_open` and `navigate` a well-behaved agent uses, 0062's first rejected alternative,
  and agents sharing a session share its group
  ([0038](0038-agents-sharing-a-session-share-its-tab-group.md)).
- Selecting the question's tab again when Firefox selects another: `tabs.onActivated` does not say
  who selected a tab, 0062's reason, and it would hide the dialog the load waits on.
- Cancelling the challenge with a blocking `onAuthRequired` while a question is open: it changes a
  request, which the extension promises never to do, and the user could not sign in to a site they
  approved.
- Hearing the challenge with `webRequest.onAuthRequired`, the event made for it: Firefox 160.0.1
  and 153.7.0esr call no non-blocking listener for a top-level load (measured above), and a
  blocking one would be a third place where Foxleash blocks a request and could change it, the
  alternative before this one.
- Failing at the challenge itself, with no grace: it fails loads that Firefox signs in to by
  itself, as the Decision says.

## Consequences

The add-on listing now says: "While Foxleash is asking you something in a tab, the agent cannot
select another tab of its group, and Foxleash does not select the tabs it opens for the agent
meanwhile. Firefox itself may still select a tab to show a page's sign-in dialog or to ask whether
you want to leave a page, and a page may select a tab it opens, also after the agent's click."
`docs/security.md` describes the safeguard and its exceptions in full, and `docs/tools.md` the
error. 0062's body is unchanged, and its sentence that the listing is about the selects Foxleash
makes still holds. 0062 also says README tells the user about the leave dialog's select; README has
no such sentence, and the user docs that carry these selects are `docs/tools.md`,
`docs/security.md` and the listing.

The risk above stays. The end-to-end test pins Firefox's select, so a Firefox that stops making it
fails the test when a pinned version moves. Revisit if a report shows sign-in tabs piling up or
being used to keep a question hidden, or if a Firefox calls non-blocking `onAuthRequired`
listeners for top-level loads.

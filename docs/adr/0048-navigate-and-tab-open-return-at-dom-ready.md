# 0048: navigate and tab_open return when the page's document is ready

**Status:** Accepted, 2026-11-13.

## Context

`waitForLoad` (`apps/extension/src/wait-for-load.ts`) resolved a URL load only when the tab's
status became `complete`, which is the page's load event, so `navigate` to a URL and `tab_open`
with a URL waited for every image, frame and script. Measured: a fixture page whose DOM was
complete at once took 3,076 to 3,105 ms to open because one image answered after 3 s. On real
sites the load event came 100 to 1,890 ms after DOM ready: six lighter pages 100 to 170 ms,
theguardian.com 163, edition.cnn.com 335, dn.se 376, aftonbladet.se 587, nytimes.com 1,890. An
agent can read and act in a page once its DOM is ready.

The per-tab navigation tracker of ADR 0040 (`tab-navigations.ts`) already ends a top-frame
navigation as `"ready"` at `onDOMContentLoaded` of the committed document, matched by
`documentId`, and ignores a DOM ready before the commit, which is the leaving document's.

## Decision

`waitForLoad` takes an optional `ready`, the tracker's `settled`. With it and a known URL, once
the tab's top frame has committed the requested document (the same commit that already lets the
wait end), the wait asks `ready.settled(tabId, timeoutMs)` once. On `"ready"` or `"ended"` it
gives the load `LOAD_AFTER_READY_MS` (400 ms) more and then returns the tab as it is; a
`complete` before that returns at once, as before. Every other answer starts no extra time and
leaves the wait to its `complete` and its timeout, as before. `"idle"` among them: it also means
the tracker lost the navigation, since the tracker ends a navigation on any status `complete`
and then drops the commit that follows, so a stray `complete` between the URL's
`onBeforeNavigate` and its commit would otherwise start the 400 ms while the DOM is still being
parsed. The tracker's listeners are added at the top of the background script, before any wait,
so at the commit it already holds the new document, and its `"ready"` can only be that
document's. A top-frame navigation that leaves the document, as a client redirect does, stops
the extra time, and its commit asks again, so the wait returns at the DOM ready of the page the
tab moved on to, not with the page it left.

400 ms is the smallest round value that still lets the load event arrive in time on 9 of the 11
measured real pages (all but aftonbladet.se and nytimes.com), and the fixture page then opens
in about half a second.

These loads take the earlier return (`handlers.ts` passes `ready: navigations`): `navigate` to
a URL, `tab_open` with a URL, and both after an approval prompt, including a retry on the
prompt's own tab and a reload of an answered prompt, which load the page the prompt asked about
by URL. These keep the load event:

- Going back and forward: the history-step reload of ADR 0025 decides from the frame requests,
  which are all seen only once the step's tab is `complete`.
- Every reload of the page the tab shows: `tabs.reload` has no URL whose commit can be tracked,
  and its about:blank check relies on `complete`. The reload of a tab Firefox unloaded, the
  about:blank fix-up and a reload that went through an approval prompt load by URL but keep the
  full wait too, so reloading follows one rule.

`wait_for` with `navigation` counts a load that ends. The load of a page `navigate` or
`tab_open` returned early ends after they answered, though it is in their result, so the
handlers note the tab with the count of navigations begun in it then, and `wait_for` does not
count a load that ends before another navigation begins in that tab.

`tab_open` keeps the order of ADR 0029: the tab is created unloaded, grouped before its page
loads and selected only after the wait returned; its document has then committed, so selecting
it restores no history load.

A tab returned while it still loads carries no title: `tabInfo` leaves out the title of a
loading tab, which can still be the previous page's. The tool descriptions and the README say
so.

## Alternatives rejected

- Returning at the commit: the new document's DOM may still be empty.
- Waiting for the load event, as before: the measured cost.
- A fixed extra time of one second: the fixture page would take over a second to open, which
  misses the goal of opening a page in well under a second.
- A second `onDOMContentLoaded` listener in `waitForLoad`: two sources for DOM ready that could
  disagree.
- Showing the title of a tab returned while it loads: on a page without a `<title>` the tab's
  title can still be the previous page's.

## Consequences

The agent gets a page whose images and frames may still be loading, and the returned tab has
an empty title then; a read gets the page's contents. A screenshot right after the early
return fails with `page_changed` more often, since a frame of the page can still commit during
the capture; how often is unmeasured, and agents reporting it would make us revisit. A page
whose DOM is ready before the tab reports loading, or whose navigation the tracker lost, waits
for `complete` as before. The bound passed to `settled` is the wait's whole timeout, since the
timers have no clock. A wait that ends at its own timeout leaves that bound running; when it
passes on a document still not parsed, the tracker ends that navigation as committed for every
reader, as a page request's 10 s bound does.

# 0032: HTML drag sends the end's events in a later task than dragstart

**Status:** Accepted, 2026-10-27. Supersedes the HTML drag-and-drop sequence of [0014](0014-act-tools-synthesize-pointer-input-in-the-page.md).

## Context

ADR 0014 had `drag` emulate HTML drag and drop in one synchronous run: dragstart and
pointercancel on the start, drag, then dragenter and one dragover on the end at its centre, then
drop if that dragover was cancelled or else dragleave, then dragend. A real Firefox drag spreads
these over many tasks: dragstart, then drag, dragenter and dragover as the mouse moves, then drop
and dragend.

On the SortableJS demo page (`https://sortablejs.github.io/Sortable/`, which serves SortableJS
1.15.6), `drag` from item 1 onto item 3 of the first list returned `mode: "html5"` and
`dropped: true`, but the list kept its order. We measured why in headless Firefox 156.0.1 with
the extension built from that sequence, with capture listeners on `document` logging each drag
event, its target and whether SortableJS's drag was active, and with SortableJS's `onStart`,
`onChange` and `onEnd` callbacks logged. The variants replayed the events from a page script
with the same event constructors, init dictionaries and a single `DataTransfer` of the page's
realm; the first variant reproduced the tool's result exactly. Each run was on a freshly loaded
page.

- `drag` as built, item 1 onto item 3, 1 onto 6 and 4 onto 1: no change. SortableJS saw
  dragenter and dragover while its drag was not active, and the drop ended it with no `onStart`
  and no `onEnd`.
- The same sequence with a task boundary (a timer of 0 ms, and of 20 ms) after dragstart and
  pointercancel: 1 onto 3 gave 2,3,1,4,5,6, 1 onto 6 gave 2,3,4,5,6,1, 4 onto 1 gave
  4,1,2,3,5,6. `onStart` ran in the boundary, `onChange` on the dragover, `onEnd` on the drop.
- No boundary, dragover at the 5 points of the pointer fallback's path: no change.
- A boundary, then dragover at those 5 points with no wait or a 0 ms timer between them: the
  item stopped one place short (2,1,3,...). With 16 ms between them every other dragover was
  ignored; with 50 ms it moved correctly, at 250 ms per drag.

SortableJS's dragstart handler starts its drag in a timer of 0 ms, its dragover handler does
nothing until that timer has run, and its drop handler cancels the timer. So the synchronous
run ended the drag before SortableJS had started it. One dragover at the end's centre is enough
once the drag has started, and synthetic events (`isTrusted` false) with a page-realm
`DataTransfer` work. After it moves an item, SortableJS ignores dragover for about 30 ms, which
is why dragovers close together along the path stopped it short. Its source also shows that the
timer that starts the drag applies its ghost class to the dragged item, which a page may style
to change the item's size and so move the items after it, and that its dragover does nothing
when the pointer lies outside the box the item under it has at that moment.

## Decision

In `drag` (`apps/extension/src/page-actions-dom.ts`), an HTML drag sends dragstart and
pointercancel as before, then waits `DRAG_START_MS` (20 ms) with a timer, then sends, in one
run, drag on the source at the start point, dragenter and dragover on the end element at the
end point, drop if that dragover was cancelled or else dragleave, then dragend. 20 ms was
measured to work; 0 ms also worked but would depend on the order of the content script's and
the page's timers. `drag` is now asynchronous.

The end element is the one located, with its refusals checked, before any event was sent; it is
not hit-tested again after the wait. The drop goes to the element that got the dragover, as the
HTML specification's current target element does. The end's events carry the end point moved as
far as that element moved since it was located, so they stay on it when the page changed its
layout meanwhile; when the element has no box left, they carry the point as located.

When the page cancels dragstart or breaks its `DataTransfer`, the pointer fallback runs as
before, in the same task as dragstart. `dropped` still says whether the end accepted the drop,
and the tool description now tells the agent that this does not show the page changed, so it
should read the page afterwards.

## Alternatives rejected

- **One synchronous run** (ADR 0014): measured to leave a SortableJS list unchanged.
- **Dragover at points along the way**, like the pointer fallback's 5 steps: measured to stop
  one item short with no wait between points, to lose every other dragover at 16 ms, and to
  take 250 ms per drag at 50 ms, for no measured gain over a single dragover at the end.
- **Hitting the end point again after the wait**: the result names the element the agent chose,
  and the covered, invisible and frame refusals were checked on that element.
- **Keeping the end point as located**: after a page moves the end element during the wait, the
  events would go to it with coordinates outside it, and SortableJS then does nothing.

## Consequences

An HTML drag takes about 20 ms longer, more in a background tab where Firefox delays timers.
Pages that react to the pointer passing over elements on the way, through dragenter and
dragleave along the path, still see none of that, and a page whose drag start waits longer than
20 ms still misses it: revisit when such a page is measured. Another act call on the same tab
made at the same time can now reach the page during the wait, as it already can during `type`'s.

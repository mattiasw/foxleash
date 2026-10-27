# 0014: click, hover, scroll and drag send full synthetic pointer sequences from the content script

**Status:** Accepted, 2026-10-20. Its rule that only http and https destinations are checked is superseded by [0018](0018-click-and-enter-refuse-destinations-outside-the-web.md), 2026-10-23. Its HTML drag-and-drop sequence is superseded by [0032](0032-html-drag-sends-the-ends-events-in-a-later-task.md), 2026-10-27.

## Context

Firefox gives extensions no way to produce trusted input, so `click`, `hover`, `scroll` and
`drag` can only dispatch synthetic events (`isTrusted` false) from Foxhand's content script in
the tab's top frame (ADR 0009). What a page reacts to then depends on which events arrive and
in what order.

Measured with `foxhand probe` in Firefox 159: Google Docs' title-bar menu button (a Closure
`goog-flat-menu-button`) ignored a lone `click` event, but opened and closed with pointerdown,
mousedown, pointerup, mouseup, click.

Measured in the pinned end-to-end Firefox, headless, with page-script events:

- A trusted mouse `pointerdown` has `pointerId` 0 and `pointerType` `mouse`. Before any trusted
  mouse input, `setPointerCapture` throws `NotFoundError` for both 0 and 1; after it,
  `setPointerCapture(1)` still throws and `setPointerCapture(0)` does not.
- A synthetic `click` on a light-DOM span slotted into a closed shadow root follows the root's
  link around the slot, and the span's `assignedSlot` is null, also for content scripts.
- A synthetic `click` on an SVG `a` whose only `href` comes from a SMIL `<set>` follows it:
  `href.animVal` holds it, with no attribute.
- A real click on an SVG `a` with an empty `href` navigates to the document's base URL, also a
  `<base>` on another site.
- A real click on an element whose `pointerdown` listener cancels it sends pointerdown,
  pointerup and click, with no mousedown or mouseup, and moves no focus.
- A synthetic `click` on a `label` submits the form of the submit button it labels.
- A `wheel` listener on `document` cannot cancel a synthetic wheel: Firefox makes wheel
  listeners on `window`, `document`, `html` and `body` passive.

A dispatched `click` runs the default action of links and submit buttons, so it can open a page
on a site the session never approved, which per-site approval (ADR 0007) exists to prevent.

Hover, wheel scrolling and drag were not measured on real sites.

## Decision

The four tools act on an element by ref from `read_page` or at a point in CSS pixels of the
viewport. The page code is in `apps/extension/src/page-actions-dom.ts`; the parsers, reply
checks and every pure rule below are in `apps/extension/src/page-actions.ts`.

- **Full sequences, always.** A click is pointer movement onto the element (out and leave
  events on the element the pointer was over, over and enter events on the new one, then
  pointermove and mousemove), then pointerdown, mousedown, pointerup, mouseup and click. Pointer
  events carry `pointerId` 0, `pointerType` `mouse` and `isPrimary`. A pointerdown the page
  cancels holds back the mousedown, the mouseup and, while the button is down, mousemove, as
  for a real press; the click still follows. An uncancelled mousedown
  focuses the nearest element in the hit's flat-tree chain that a click focuses (one with a
  valid `tabindex`, a kind focusable by default, or an editing host), or blurs the focused
  element when there is none, as a real one does. A shadow host that delegates focus passes it
  to the first element in its shadow tree that a click focuses, those with `autofocus` first,
  even when focus is already inside it, as Firefox does for a click. `focus()` alone is not the
  test: Firefox focuses a scrolling box, the page's root among them, from script but not from a
  click, and `focus()` on a host that delegates focus can pick one. Events are built with the
  page window's constructors and carry only primitives and page nodes.
- **The point.** A ref target is scrolled into view (`block` and `inline` `center`, instant)
  when not fully inside the viewport, or when something else shows at the centre of its visible
  part (a scrolling box around it that clips it, a fixed header over it), then acted on at the
  centre of the visible part of its first client rect that shows. The element at that point,
  found with `elementFromPoint` and descending into shadow roots, closed ones included, must be
  the element or inside it in the flat tree; else Foxhand refuses with `element_covered`,
  naming the covering element. An element with no visible part gives `element_not_visible`, a
  point with nothing gives `no_element_at_point`, and an `iframe`, `frame`, `object` or `embed`
  gives `in_frame`; `scroll` with no target sends its wheel to a frame at the viewport's centre
  as to any element. A refusal scrolls the page and the boxes around the element back to where
  they were. `drag` scrolls its start into view only when the end is a ref, since scrolling
  would move an end given as a point.
- **The flat tree, through closed slots.** Every upward walk (containment, focus, hover chains,
  the draggable search, scroll boxes, the cross-site check) uses `flatParentOf` in
  `flat-tree.ts`, which finds the slot of a closed shadow root by its assigned nodes.
- **No cross-site navigation by click.** Before a left click, and again just before each
  `click` event, Foxhand collects where the click could navigate from the hit's flat-tree
  chain: HTML `a` and `area` with `href`; SVG `a` by its animated `href`, its `href` and its
  `xlink:href`, an empty one leading to the base URL; MathML elements with `href`; submit buttons and image inputs through their form
  owner, by the button's `formaction` attribute, else the form's `action` attribute read
  through `Element.prototype.getAttributeNS`, else the document's URL; and a label's control and
  its chain, one level. Any http or https destination on another site refuses the click with
  `cross_site_navigation`, telling the agent to use `navigate`, which asks the user first.
- **Wheel scrolling by trying.** `scroll` with a direction sends a `wheel` event at the point,
  and unless it is cancelled calls `scrollBy` on each candidate in turn until one moves: the
  flat-tree ancestors of the hit whose overflow on that axis is `auto`, `scroll` or `overlay`,
  then the page unless the viewport's overflow is `hidden` or `clip`. The viewport's overflow
  follows CSS propagation: `body`'s when the root's is `visible` on both axes, and `body` is
  then no candidate of its own. Without a direction, `scroll` brings a ref into view.
- **HTML drag and drop, emulated.** `drag` presses at the start. When neither pointerdown nor
  mousedown was cancelled and the element there or an ancestor is `draggable`, it sends dragstart,
  pointercancel (a drag that starts cancels the pointer), drag, dragenter, dragover, then drop
  if dragover was cancelled or else dragleave, then dragend, with one `DataTransfer` made in the
  page's realm. Otherwise, and when the page cancels dragstart,
  it moves the pointer to the end in 5 steps and releases it there.

## Alternatives rejected

- **A lone `click` event, or `element.click()`.** Measured: Google Docs' menu button ignores it.
- **Clicking through a covering element**, by dispatching to the target anyway. A user's click
  would land on the cover, so the agent would see an effect no user could cause; refusing
  tells it to close the cover first.
- **Asking the user from the click** before following a link to an unapproved site. The page
  would have to wait mid-sequence for the answer while its own listeners can change where the
  click leads; `navigate` already asks through the approval prompt, and the refusal names the
  site so the agent can open the address with it.
- **The `formAction` IDL attribute** for a form's destination. Without a `formaction` attribute
  it returns the document's URL rather than the form's action, so a form posting to another site
  would pass the check.
- **`assignedSlot` for the flat-tree parent.** It is null for slots in closed shadow roots, so a
  link wrapping a slot in a closed root would escape the cross-site check.
- **Checking room left before scrolling** instead of trying. The scroll origin sits at the end
  for right-to-left, vertical-rl and reversed flex boxes, where `scrollLeft` and `scrollTop`
  run from negative to 0, so a room check picks the wrong box; trying needs no such model.
- **`pointerId` 1**, as earlier probes used. A page's `setPointerCapture` with it throws, since
  Firefox's mouse pointer is 0.

## Consequences

- The approval safeguard now has a wider exception: a page's own scripts can send the tab to
  another site after a synthetic click (a click handler that sets `location`, or one that
  rewrites a link inside its `click` listener), as a redirect can. The tab then shows a site the
  session cannot read, redacted in `tabs_list`. README and the add-on listing say so.
- Refusals err on the safe side: a `type=button` inside a cross-site link, a
  `formmethod=dialog` submit button and a link targeting a frame are refused too.
- Synthetic events set no CSS `:hover` or `:active`, so a menu shown only by `li:hover > ul`
  does not open; pages that check `isTrusted` do not react. The tool descriptions and the MCP
  instructions say so.
- The pointer and mousedown events of a click whose `click` is refused at the second check have
  already reached the page.
- Hover, wheel scrolling and drag were not measured on real sites; revisit the sequences when a
  site that should react does not.

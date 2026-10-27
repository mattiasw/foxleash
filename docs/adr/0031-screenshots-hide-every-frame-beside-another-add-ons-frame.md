# 0031: A screenshot hides every frame of the document that holds another add-on's frame

**Status:** Accepted, 2026-10-27. Supersedes, for another add-on's frames and the frames inside
them only, the rule of [0013](0013-screenshots-hide-credential-field-text.md) and
[0020](0020-screenshots-pass-over-frames-showing-an-error-page.md) that a frame refusing the
sheet refuses the screenshot.

## Context

ADR 0013 hides credential-field text with a user style sheet inserted into every frame
`webNavigation.getAllFrames` lists, and refuses the screenshot when any insert rejects; ADR 0020
passes over only a frame showing Firefox's error page. On Gmail with a compose window and a
password manager installed, the insert succeeded for six https frames and rejected (`Missing host
permission for the tab or frames`) for one child of the top frame showing the password manager's
own `moz-extension:` page, its in-field menu. `tabs.captureTab` of the same tab worked. So every
page where another add-on shows a frame of its own could not be captured.

No add-on can insert a sheet into another add-on's page, so the field mask cannot reach that
frame. Its content can be the user's saved logins, which are not the page's and are not covered
by the user's approval of the site. Firefox keeps another add-on's page out of `captureTab` only
when it is the tab's top document (Firefox `ext-tabs-base.js`); as a subframe it is painted
like any other frame.

`getAllFrames` gives each frame's `parentFrameId`. A sheet inserted with origin `USER` is a
document-level user sheet (Firefox `ExtensionContent.sys.mjs`, `windowUtils.addSheet`), which
applies inside shadow trees, closed ones included, and whose `!important` declarations no page
style, inline style or animation can override.

## Decision

When this screenshot's frame listing holds another add-on's frame, Foxhand inserts, with the
masks, into the frame whose document holds it, the sheet

```css
iframe, frame, object, embed, browser, editor { visibility: hidden !important; opacity: 0 !important; transition: none !important; }
```

and removes it with them. Every frame element of that document stays unpainted for the whole
capture, so nothing of the other add-on's frame, or of any frame inside it, is in the image.

The rule, decided from the listing before anything is inserted:

1. A frame is **another add-on's frame** when its id is not 0, its `url` parses, its protocol is
   `moz-extension:`, its host is not empty, and its host differs from Foxhand's own
   (`runtime.getURL("")`). Protocol and host are compared, not the origin, which URL parsers
   outside Firefox give as `"null"` for this scheme. When Foxhand's own host cannot be read, no
   frame is another add-on's.
2. From each frame, Foxhand walks up `parentFrameId` through the listing to frame 0, at most as
   many steps as the listing has frames. The parent of the top-most other add-on's frame on the
   walk takes the hiding sheet, once per document. That parent is never itself another add-on's
   frame or inside one, so Foxhand can style it. A walk that met another add-on's frame and then
   meets a parent missing from the listing, or goes round, refuses the screenshot before any
   insert; so does a listing naming a frame id twice beside such a frame.
3. A frame is **hidden** when it, or a frame on its walk, is another add-on's frame. A walk that
   breaks before meeting one leaves the frame not hidden and refuses nothing by itself.
4. The field mask still goes into every frame, and the input mask into the top frame when a
   password field was revealed. The hiding sheets share the masks' marker, their timeout, the
   checks that the screenshot has not answered already, and the removal of each sheet once its
   own insert settles.
5. A subframe's rejected field mask is passed over when the frame shows Firefox's error page
   (ADR 0020, unchanged) or is hidden. A rejected hiding sheet is never passed over. All inserts
   are awaited together, so a hidden frame's rejection is passed over only when every hiding
   sheet went in. Every other rejection refuses with `screenshot_failed`, without Firefox's
   error text.
6. With no other add-on's frame in the listing, nothing changes: no hiding sheet, the same
   calls and the same image.

Why these declarations: `visibility: hidden` keeps the subdocument from being painted at all;
`opacity: 0` is a second, independent path in case a hidden subdocument is ever painted;
`transition: none` because a page's transition beats `!important` declarations (ADR 0013
measured it for `color`), and a `transition: all 60s` on a frame element would otherwise keep it
visible for 60 s. Type selectors only, with no namespace, so they match in any namespace (a frame
inside SVG `foreignObject`) and inside shadow roots. `iframe`, `frame`, `object` and `embed` are
the HTML elements that embed a frame (Firefox `child/ext-runtime.js`); `browser` and `editor` are
the other names of Gecko's XUL frame element. A page is not expected to be able to give a XUL
element a frame, and hiding an element with those names only removes page content from the image.

The rule is `apps/extension/src/foreign-frames.ts`, the sheet `FRAME_HIDE_CSS` in
`apps/extension/src/screenshot.ts`, and the inserts and the excuse are in `maskedCapture` in
`apps/extension/src/handlers.ts`.

A security analysis of this design, carried out before it was built, looked for any input that
would bring another add-on's frame into the image. Under this design the excuse can only make a
frame's content absent from the image, never present: a rejected frame is passed over only when
it is, or lies inside, another add-on's frame whose embedding document took a sheet that keeps
all its frame elements unpainted, and every other rejection still refuses. The URL test only
scopes the change; it adds no safety, since a hidden frame shows nothing. The page cannot
override or race the user `!important` sheet, which is in place for the whole capture.

## Alternatives rejected

- Capturing the other add-on's frame as it is: the user's saved logins would reach the agent.
- Refusing with a clearer message: such pages, Gmail among them, would stay unusable.
- Finding the frame's element in its parent, measuring its box before and after the capture, and
  painting that box over in the image. The analysis found four gaps. An SVG filter
  (`feOffset`, `feTile`) or `drop-shadow()` on `body`, `html` or a shadow host, all page DOM even
  when the frame sits in a closed shadow root, paints the frame's pixels elsewhere in the image,
  outside the painted box. The page can tell a screenshot has started (a protected field turns
  transparent), and measuring, capturing and measuring again are separate tasks with page tasks
  between them, so a page that moves the frame (`Element.moveBefore` moves it without a reload)
  after the first measurement and back before the second wins some of its attempts. `captureTab`
  draws at scale times page zoom, so CSS-pixel boxes are wrong at any zoom but 100 %, and pinch
  zoom, nested transforms (a rotation by 180 degrees keeps the box's size) and scrolling between
  nested frames are further unmeasured geometry. And it needs a script in a subframe, which ADR
  0009 rules out.
- `iframe[src^="moz-extension:"]`, which would spare the page's own frames: a page can change or
  remove a frame's `src` attribute without the frame loading a new document, so the selector stops
  matching while the other add-on's page stays.
- `display: none`: it changes layout, so the image would not show the page as laid out and a `ref`
  box measured before the capture would no longer fit its element; an `object` or `embed` that is
  not displayed can also reload. `visibility` and `opacity` change no layout.
- Passing over every frame that refuses the sheet, PDF frames included: the same argument would
  make it safe with the hiding sheet, but it widens the change; PDF frames still refuse.

## Consequences

Each gap fails closed, refusing the screenshot (`screenshot_failed`, or `page_timeout` at the
deadline):

- The top frame refusing the sheet.
- A rejected subframe that is neither showing Firefox's error page nor hidden: an https,
  `about:blank`, `data:` or PDF frame, a frame of Foxhand's own pages, and a PDF frame in the same
  document as another add-on's frame.
- Another add-on's frame whose way up to the top frame is broken or goes round in the listing.
- A hiding sheet rejected, or still pending at the capture timeout.
- The screenshot answering before the inserts or the capture (unchanged).
- Any frame loading a new document during the screenshot (unchanged; the frame watch also sees
  another add-on's frames, since `webNavigation` events are not filtered by the frame's origin).
- Another add-on's frame on a `blob:` or `data:` document: the rule names `moz-extension:` frames
  only.

Accepted without failing closed:

- Every frame of that document is blank in the image, with what lies behind it shown, such as a
  payment frame beside a password manager's menu. When the other add-on's frame is in a subframe,
  only that subframe's frames are blank.
- Those frames disappear for the user while the screenshot is taken, so repeated screenshots
  make them blink; a screenshot takes several round trips, so more than three a second is not
  expected. Hiding a frame that has focus may move focus out of it (hypothesis), and
  `transition: none` ends any transition running on those frames. Once the sheet is removed, a
  page's own transition on a frame element runs from the hidden state, so with a long opacity
  transition those frames fade back in slowly (not measured).
- A failed removal leaves that document's frames hidden until it reloads, as with ADR 0013's
  masks.
- The other add-on's frame may notice that it is hidden for that time (hypothesis: a password
  manager could close its menu).
- A page can still tell that a screenshot is being taken (unchanged).
- Another installed add-on could insert its own user sheet to show the frames again; an installed
  add-on with access to the page can already read its fields, so it is outside the threat model,
  in which the page is the threat.

Verified in Firefox 156 by the end-to-end tests: the user sheet reaches a frame in a closed shadow
root; a hidden out-of-process frame embedded by an `iframe` is absent from `captureTab`'s image;
the page's transition, animation and SVG filter copy, measured to copy the frame's pixels when it
is not hidden, do not bring it back; only the holding document's frames are hidden. `object`,
`embed`, `frame`, `browser` and `editor` are in the selector but not measured: Firefox 156 was
measured not to draw another add-on's page in an `object` or `embed` that the add-on's content
script adds to a web page, so the tests cannot show such a frame being hidden.

Revisit when a Firefox version paints hidden subdocuments or stops applying user sheets in shadow
trees (the end-to-end tests would fail), or to widen the excuse to other frames Foxhand cannot
enter.

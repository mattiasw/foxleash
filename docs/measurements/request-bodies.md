# Request bodies

Measurements behind [ADR 0085](../adr/0085-request-bodies-are-read-only-in-session-tabs-within-a-time-allowance.md).

## Shaping and delivering large bodies (2026-11-18)

Measured with Foxleash in Firefox 156.0.1:

- A 16,700,019-byte flat JSON body takes 1.1 to 1.3 s to shape.
- A page with no agent session that sent 100 `text/plain` form POSTs of that body, one every
  100 ms, kept the background busy for 119 s, and the extension process grew from 229 to
  2,348 MiB.
- With one session, and the page in a tab outside it, one `tabs_list` took 42,278 ms during a
  burst of 40 such submits.
- In a recorded tab, one such body sent with `fetch` made `tabs_list` take 1,336 ms.

Measured in Firefox 160.0.1, headless, with a test add-on that runs the same `bodyShape` behind
one non-blocking `onBeforeRequest` listener with `["requestBody"]`. It compared shaping in the
handler (the code before ADR 0085), a queue that holds two bodies and shapes one per zero-delay
timer, and a time allowance, which it ran at 100 ms:

| What was sent | In the handler | Queue of two, one per timer | Time allowance |
|---|---|---|---|
| 3, 6, 12 and 50 small JSON bodies at once (`Promise.all` of `fetch`), five runs each | all shaped | 2 shaped in every run; 1, 4, 10 and 48 left as `other` | all shaped in every run |
| 16,700,015-byte flat JSON bodies, one every 100 ms (one run each) | 8 bodies: a 10 ms timer in the background did not run for 9,281 ms, and a body took up to 1,458 ms | 20 bodies: 5 shaped, 15 `other`; background blocked 6,604 ms of 8,268 ms; five awaited `tabs.query` calls in a row took 2,505 to 5,183 ms (four samples) | 20 bodies: 1 shaped, 19 `other`; blocked 1,692 ms of 8,291 ms, 1,365 ms at most at a time; the same five calls took 4 to 283 ms (four samples) |

With the same test add-on, a listener that reads nothing of a body still costs the background
time for each body Firefox delivers to it:

- A 16,777,216-byte JSON body holding one string: the background's 10 ms timer did not run for 46
  and 61 ms (two runs; 11 to 12 ms when idle). Shaping that body took 51 ms.
- A 1,000,000-byte urlencoded body of 111,112 names: 83 and 71 ms without shaping, 45 ms to shape.

Not measured: whether a page that sends such bodies faster than the background takes them in can
make tool calls wait through the delivery alone.

## A form of many names while a session runs (2026-11-20)

Taken before the per-tab listeners, while one `<all_urls>` listener asked for bodies whenever a
session ran. A page held a `<form method=post>` of 111,112 hidden inputs `k<n>=v`: 1,000,000
bytes urlencoded, under the 1,048,576 bytes up to which Firefox parses a form's fields, so Firefox
parsed every name. It submitted the form every 50 ms to a local address that answered 204, 100,
300 or 600 times. Firefox ran headless. The resident plus swapped memory of Firefox's extension
process (and of the page's process for the run with no add-on) was sampled from before the burst
until the processes went quiet, and a stop killed Firefox once its processes together passed a
memory limit, for one process or for all of them together.

| Firefox | Where the page was | Submits | Extension process | Notes |
|---|---|---|---|---|
| 160.0.1 | a tab outside the session | 100 | 221 to 662 MiB | 95 POSTs reached the server; `tabs_list` took 809 ms at worst |
| 160.0.1 | any tab, Foxleash installed, no session | 100 | 143 to 143 MiB | 100 POSTs |
| 156.0.1 | a tab outside the session | 600 | 207 to 3,160 MiB, linear | stopped when one process passed 3,072 MiB, 45 s after the burst began |
| 160.0.1 | a tab outside the session | 600 | 230 to 3,158 MiB | stopped after 40 s; `tabs_list` took 1,464 ms at worst |
| 156.0.1 | the session's own tab | 300 | 270 to 2,369 MiB | stopped at 4,096 MiB in all after 25 s |
| 156.0.1 | one session running; which tab was not recorded | 100 | 200 to 1,286 MiB | grew on for 13 s after the last submit; still 1,283 MiB 6 s after the processes went quiet |
| 156.0.1 | no add-on installed | 300 | none | only the page's own process grew, 239 to 1,108 MiB |
| 156.0.1 | any tab, Foxleash installed, no session | 100 | 140 to 141 MiB | |

Not measured: whether the memory is freed later than 6 s after the processes went quiet, growth
past 3 GiB, other rates, `fetch` instead of form submits, and Firefox 153.7.0esr.

## This change on Firefox 160.0.1 (2026-11-20)

Taken with the end-to-end tests in `e2e/network-burst.test.ts`, in headless Firefox 160.0.1, for
four builds of the extension: the one before the per-tab listeners ("before"), the per-tab
listeners with a rest that removed every body listener for up to 10 s once a body arrived 1,000 ms
late ("rest at 1 s"), the same with that limit at 250 ms ("rest at 250 ms"), and the final one
("this change"). The rest is not part of the change (see ADR 0085); the per-tab listeners are the
same in both rest builds and in the final one.

The page's form held 111,112 hidden inputs `k0` to `k111111` with the value `v`: 1,000,009 bytes
urlencoded. The page submitted it to a fixture route that answers 204, asked for one submit every
50 ms; it managed about six a second. The tests found Firefox's extension process with
`ChromeUtils.requestProcInfo()` and sampled its resident plus swapped memory (`VmRSS` plus
`VmSwap`) every 250 ms, from just before the first submit until 10 s after the last, or until the
test's wait ended. Growth is the peak minus the first sample. A guard killed Firefox once its
processes together passed 6,144 MiB.

The form, from a tab outside the session, while a session ran. These runs took 100 submits, in the
first version of the test:

| Build | Extension process | Growth | By second (MiB) |
|---|---|---|---|
| before | 399 to 1,108 MiB | 709 MiB, over the test's bound of 150 | 0s 399, 4s 454, 8s 630, 12s 763, 16s 1,095, 17s to 25s 1,060 |
| rest at 1 s | 344 to 346 MiB | 2 MiB | between 329 and 346 for 27 s |
| rest at 250 ms | 343 to 344 MiB | 1 MiB | the page's 100 submits took over the test's 20 s wait |

The test now sends 50 submits, which took the page about 8 s in both runs below. "This change"
ran it in the whole end-to-end suite, 536 tests, all passing, one of them a todo. "Before" ran it
alone, with the test as it is now, and failed it: "the extension's process grew by 383 MiB, over
150 MiB".

| Build | Extension process | Growth | By second (MiB) |
|---|---|---|---|
| before | 151 to 534 MiB | 383 MiB, over the test's bound of 150 | 0s 151, 2s 289, 4s 366, 6s 416, 8s 518, 9s to 17s 505 to 508 |
| this change | 346 to 347 MiB | 1 MiB | 0s 346, 3s 347, 9s 345, 10s to 17s 329 |

The same form from a session's own tab, 200 submits:

| Build | Extension process | Growth | By second (MiB) |
|---|---|---|---|
| before | 1,058 to 3,028 MiB in 22 s | 1,970 MiB, about 90 MiB a second | then the guard killed Firefox |
| rest at 1 s | 330 to 1,968 MiB in 25 s | 1,638 MiB, still rising when the wait ended | 0s 330, 6s 360, 8s 589, 12s 981, 16s 1,285, 20s 1,559, 24s 1,949 |
| rest at 250 ms | 339 to 1,471 MiB in 25 s | 1,132 MiB, still rising when the wait ended | 9s 378, 12s 651, 16s 999, 20s 1,221, 24s 1,390 |

So a page in a session tab that keeps posting such a form grows the extension process by about 60
to 90 MiB a second for as long as it sends, with or without the rest; the figures of the session's
own tab in the earlier section (270 to 2,369 MiB for 300 submits on Firefox 156.0.1) agree.

Twenty `fetch` POSTs of 6,000,000 bytes of JSON, one every 100 ms, from a session's tab:

| Build | Shaped | `other` | No body | Growth |
|---|---|---|---|---|
| before | 3 | 17 | 0 | 208 MiB |
| rest at 1 s | 3 | 17 | 0 | 238 MiB (152 to 390 MiB); `tabs_list` took 470 ms at worst |
| rest at 250 ms | 2 | 0 | 18 | 190 MiB |

With the rest at 1 s, the other tests in `e2e/network-burst.test.ts` and `e2e/network.test.ts`
passed, among them 20 small bodies sent at once that all kept their shapes, and 57 `tabs_list`
calls during large form posts from a tab outside the session, the slowest 31 ms.

Not measured: the final build's growth with the many-names form from a session's tab, where it
delivers bodies as the rest builds do between rests; why the deliveries outrun the background; and
Firefox 153.7.0esr and 156.0.1 with the per-tab listeners.

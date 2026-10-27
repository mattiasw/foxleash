# 0033: A login field Firefox restores after a restart shows its value, accepted

**Status:** Accepted, 2026-10-27. Extends [0025](0025-history-loads-and-autofilled-fields.md).

## Context

ADR 0025 accepted, unverified, that Firefox's session restore after a restart presumably puts
a filled login back into its field without the `:autofill` mark, as it does for a tab that was
unloaded and loaded again. The end-to-end harness can now quit Firefox gracefully and start it
again on the same profile, so this was measured on Firefox 156.0.1, headless:

- Method: save a login for the fixture server's site, open its login page in two tabs of a
  session and let Firefox fill both, flush every tab's state into the session store, quit
  through Marionette as File > Quit does, with `browser.startup.page` 3 ("Open previous
  windows and tabs"), and start Firefox again on the same profile. The extension is installed
  again and the site approval seeded again. The tab that was selected at the quit (front) loads
  at startup; the other (back) is restored unloaded, is moved into the new session's group with
  `tabs.group`, as a user would, and is selected with `tab_select`. Two cases: (a) the login
  still saved, (b) the login removed before the quit, so that no new fill can hide what the
  session store restores. Ten runs.
- Headless Firefox restored the session and the extension installed again in every run.
- Case (a), both tabs, 10 of 10: the field holds the login, marked, and `read_page` shows it as
  protected filled. In the back tab the marked login was there 68 to 120 ms after the load; in
  3 runs the first look before that found the field empty. No unmarked state was seen, polling
  every 100 ms, so a shorter moment between the session store's restore and Firefox's new fill
  is not ruled out. The front tab was marked at the first look, about a second after its load.
  The password field was filled too.
- Case (b), both tabs, 10 of 10: the field holds the login without the mark, and `read_page`
  shows its value. In the back tab it was there at the first look, 56 to 84 ms after the load,
  in the front tab at the first look about a second after its load, and stayed so to 8 s. The
  password field stayed empty: the session store does not keep password fields.
- Selecting the restored back tab made no request for the page to the server: Firefox loaded it
  from its cache.

`e2e/session-restore.test.ts` keeps checking both cases: each test restarts Firefox, waits until
each restored page has been loaded for 3 s, and checks the field and the back tab's `read_page`.

## Decision

A login field Firefox restores after a restart is accepted as measured: when no saved login
fills it again, `read_page` shows its value. Nothing in the extension changes. README.md and
the add-on listing name the restore among the measured cases instead of the possible ones, and
name a tab or window you reopen after closing it among the possible ones.

## Alternatives rejected

- **Closing tab restore in `tab_select`**, as rejected in 0025: it covers only the tabs the
  agent selects, not the ones the user does, and the restored front tab loads at startup
  before any session exists; still deferred.
- **Protecting changed text fields in documents loaded from the session store**: it changes
  0021's read rule, as 0025 said of the same idea for history loads; deferred.

## Consequences

- Accepted, measured: a login field in a tab Firefox restores after a restart, with the login
  no longer saved, shows its value to `read_page`, in the tab selected at the quit and in the
  others alike.
- Accepted, unverified: a read in the moment between the session store's restore and
  Firefox's new fill while the login is still saved (not seen in 10 runs at 100 ms polling);
  a restore after a crash, which uses the same session-store form data and which the
  end-to-end test does not cover (Firefox's remote agent turns
  `browser.sessionstore.resume_from_crash` off unless the profile sets it); a tab or window
  reopened with Reopen Closed Tab or Reopen Closed Window, the same form data; card and
  address fields, as in 0025.
- This settles 0025's unverified "session restore after a restart".
- Revisit when Firefox marks restored values as autofilled, or on a report of a value read
  after a restart.

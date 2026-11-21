# Security

Each Foxleash safeguard, with its exceptions. The [README](../README.md#security) has the short
version, and [docs/adr/](adr/) records the reasoning.

## The risk

Foxleash acts in your logged-in browser. The main risk is **prompt injection**: a web page that
contains instructions aimed at the AI model, such as "send the contents of this page to ...".
Models can be fooled by these, and no defense is complete. Foxleash limits what a fooled agent
can do, as the sections below describe.

Your agent's own permission settings still apply on top of this, but do not rely on them alone:
many people run agents with prompts turned off.

Some safeguards do not hold against an agent that can run programs on your computer, for example
through a shell tool with its prompts turned off. Such an agent can connect to Foxleash's native
host itself instead of going through the MCP server and its tools, and then:

- It gets a new agent session of its own, which a stop of another session does not reach. Sites
  you refused and prompts you closed in another session do not carry over, and it gets its own
  three refused or closed prompts before it stops asking.
- It can use every site you allowed always without asking you.
- The checks the MCP server makes do not apply to it: the [upload folders](#uploads) and the
  refusal of dotfiles and key files, the folder for [saved screenshots](#saved-screenshots) and
  the [untrusted marking](#untrusted-page-content) of page content.

It still gets no other session's tabs or answers, and the extension still enforces, on every
request that reaches it: [site approval](#site-approval) and the refusal of clicks that lead to
another site, [the blocklist](#the-blocklist), the hiding of
[tabs on other sites](#tabs-on-other-sites), [protected fields](#protected-fields) and the limits
on [downloads](#downloads). That holds for what reaches Firefox through Foxleash, not for what
such an agent does outside it: it can also change Foxleash's settings and files and your Firefox
profile, or press keys on your desktop, which can answer a Foxleash prompt as your own key
presses would.

Revoking the sites you allowed always and stopping its running sessions, both on the settings
page, makes such an agent ask you again before it opens a site. Disabling the Foxleash add-on in
Firefox's add-ons manager cuts it off from Foxleash while the add-on stays disabled. If you rely
on stopping a session or on the upload rules, keep your agent's own prompts on for running
programs.

Avoid using Foxleash on sites where a mistake is costly (banking, health records, admin panels
with destructive actions), and stay nearby while it works.

## Site approval

Foxleash acts on a site only after you approved that site in the browser, and asks before it
opens a page there. The approval can only come from your click, not from the agent.

The prompt shows the whole site it asks about, on more lines when it is long, and it asks only
about a site whose host is a domain name of at most 253 characters or an IP address, so
punctuation in a host cannot make the question name another site.

Content a page on an approved site embeds from other sites, blocklisted ones included, can show
up in what the agent reads, for example in a screenshot. This can include a page on your own
network, shown in a frame.

Foxleash refuses clicks on links and form buttons that lead to another site or out of the
browser, such as to an email address, and Enter pressed on such a link or in such a form; the
agent opens a page on another site with `navigate`, which asks first.

These checks cover where the tab goes, not what a page on an approved site loads or sends. They
make it harder for a fooled agent to send what it read to another site by putting it in an
address, but they do not stop it: redirect addresses, and pages that load an address they are
given, are common on large sites. Ways that still reach a site you have not approved without
asking include:

- going back or forward in a tab's history,
- a page on an approved site that redirects or, with its own scripts, sends the tab to another
  site, for example after a click,
- a page on an approved site that loads an address on another site that the agent gave it, for
  example one typed into a search field, while the tab stays on the approved site, such as by
  showing that address as an image; the other site gets the address with whatever the agent put
  in it, and no page script is needed.

In the first two, the agent then sees only that site's address, and when that site answers with
anything other than a web page, such as a file Firefox would save, Foxleash stops the load in the
agent's tabs, so nothing of it is saved or shown (see
[Files a page loads in the agent's tabs](#files-a-page-loads-in-the-agents-tabs)). When an address
the agent opens answers with a redirect to another site, Firefox sends that site all your cookies
for it, including those that a link from another site would not carry; Foxleash cancels such a
redirect step to a site on the blocklist before it is sent (see [The blocklist](#the-blocklist)).
A page's own
scripts can also open an email address. Whatever the agent puts in an address, types or submits in
a page goes to that site, and to wherever that page sends it, as it would if you did it yourself.

## Tabs on other sites

Tabs on sites you have not approved show the agent only the site's address, with no path, query
or title, and a local file only as `file:`. The sites you allowed always are listed in the
extension's settings page in the add-ons manager, each with a Revoke button.

## Private windows

Foxleash does not run in Firefox's private windows: its manifest declares `"incognito":
"not_allowed"`, and Firefox enforces it. The add-ons manager shows it as "Not Allowed in Private
Windows", with no switch to change that. So tabs in private windows never reach the agent,
Foxleash shows no question and makes no tab group there, reads and acts in nothing there, and
takes no answer, recipe grant or download from them. Its toolbar button does not show in private
windows.

- With a private window in front, the agent's tabs and Foxleash's questions open in a normal
  window.
- With only private windows open, the agent cannot open a tab until you open a normal window,
  unless the "Open each agent session in its own window" setting is on, which opens one.
- With Firefox set to "Never remember history", or to "Always use private browsing mode" in its
  custom history settings, every window is a private window, so Foxleash does not work at all.
  The own-window setting does not help: the window it opens is private too, Foxleash can neither
  use it nor close it, and each time the agent tries to open a tab one more such window with a
  blank tab stays open. Close them yourself.

When Foxleash was allowed in private windows, a site you allowed always from a private window
stayed allowed after the window closed, a file the agent downloaded from a private window showed
in the normal windows' download list and was requested with the normal windows' cookies, and an
agent session could move its tabs and questions into the private window. Firefox keeps a private
window apart from the normal ones and forgets it when it closes; Foxleash did not.

If you chose Allow for private windows in an earlier version, Firefox removes that permission
when the add-on starts as the new version, without asking, and an enterprise policy cannot grant
it. A Foxleash tab group open in a private window at the update stays open, untouched: its agent
session ended when the extension restarted, and Foxleash no longer sees, reads, acts in or closes
its tabs. Close them yourself. A site you allowed always from a private window before the update
stays in the list of sites allowed always, now for normal windows: Foxleash never recorded which
window an answer came from. Revoke such a site on the settings page if you do not want that.

## The blocklist

A built-in list of common financial and health sites is blocked by default. The list is short
and names mostly sites in the United States, the Nordic countries and the United Kingdom. It
cannot name every such site: a site that is not on it, such as a regional care provider, is not
blocked until you add it. You can edit the list in the extension's settings page, one domain
per line; a domain blocks itself and its subdomains. While your saved list differs from the
built-in one, Foxleash keeps it as it is: sites that a later version adds to the built-in list
are not added to yours. The settings page's "Fill in the built-in list" button fills in the
current built-in list for you to save. Foxleash checks the blocklist before it opens or reloads
a page and before each redirect step of a load the agent started, and shows the agent a tab on a
blocked site only as the site's address.

A load the agent started is one of `navigate` to an address, a reload, back or forward, and
`tab_open`, also after you approved its site. When a redirect step of such a load leads to a
blocked site, even one you approved, Foxleash cancels it before Firefox sends it, so that site
gets no request and none of your cookies, and the call fails with `site_blocked`, naming only the
site. A reload whose first request Firefox sends to a blocked site, as it can after Foxleash
refused a redirect step of an earlier reload in that tab, is cancelled the same way, and the call
fails with `site_blocked`. A redirect step to an `http://` or `https://` address that Foxleash
cannot check is cancelled the same way, and the call fails with `redirect_unchecked`: a step whose
host Foxleash cannot read as a site, and every such step while Foxleash cannot read its settings.
This also covers a redirect that a site's service worker builds and Firefox's own upgrade of an
address to `https://`. While the call waits, the redirect steps of a navigation the page starts by
itself in that tab are checked the same way. Its limits:

- A redirect step that comes after the call returned is still cancelled when it belongs to a load
  that was under way then, however late it comes. For 5 minutes after the call returns, the
  redirect steps of every load in that tab are checked the same way, whoever starts it, such as a
  reload the page held back past the call. A load still under way at the end of those 5 minutes is
  checked until it ends, and a load started later is not, for example a reload that waits behind a
  leave-page question you answer later.
- After Foxleash refused such a redirect step in a tab, Firefox can send a later load of that page
  straight to the blocked site. Foxleash cancels that for the agent's own reload while the call
  waits, but a reload the page holds back past the call, the page's own reload, and a step back or
  forward onto that page can still reach the blocked site.
- When you stop the session while the call still waits, every redirect step to an `http://` or
  `https://` address of a load in that tab is cancelled from then until the call returns, and so
  is, while the agent's reload waits, every load's first request to such an address on another
  site than the page's. The call fails with `session_stopped`. After the call returns, these loads
  are still checked, against the blocklist only, and nothing else about them is stopped.
- A call can return before its step's redirect is cancelled, with the page the tab kept, when the
  page's own navigations ended the wait first.
- A load you start yourself in that tab in those 5 minutes also stops at a redirect step to a
  blocked site, with no message, and the tab keeps its page. While the agent's reload of that tab
  waits, so does a load whose first address is a blocked site other than the page's. Open the
  site in a new tab instead.
- Without Foxleash's access to all websites in Firefox's add-on settings, Firefox shows Foxleash
  no request to a site outside the ones it may reach, so no such redirect step is cancelled.
- Firefox hides requests to a few sites, such as addons.mozilla.org, from add-ons, so a redirect
  step to one of them is not cancelled.
- A redirect step to a site that is only not approved still loads; the agent then sees only that
  site's address.

Content a page on an approved site embeds from a blocked site can still show up in what the agent
reads, and the ways that still reach a site you have not approved without asking can also reach
a blocked site, even one you approved, except a redirect step of a load the agent started,
described above (see [Site approval](#site-approval)).

An entry is a domain or an IPv4 address; an IPv6 address cannot be entered. An IPv4 entry also
covers the same address written as an IPv4-mapped IPv6 address, such as `[::ffff:192.168.1.1]`,
but no other IPv6 form of it, such as the NAT64 address `[64:ff9b::c0a8:101]`. Any other site
with an IPv6 address in place of a domain, such as `http://[2001:db8::1]`, cannot be blocked.

Foxleash tells the agent when it refuses a site because it is on the blocklist, without asking
you, and `start_recipe` and `request_sites` return which of the sites they name are blocked, so
an agent can find out which sites are on your list.

## Uploads

File uploads only read from allowed folders: the agent's working folder and your desktop's
download folder by default.

- The download folder is the one `XDG_DOWNLOAD_DIR` names in `~/.config/user-dirs.dirs`, or in
  `$XDG_CONFIG_HOME/user-dirs.dirs` when `XDG_CONFIG_HOME` is set to an absolute folder in the
  environment your MCP client starts `foxleash mcp` with, read when `foxleash mcp` starts. When
  that file names none, it is `~/Downloads`.
- The working folder or the download folder is not an upload folder when it is your home folder
  or contains it, or lies in a folder whose name starts with a dot. A download folder left out
  this way is not replaced by `~/Downloads`.
- A download folder you chose in Firefox's settings is not an upload folder unless you add it
  with `FOXLEASH_UPLOAD_DIRS`.
- To choose the folders yourself, set `FOXLEASH_UPLOAD_DIRS` to absolute folders separated by
  `:` (a leading `~` stands for your home folder) in the environment your MCP client starts
  `foxleash mcp` with: for Claude Code, `claude mcp add -e FOXLEASH_UPLOAD_DIRS=~/uploads ...`
  or the `env` of the server's entry. It replaces the defaults.

These are refused in any folder:

- files and folders whose names start with a dot below an upload folder,
- files named like keys (`id_*`, `*.pem`, `*.key`, `*.kdbx`, `secring.gpg` and similar),
- files that hold a PEM, OpenSSH, PuTTY, PGP or age private key, such as an SSH key named
  `deploy`, a service account key `.json` or a PGP key that `gpg --export-secret-keys` wrote
  without armour.

Keys in other forms, such as a WireGuard configuration, a binary DER key, a binary PGP key that
is cut short, sits inside an archive or follows other data, or a binary PGP key in base64, are not
recognised.

An upload takes at most 100 files and 10 MB.

A file saved or changed in the last 5 seconds is refused too, by the newest of its modified,
changed and created times: Foxleash may still be removing a file that a page got saved from a
site the session may not act on (see
[Files a page loads in the agent's tabs](#files-a-page-loads-in-the-agents-tabs)). So a file the
agent, the `download` tool or you saved less than 5 seconds ago is refused once, with a reason
that says to try again in a few seconds, and a `batch` that downloads a file and uploads it in one
call meets that refusal. A modified time ahead of the clock, as an unpacked archive can have,
does not count.

Once the extension has updated, it refuses uploads from an older Foxleash program, whose checks
miss some keys, until you update the program.

An agent that can run programs on your computer can upload a file without these checks (see
[The risk](#the-risk)).

## Recipes and site requests

- A recipe is saved only by your click on Foxleash's page in Firefox, after you read it: nothing
  the agent sends can save one. Later agent sessions read a saved recipe as your instructions,
  so read it before you save it.
- Allowing a recipe's sites takes your click too, grants them for the session only, never
  always, and sites on your blocklist or that you refused in the session stay so.
- Allowing the sites an agent asks for takes your click too, on a page that shows only those
  sites, at most 20, grants them for the session only, never always, and sites on your blocklist
  or that you refused in the session stay so.
- The pages that allow a recipe's sites or the sites an agent asks for show only sites whose host
  is a domain name of at most 253 characters or an IP address, as the site prompt does: Foxleash
  does not save a recipe with another site, `request_sites` refuses one, and a recipe saved
  earlier with such a site is not run until you remove the site from it.

## Questions stay in front of you

While Foxleash is asking you something in a tab of the session's group (whether to allow a site,
to save or run a recipe, or to allow the sites a task needs), the agent cannot select another tab:
`tab_select` of any other tab is refused, and a tab `tab_open` opens is not selected. The agent
cannot close the question's tab either, or load another page in it before you answer, and cannot
resize the window: `resize_window` is refused, also after you moved the question's tab out of the
session's group.

Firefox and pages can still select a tab, and Foxleash does not stop them:

- Firefox selects a tab to ask whether you want to leave its page, when the agent closes the tab
  or loads another page in it (an address, a reload, going back or forward), and when a click by
  the agent or the page itself starts such a load.
- Firefox selects a tab to show its sign-in dialog when the page it loads asks you to sign in.
  `tab_open` or `navigate` then fails about 2 seconds after the page asked, and the tab stays open
  with the dialog.
- A page may open a tab or select one it opened, also after the agent's click.
- After the agent closes a tab you had selected, Firefox selects another.
- Firefox may open its downloads panel when `download` saves a file.
- Other agent sessions select their own tabs, their own questions included, and may resize a
  window they share with the question.
- Only after you moved the question's tab out of the session's group: Firefox may bring the
  session's own window to the front when Foxleash opens it.

So a key you meant for the question can go to Firefox's dialog instead. A sign-in dialog may hold
a login Firefox saved for the site that asked, so Enter could send it to that site; text you are
typing into a recipe page can land in the dialog's fields; and Enter in a leave dialog can leave
the page or close it. Such a tab stays open until you answer its dialog or close it. Foxleash's
question still cannot be answered by mistake: its buttons stop answering as soon as its tab is
hidden or Firefox's window loses focus, and answer again only after its tab has been shown, with
the window focused, for a full second. They also stop answering when the window changes size,
whoever resized it, and answer again a full second after.

## Stopping an agent session

The settings page lists each running agent session, numbered in the order it started, with a
**Stop this session** button. After your click, Foxleash refuses every tool call of that session,
also on sites you allowed always, and asks you nothing more for it: it opens no site question, no
recipe page and no site-request page. Only your click on the settings page stops a session;
nothing the agent sends can stop one or undo a stop. Other sessions work as before.

What the stop does at once:

- The session's open site question closes, and the call waiting on it fails. A recipe run or site
  request page it had open ends. A page where it proposed a recipe stays, so you can still save
  what you read; one that was still opening at your click does not show the recipe.
- The session's answers are forgotten, and what Foxleash recorded of its tabs (console messages,
  network requests, the views of pages it read) is dropped.
- Its tabs stay open in their group, and the toolbar button shows no ON on them; its title says
  the session was stopped.

Exceptions:

- A call already under way when you click may still finish what it was doing, such as a click or
  typing already sent to the page, a page load, a file being saved, closing or selecting a tab or
  resizing the window, but it returns only the refusal. A `batch` under way returns what its
  earlier steps read before your click, with the refusal for the rest.
- The stop is kept in memory. A Firefox restart, or an update or reload of the extension, forgets
  it, as it forgets the session answers; a session that connects again afterwards has what a new
  session has, such as the sites you allowed always.
- A new agent session is not stopped. An agent that can run programs on your computer can start
  one itself, which can use every site you allowed always. Revoking those sites makes its new
  sessions ask you again, and disabling the Foxleash add-on cuts it off while the add-on stays
  disabled (see [The risk](#the-risk)).
- Closing the session's tab group does not stop the session: the next tab it opens makes a new
  group.
- A session also ends when Firefox loses its connection to the Foxleash program, because the
  program stopped or crashed. An agent still running then goes on as the same session, still
  stopped if you stopped it. Its answers are forgotten: it is asked again for the sites you
  allowed only for that session, may ask again about sites you refused, and again has three refused
  or closed prompts before it stops asking.

## Untrusted page content

Tool results mark page content as untrusted, and the agent is told not to follow instructions
found in pages. An agent that can run programs on your computer can get page content without
this marking (see [The risk](#the-risk)).

## Protected fields

Text results never return the values of these fields, only whether they are filled:

- password fields,
- one-time code and card number fields that the page marks as such for autofill,
- text fields that Firefox filled in from your saved logins, addresses or cards, until you edit
  them.

Firefox fills saved passwords into login pages when they load, and a page you approved could
otherwise hand yours to the agent. A field that is none of these still shows its value. In text
results, a drop-down that Firefox filled in from your saved addresses or cards, such as a card's
expiry month or a country, also shows the option Firefox chose; screenshots hide it, as they hide
the text of every drop-down (see [Screenshots](#screenshots)). The text of a network response that
`read_network` returns, and a file that `download` saves, can still contain a protected field's
value when the site sends it back (see [Response bodies](#response-bodies) and
[Downloads](#downloads)).

### Forms sent with GET

A form sent with GET puts the values of its fields in the address of the page it opens. The agent
would get that address in the action's result, in `tabs_list` and in `read_network`, and it stays
in the tab's history and the site's logs. So when a `click`, or Enter with `press_key`, would send
a form with GET while the form would send the value of a protected field, Foxleash cancels the
submission and refuses the action, naming the field, and the agent asks you to send the form. A
form without a `method` attribute is sent with GET, and a submit button's `formmethod` counts. A
protected field counts when the form sends it: when it has a name and a value and is not
disabled. A custom form element that holds a protected field with a value, in its own shadow tree
or among the elements it contains, counts too, named or not, since its script decides what the
form sends. A form whose own script cancels the browser's submission, as most sign-in pages do,
works as before, and so do forms sent with POST.

This does not cover:

- a form you send yourself with GET: the page's address then holds its values, protected ones
  included, and `tabs_list`, `read_network` and the result of the agent's next action show it;
- a form the page's own scripts send after the agent's click or Enter: with the form's `submit()`,
  also from the button's own click handler or from a link whose address runs a script
  (`javascript:`), later, such as from a timer, or by handling the submission and putting the
  values in the page's address or in the address of a request the script makes, which
  `read_network` shows;
- a page's script that stops the browser's submit event before it reaches Foxleash, that adds
  values to the form when it is sent, or that adds a listener, a form or a shadow root while the
  action runs.

These depend on the site's own code, and Foxleash cannot tell such a script from one that handles
a sign-in properly without also refusing forms that scripts handle.

### A password field that the page changes

In `read_page`, a password field that the page turns into another kind of field stays protected
only if the agent read the page, took a screenshot of it or acted in it while it was still a
password field, and a text field that the page puts in its place shows its value.

So a page's Show password control that puts a text field in the password field's place shows the
password, also one Firefox filled in, in the result of the agent's click on that control and in
later reads and screenshots of the page.

### Reloading and going back or forward

When the agent reloads a page, Foxleash loads it without the browser's cache, so Firefox puts
back no field value.

After the agent goes back or forward to a page that Firefox loads again instead of keeping it in
memory, Foxleash loads the page's address again, which may come from the browser's cache and
also puts back no field value, so the page's fields lose what was typed into them. This does not
hold for:

- a page that a form sent with POST,
- a page that takes more than 30 seconds to arrive,
- a page on a site the agent may not act on.

For a page whose address has a fragment (a part after `#`), which the page can give itself, it
also does not hold when the page holds a frame a form sent with POST, when it or a frame in it
sends a form with POST before Foxleash loads it again, or when it does not finish loading within
30 seconds.

It does not hold either in the other cases of going back or forward that the next section lists.

### When a field Firefox filled in shows its value again

A text field Firefox filled in shows its value again once Firefox no longer highlights it as
filled in:

- after you edit it;
- after the page's own scripts report a change to it or go back or forward;
- after the page reloads itself, with its own scripts or without them, such as with a
  `<meta http-equiv="refresh">` tag;
- after you duplicate its tab, in the new tab;
- after you reopen its tab after closing it;
- after the agent goes back or forward and the page delays that by more than a second;
- after the agent goes back or forward to:
  - a page that a form sent with POST,
  - a page that takes more than 30 seconds to arrive,
  - a page whose script stops Foxleash's load of its address,
  - a page whose server takes more than 20 seconds to answer Foxleash's load of its address,
    until it answers,
  - a page whose server answers Foxleash's load of its address with no page, such as a 204 No
    Content answer,
  - a page whose address has a fragment (a part after `#`), which the page can give itself, and
    that holds a frame a form sent with POST, sends a form with POST itself or from a frame
    before Foxleash loads it again, or does not finish loading within 30 seconds,
  - a page on a site you had not approved and then approve;
- in a frame, after the agent goes back or forward and only that frame changes;
- after a tab that was unloaded, by you or by Firefox to save memory, is loaded again;
- after Firefox restores your windows and tabs when it starts again.

Possibly also:

- after you reopen a window you closed;
- after the agent goes back or forward and Firefox delays telling Foxleash about the page's
  request by more than a second, or the computer's clock is set back meanwhile;
- after the agent goes back or forward to a page that starts another load after it arrived, if
  Firefox tells Foxleash about that load before the page's arrival or within the same
  millisecond, or from a page that starts another load while the agent leaves it;
- after the agent goes back or forward to a page whose server answers Foxleash's load of its
  address with a download;
- to another tool call that reads the page while the agent goes back or forward to it.

### Screenshots

Screenshots hide the text of protected fields, also in frames from other sites, with a style
sheet Foxleash adds to each frame, and Foxleash takes no screenshot when a frame does not take
it, such as a PDF in a frame. There are two exceptions:

- a frame showing Firefox's error page for a page that could not be loaded or does not allow
  being shown in a frame,
- a frame of another add-on, such as a password manager's menu, which Foxleash hides together
  with every other frame of the same page or frame, so none of their content is in the
  screenshot.

A screenshot also hides the text of every drop-down, so it shows no drop-down's option, whether
Firefox filled it in or not. Firefox shows the option of a saved address or card in a drop-down
while you highlight that entry in its menu without choosing it, and a screenshot never shows it.
Text results give a drop-down's option outside frames, also one Firefox filled in (see
[Protected fields](#protected-fields)), and never a previewed one. The options of a list box, a
drop-down shown as a list, are hidden too, unless the page styles the options' text itself. See
[ADR 0100](adr/0100-screenshots-hide-the-text-of-every-drop-down.md).

When the page turns a password field into another kind of field after the agent read the page,
took a screenshot of it or acted in it while it was a password field, a screenshot hides the
text of every input element in the page, input buttons included, outside its frames.

In a frame, a password field that the frame turns into another kind of field shows its text in
screenshots, also when the agent read the page, took a screenshot of it or acted in it while it was
a password field.

A screenshot shows the highlight of text selected in a protected field, so it shows how long that
text is, though not the text.

### Request bodies

`read_network` never returns a value from a request body, nor a value's length or the count of
its parts, for any field: a body carries what protected fields hold, and a login form's POST
carries the saved password Firefox filled in. It returns only the names of the fields, the kind
of each value and whether each is filled, as `protected filled` says a field is filled. No length
or size range is shown either, because an agent that can add text to a field and send the form
again could read a value's exact length off any edge of a range. The value of a request's
`Content-Length` header is redacted, so a body's length does not show either.

Exceptions and limits:

- Names that do not look like field names are withheld, but a value used as a name or key still
  shows when it looks like one: a plain word, or a token, UUID or JWT that starts with a letter or
  `_` and is at most 100 characters long. So does a piece of a value in a body that a page builds
  by joining text without escaping it (`pass=p&ss=w0rd` shows a field `ss`).
- A form name is listed once, and of names that differ only in numbers in brackets (`a[0]`,
  `a[1]`) only the first, but the number of other distinct plain names, and which of them are
  empty, show: a code typed into one box per digit, each box with a name of its own, shows its
  length.
- A form sent with GET puts its values in the URL, which `read_network` shows (see
  [Forms sent with GET](#forms-sent-with-get)).
- A JSON body that Firefox cuts at its limit for request bodies (16,777,216 bytes by default)
  turns from `json` to `other`. An agent that can make the page send about 16 MiB in another
  field of the same body can find the body's exact length from where it turns.
- A form body, or any body sent as a urlencoded form, turns to `other` once it is 1,048,576
  bytes (1 MiB) or more, because Firefox then gives Foxleash none of its fields: a form from
  `form` with its fields, and a body Firefox cannot read as a form, such as JSON holding a stray
  `%`, from `json` with its keys or from `other` that says whether it is filled. An agent that
  can make the page send about 1 MiB in another field of the same body, with 2 to 7 `type` calls
  in one `batch` depending on how the form is encoded, or with a file it uploads into the same
  form, can find the body's exact length from where it turns (ADR 0090).
- Below that size, a body sent as a urlencoded form shows as `form` only when Firefox can decode
  all of it. When a value holds a stray `%`, or a letter like `é` that a page in a legacy encoding
  such as windows-1252 sends, Firefox gives its bytes instead: the body shows as `other` that says
  whether it is filled, or, when it is JSON, as `json` with its keys instead of `other`. So the
  shape shows whether a value, a protected one included, holds such a character.
- Requests of frames from other sites show the shapes of their bodies too.
- Foxleash asks Firefox for request bodies only for the tabs in the group of an agent session
  that runs and that you have not stopped, by one listener per such tab, so Firefox builds and
  delivers no body for any other tab, and a request of another tab is recorded with no body.
  When Foxleash misses that a tab joined or left the group, it catches up when it handles the
  tab's next request: what that costs is the bodies of the requests Firefox sends for the tab
  before then, which show no body in a tab that joined and are never read in a tab that left.
  Foxleash reads a body only when its request comes from a tab in the group of such a session.
- In those tabs Foxleash stops reading bodies once reading them has taken 250 ms that have not
  passed again since, so that a page sending very large bodies cannot keep it busy: the bodies
  that arrive until then show as `other`, for 10 seconds at most after a body was read, or longer
  when the computer's clock was set back meanwhile. This is not a size limit of Foxleash's own:
  the time the earlier bodies took decides what is left out, never a body's own size, and the
  time is shared by all sessions (ADR 0085).
- A page in an agent's tab, including a frame from any site or a page on a site the session may
  not act on, can still make Firefox deliver bodies faster than Foxleash takes them in, and
  Firefox's add-on process, which all add-ons share, holds them meanwhile. A page in an agent's
  tab that kept posting a 1,000,000-byte form of 111,112 fields grew that process by about 60 to
  90 MiB a second for as long as it sent, in headless Firefox 160.0.1 (ADR 0085).
- A response body can repeat what a request sent (see [Response bodies](#response-bodies)).

### Response bodies

With `responseBody`, `read_network` returns the text of the responses to a page's fetch and
XMLHttpRequest requests, as they arrived (ADR 0071):

- Only responses to requests whose own URL is on a site the session may act on: approved and not
  on the blocklist. This is stricter than the request list, which includes the requests of frames
  from other sites, blocklisted ones included. Foxleash checks it when the request starts and
  again before it keeps the body, against a copy of your approvals and blocklist that it forgets
  at once whenever they change; without a current copy it captures nothing and gives no body.
  When a site stops being approved or is blocklisted, Foxleash forgets the bodies it kept from it.
- Only fetch and XMLHttpRequest, never page loads, scripts, images or other resources, and only
  text content types.
- At most 65,536 bytes are copied of each response, and the text is cut to 32,768 characters. At
  most 64 responses of a page are copied at once, and bodies count toward the page's 4,000,000
  characters.
- As a best effort, the values of access, refresh and ID token fields and JWT-shaped strings are
  replaced with `[redacted]` before the text is cut, also when the text ends inside one. A
  response whose charset can decode ASCII bytes to other characters (UTF-16, ISO-2022-JP,
  Shift_JIS, GBK, gb18030, Big5, EUC-KR) is not kept, since it could hide a token from the
  redaction.
- Foxleash writes each chunk of the response on to the page, in the order it arrives, before it
  copies anything, and never changes one. At the copy limit, for a type it does not keep, and on
  any fault, redirect, error or end of recording, it stops copying and keeps passing the rest of
  the response on until it ends, also when that happens before the response starts. A response
  that fails while it arrives, such as one the connection cuts short, reaches the page as a
  complete response with the bytes that arrived and without the error Firefox would otherwise
  report, because Firefox gives an add-on's stream filter no way to pass that failure on;
  `read_network` gives that request its error and no body. When Foxleash's background
  stops in the middle of a response, the page still gets all of it.
- Nothing from before recording began, and nothing from a gap: a response still arriving when
  recording stops is never kept.
- Firefox lets an add-on read a response only for a request one of its blocking listeners saw. So
  while a tab of the agent's group is being recorded, Foxleash keeps one blocking listener for
  that tab's fetch and XMLHttpRequest requests, which returns at once. Those requests wait for
  Foxleash's background to answer it: a fraction of a millisecond on average when it is running,
  tens to hundreds of milliseconds when Firefox had suspended it. That listener holds no other
  tab. From the first agent session on, a second blocking listener sees the answers to page and
  frame loads in every tab, and answers at once unless the answer is a file (see
  [Files a page loads in the agent's tabs](#files-a-page-loads-in-the-agents-tabs)). A third
  exists only while a download runs: it sees the requests that belong to no tab, answers at once
  for every one but the redirect steps of the download's own request, and cancels a step to a site
  the session may not act on (see [Downloads](#downloads)). After a download that timed out while
  its request was under way, it stays for up to 5 minutes, cancelling only that request's steps. A
  fourth exists for a tab while a call waits for a load the agent started there, until 5 minutes
  after the last such call returns, and for a load under way then until it ends: it sees that
  tab's page loads, answers at once for a load's first address, and holds each redirect step until
  Foxleash has read its settings, cancelling the steps that [The blocklist](#the-blocklist) says
  it cancels.

Exceptions and limits:

- A response can repeat what a request sent, protected values included, such as a save that
  echoes a form Firefox filled in, or a page fragment with a value the server put into a field.
- A frame from another site that fetches from an approved site has that response captured,
  because the rule is the request's own URL.
- A response the page itself cannot read, such as a `no-cors` fetch or one that fails its CORS
  check, is captured when its URL is on an approved site.
- The redaction misses other names (`token`, `session`, `apiKey`), keys written with escapes or
  inside a JSON string that holds JSON (unless the value is a JWT), a token value that is not a
  string, an XML element with attributes, and a body encoded another way, such as base64.
- `download` saves the whole answer of an address on an approved site, with no redaction (see
  [Downloads](#downloads)).

## Saved screenshots

Saved screenshots go only into the agent's working folder, as new files, and never over an
existing file. An agent that can run programs on your computer can get a screenshot without this
rule (see [The risk](#the-risk)).

## Downloads

Downloads request and save only from sites you approved that are not on the blocklist: Foxleash
checks the address before the request, every address a redirect leads to before Firefox requests
it, and the final address again before it reads and before it saves anything. The request
carries all your cookies for the site, as a request from that site's own page would. An `http://`
address is requested over plain http, so the file and your cookies for the site that are not
marked Secure travel unencrypted. Downloads go only into your Firefox download folder, under a
plain file name, never over an existing file. The file's content reaches the agent only when it
reads the file with its own tools, outside Foxleash's untrusted marking.

`download` can save the successful answer of any address on an approved site, not only a file a
page links to. Foxleash hides and redacts nothing in it, so the file can hold a value the server
put in a protected field, and sign-in tokens that `read_network` would redact.

A redirect step to a site you have not approved, one on the blocklist, or an address that is not
http(s) is cancelled before Firefox sends it, so that site gets no request and none of your
cookies, and nothing is saved. So a download whose redirects pass through another site fails, also
when they lead back to an approved site, such as a sign-in that bounces through another site. An
upgrade Firefox makes itself, in HTTPS-Only Mode or for a site that asked for https only (HSTS), is
such a step too: it is cancelled unless you approved the `https://` site as well. A step to an
`http://` address on an approved site goes over plain http, also on the way from one `https://`
address to another.

Firefox hides requests to some sites from add-ons: its restricted domains, such as
addons.mozilla.org, accounts.firefox.com and support.mozilla.org, and any site Mozilla
quarantines. Foxleash does not see a redirect step to one of them, so it cannot cancel it and
Firefox sends that request; the file is not saved when such a step is the last one.

`download` refuses while Foxleash lacks access to all websites in Firefox's add-on settings
(about:addons, Foxleash, Permissions): Firefox would then not show it the redirect steps to sites
outside that access.

### Files a page loads in the agent's tabs

Firefox also saves a file without the `download` tool: when a page or a frame loads an address
whose answer is a file. A page on a site you approved could use that to get a file from a site you
have not approved, or that is on the blocklist, saved into your download folder, which is an
upload folder by default: with a link that redirects there, or with its own scripts.

So in the tabs of an agent's tab group, and in a window or tab that a page in them opens,
Foxleash stops a page or frame load whose answer comes from a site that session may not act on
(not approved, or on the blocklist) and is anything other than a web page: a file Firefox would
save, or a PDF, an image, plain text or another document that it would show. Nothing of it is
saved or shown, and the tab keeps the page it had (ADR 0081). A window that a page in the agent's
tabs opens, or that a page in such a window opens, is covered like those tabs until it closes,
though the agent cannot reach it.

What the agent learns:

- The result of an action (`click`, `type`, `press_key` and the others) lists the site in
  `refusedFiles` when the load was stopped during the action or its wait, in the tab, in a tab
  the action opened, or in a window opened from the tab, by its page or by you.
- `tab_open`, and `navigate` with a URL, a reload or a step back or forward that Foxleash loads
  again, fail at once when the tab's own load is stopped, saying that a file from that site was
  stopped and that the site must be approved first. So does a call whose page loaded and then
  moved on to such a file by itself before the call returned. `tab_open` then closes the tab it
  made.
- A load stopped at any other time, such as one a page starts on a timer after the call
  returned, is in no result.
- A download cancelled because of a load in the tab is reported the same way, by its site alone,
  once its file is gone, but can be missing from the result: most often a download in a tab the
  action opened, which Firefox closes, and sometimes one that began after the action's result was
  settled. A download cancelled during a flood (see below), and one whose file Foxleash could not
  remove, are in no result.
- A file that a page built itself (see below), cancelled because of a frame, is reported the same
  way for that frame's tab, by its site alone; one from the tab's top frame also fails `tab_open`
  or `navigate` when it comes before the call returns. One that a sandboxed page built is in no
  result.

When such a site's own service worker answers the load, there is no answer from the network to
stop, and Firefox starts saving the file. For that case Foxleash keeps each page and frame load of
every tab whose answer has not come, and when Firefox starts a download that Foxleash did not
start, at the address of such a load in a tab it covers, begun before the download, on a site that
session may not act on, Foxleash cancels the download and removes its file. This is
after the fact: the request reached that site, and the file exists for a moment, measured at about
15 to 50 ms for one load and at most about half a second while a page loads the file 33 times a
second. `upload_file` refuses a file saved or changed in the last 5 seconds, so it does not hand
such a file over in that moment; a program other than Foxleash that reads the download folder in a
loop can read it. The download stays in Firefox's downloads panel, cancelled.

When a page of such a site, in those tabs or a frame there, builds a file itself, as a Blob, and
Firefox saves it, there is no load to stop either. Foxleash keeps, for each tab, the sites of the
pages its frames showed in the last 60 seconds, and cancels such a download and removes its file
after the fact, as for a worker's answer, when the file comes from a site that session
may not act on and a tab of the group shows a page of that site in any frame, or showed one in the
last 60 seconds. A page with no origin of its own, such as one in a sandboxed frame or one opened
from a file on your computer, gives its file no site: Foxleash then cancels it when a tab of the
group shows, or showed in the last 60 seconds, a page of any site that session may not act on. The file exists for a moment, measured at
about 10 to 85 ms while a page saves 33 files a second, and up to about 2.4 seconds in Firefox ESR
with thousands of earlier downloads in its list; `upload_file` refuses it meanwhile.

What counts as a web page: an answer with one `Content-Type` header of `text/html` or
`application/xhtml+xml`, and no `Content-Disposition` header or one of the type `inline`.
Everything else counts as a file, also where the headers are repeated or cannot be read as one
type. Two kinds of answer are let through whatever their headers say: a redirect that Firefox
follows (status 301, 302, 303, 307 or 308 with a `Location` header), since the answer it leads to
is judged in its turn, and an answer with status 204, 205 or 304, of which Firefox loads and
saves nothing. After a 304, Firefox takes the answer from its cache, and that one is judged.

Exceptions and limits:

- The request still reaches that site, with the cookies Firefox sends for it. Only its answer is
  stopped.
- Still saved is a `data:` file that a page of such a site builds itself, since Firefox tells
  Foxleash nothing about where it came from; a page of such a site that saves its own address as a
  file, for example with a download link to itself, since its answer is a web page; and a file
  such a page builds more than 60 seconds after its last change of address, in a frame or window
  that is removed, closed or sent to another page right then. An answer that such a site's service
  worker gives and that Firefox shows rather than saves, such as a PDF, an image or text, is still
  shown: it starts no download.
- A download whose address is not that of a load of the tab is not cancelled, such as one that a
  service worker answers with a redirect it builds. Neither is one whose load the worker held for
  more than 10 minutes before answering. A file Foxleash could not remove, which is logged, or took
  more than 5 seconds to remove, which is possible while a page saves files many times a second
  and Firefox's download list holds thousands of entries, is refused by `upload_file` only for its
  first 5 seconds.
- A download of your own is cancelled and its file removed when a tab of an agent's group began a
  load of exactly that address in the 10 minutes before, on a site that session may not act on,
  that got no answer from the network and showed no page: one still waiting, or one whose own
  download Foxleash already cancelled. Foxleash cannot tell which load a download came from, so
  such a load keeps refusing its address. A page can cause that for each address it loads so.
- A page in the agent's tabs that keeps more than 200 loads under way without an answer makes
  Foxleash cancel and remove every download that Foxleash did not start, in any tab, from every
  site that session may not act on, until 10 minutes after the last load over those 200, or 2
  seconds after its tab closed. Such a download is in no result.
- A Blob file of your own from a site, in any tab, is cancelled and removed while a tab of an
  agent's group shows a page of that site in any frame, for example a widget of that site embedded
  in the approved page, and for 60 seconds after, also when another agent session may act on that
  site. A Blob file that a page with no origin of its own saves, such as a sandboxed page or one
  opened from a file on your computer, in any tab, is cancelled while a tab of an agent's group
  shows, or in the last 60 seconds showed, a page of a site that session may not act on.
- A page in the agent's tabs that shows pages of more than 200 sites within 60 seconds makes
  Foxleash cancel and remove every Blob file from every site that session may not act on, in any
  tab, until 60 seconds after the last one over those 200, or 2 seconds after its tab closed. Such
  a file is in no result.
- A window that a page in those tabs opens is covered also when the tab that opened it closes at
  once, as a page may do with its own tab while the tab has shown only that page: Foxleash keeps
  the group of the last 200 tabs that closed, and of every tab that closed in the last 2 seconds.
  Not covered are a window opened from a tab whose group Foxleash never saw, which can happen only
  in the moment as it starts, or when it could not read the open tabs then, and a window that no
  tab's page opens, such as one a service worker opens when you click its notification.
- A window or tab you open from one of those tabs yourself, such as with Open Link in New Window,
  is covered too until it closes, so a file from a site the session may not act on is stopped
  there as well. Possibly not the first address it loads: Foxleash may hear of such a window only
  after that load began.
- Other tabs outside every agent's tab group are not covered: files load in them as before.
- A page or frame from such a site that is not HTML, such as a PDF or an image opened as a page,
  is no longer shown in the group's tabs. Images and other parts that a page embeds are not
  affected, and neither is a PDF or another document in an `<object>` or `<embed>` element.
- In the tabs of a session you stopped, every load whose answer is not a web page is stopped,
  also from sites you approved.
- When a session ended, the tabs left in its group stay covered, judged by the sites you allow
  always and those you had allowed only for that session when it ended, until Firefox restarts or
  the extension is updated or reloaded. Foxleash keeps that for the last 200 sessions
  that ended with a site allowed only for them; an older one's tabs are judged by the sites you
  allowed always, also while its tab is still open. Moving a tab out of the group ends its
  coverage, unless another tab of the group opened it.
- A new tab or window that a page opened for such a file stays open, blank.
- Foxleash remembers in its storage the tab groups it made for agent sessions, up to 200, so after
  a Firefox restart, or an update or reload of the extension, the tabs left in such a group stay
  covered, judged by the sites you allowed always. So a file from a site you allowed
  only for that session no longer loads in those tabs, and a Blob file of your own from that site
  is cancelled in any tab while such a tab shows it, or showed it in the last 60 seconds. Limits:
  - In the moment after Firefox starts or the extension is updated or reloaded, before Foxleash
    has read that list, nothing is covered.
  - Windows opened from those tabs before the restart, update or reload are no longer covered, and
    the tabs of a session you stopped are judged by the sites you allowed always, as if you had
    not stopped it.
  - Once the list holds more than 200 groups, Foxleash forgets the oldest of those that have no
    tab, such as one you saved and closed, until 200 remain; such a group is not covered when you
    open it again. An agent can make that happen by opening and closing tabs. A group that still
    has a tab is never forgotten.
  - Groups made by a version of Foxleash before this one are not covered.
  - While Foxleash cannot read its storage, the tabs of a group from before are not covered.
- From the first agent session on, and also from the moment Foxleash sees a tab of a remembered
  group, after Firefox's start or an update or reload of the extension, Foxleash's blocking
  listener sees the answer to every page and frame load in every tab, until Firefox quits or the
  extension is updated or reloaded. It answers at once for a web page and for the
  two kinds of answer it lets through. For any other answer it first looks up the tab and the tabs
  that opened it, one after the other, and for a tab it covers reads your settings, before the
  answer goes on or is stopped. Measured, it adds a few milliseconds or less to a page load.
  When Foxleash adds this listener while it is still starting, Firefox can note it for Foxleash's
  next start; measured, it did so once, in Firefox 160 after a restart, and in none of the other
  cases tried. With that note, at the next start, such as Firefox's, page and frame loads in every
  tab wait until Foxleash has started, which it does when Firefox starts anyway; how long they
  wait, and whether the very first loads after Firefox starts wait too, was not measured. If
  Foxleash adds the listener again while starting, it checks the loads that waited in the tabs of
  a remembered group, though not in a window opened from them before then; if not, they go on
  unchecked and Firefox drops the note.

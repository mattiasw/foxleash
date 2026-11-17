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
  in it, and no page script is needed,
- a `download` of an address on an approved site that redirects to another site: Firefox
  requests that site's address, with your cookies for it, before Foxleash checks the final
  address, and the file is saved when a further redirect leads back to an approved site (see
  [Downloads](#downloads)).

In the first two, the agent then sees only that site's address. A page's own scripts can also
open an email address. Whatever the agent puts in an address, types or submits in a page goes to
that site, and to wherever that page sends it, as it would if you did it yourself.

## Tabs on other sites

Tabs on sites you have not approved show the agent only the site's address, with no path, query
or title, and a local file only as `file:`. The sites you allowed always are listed in the
extension's settings page in the add-ons manager, each with a Revoke button.

## The blocklist

A built-in list of common financial and health sites is blocked by default. The list is short
and names mostly sites in the United States, the Nordic countries and the United Kingdom. It
cannot name every such site: a site that is not on it, such as a regional care provider, is not
blocked until you add it. You can edit the list in the extension's settings page, one domain
per line; a domain blocks itself and its subdomains. While your saved list differs from the
built-in one, Foxleash keeps it as it is: sites that a later version adds to the built-in list
are not added to yours. The settings page's "Fill in the built-in list" button fills in the
current built-in list for you to save. Foxleash checks the blocklist before it opens or reloads
a page, and shows the agent a tab on a blocked site only as the site's address.

Content a page on an approved site embeds from a blocked site can still show up in what the agent
reads, and the ways that still reach a site you have not approved without asking can also reach
a blocked site, even one you approved (see [Site approval](#site-approval)).

An entry is a domain or an IPv4 address; an IPv6 address cannot be entered. An IPv4 entry also
covers the same address written as an IPv4-mapped IPv6 address, such as `[::ffff:192.168.1.1]`,
but no other IPv6 form of it, such as the NAT64 address `[64:ff9b::c0a8:101]`. Any other site
with an IPv6 address in place of a domain, such as `http://[2001:db8::1]`, cannot be blocked.

Foxleash tells the agent when it refuses a site because it is on the blocklist, without asking
you, and `start_recipe` and `request_sites` return which of the sites they name are blocked, so
an agent can find out which sites are on your list.

## Uploads

File uploads only read from allowed folders: the agent's working folder and `~/Downloads` by
default.

- The working folder is not an upload folder when it is your home folder or contains it, or lies
  in a folder whose name starts with a dot.
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
- A session whose program went away without telling Firefox stays listed as running until Firefox
  restarts.

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
otherwise hand yours to the agent. A field that is none of these still shows its value. The text
of a network response that `read_network` returns, and a file that `download` saves, can still
contain such a value when the site sends it back (see [Response bodies](#response-bodies) and
[Downloads](#downloads)).

### A password field that the page changes

In `read_page`, a password field that the page turns into another kind of field stays protected
only if the agent read the page, took a screenshot of it or acted in it while it was still a
password field, and a text field that the page puts in its place shows its value.

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

### When a field Firefox filled in shows its value again

A text field Firefox filled in shows its value again once Firefox no longer highlights it as
filled in:

- after you edit it;
- after the page's own scripts report a change to it, reload the page or go back or forward;
- after the agent goes back or forward to:
  - a page that a form sent with POST,
  - a page that takes more than 30 seconds to arrive,
  - a page whose script stops Foxleash's load of its address,
  - a page whose server takes more than 20 seconds to answer Foxleash's load of its address,
    until it answers,
  - a page whose address has a fragment (a part after `#`), which the page can give itself, and
    that holds a frame a form sent with POST, sends a form with POST itself or from a frame
    before Foxleash loads it again, or does not finish loading within 30 seconds,
  - a page on a site you had not approved and then approve;
- in a frame, after the agent goes back or forward and only that frame changes;
- after a tab that was unloaded, by you or by Firefox to save memory, is loaded again;
- after Firefox restores your windows and tabs when it starts again.

Possibly also:

- after you reopen a tab or window you closed;
- after the agent goes back or forward and the page delays that, or Firefox delays telling
  Foxleash about the page's request, by more than a second, or the computer's clock is set back
  meanwhile;
- after the agent goes back or forward to a page that starts another load after it arrived, if
  Firefox tells Foxleash about that load before the page's arrival or within the same
  millisecond, or from a page that starts another load while the agent leaves it;
- after the agent goes back or forward to a page whose server answers Foxleash's load of its
  address with no page, such as a 204 No Content answer or a download;
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

When the page turns a password field into another kind of field after the agent read the page,
took a screenshot of it or acted in it while it was a password field, a screenshot hides the
text of every input element in the page, input buttons included, outside its frames.

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
- A form sent with GET puts its values in the URL, which `read_network` shows.
- A JSON body that Firefox cuts at its limit for request bodies (16,777,216 bytes by default)
  turns from `json` to `other`. An agent that can make the page send about 16 MiB in another
  field of the same body can find the body's exact length from where it turns.
- Requests of frames from other sites show the shapes of their bodies too.
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
  copies anything, and never changes one. At the copy limit and on any fault, redirect, error or
  end of recording it stops copying and keeps passing the rest of the response on until it ends;
  a capture that ends before the response starts hands the response back to Firefox. When
  Foxleash's background stops in the middle of a response, the page still gets all of it.
- Nothing from before recording began, and nothing from a gap: a response still arriving when
  recording stops is never kept.
- Firefox lets an add-on read a response only for a request one of its blocking listeners saw. So
  while a tab of the agent's group is being recorded, Foxleash keeps one blocking listener for
  that tab's fetch and XMLHttpRequest requests, which returns at once. Those requests wait for
  Foxleash's background to answer it: a fraction of a millisecond on average when it is running,
  tens to hundreds of milliseconds when Firefox had suspended it. Other tabs are never held.

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

Downloads save only a file served by a site you approved, after any redirects: Foxleash checks
the address before the request, and the final address before it reads or saves anything. They
go only into your Firefox download folder, under a plain file name, never over an existing
file. The file's content reaches the agent only when it reads the file with its own tools,
outside Foxleash's untrusted marking.

`download` can save the successful answer of any address on an approved site, not only a file a
page links to. Foxleash hides and redacts nothing in it, so the file can hold a value the server
put in a protected field, and sign-in tokens that `read_network` would redact.

On the way to the final address, a redirect can make Firefox request an address on a site you
have not approved, with your cookies for that site; nothing from such a site is saved (see
[Site approval](#site-approval)).

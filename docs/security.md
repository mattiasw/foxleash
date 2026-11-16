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

Avoid using Foxleash on sites where a mistake is costly (banking, health records, admin panels
with destructive actions), and stay nearby while it works.

## Site approval

Foxleash acts on a site only after you approved that site in the browser, and asks before it
opens a page there. The approval can only come from your click, not from the agent.

It refuses clicks on links and form buttons that lead to another site or out of the browser,
such as to an email address, and Enter pressed on such a link or in such a form; the agent opens
a page on another site with `navigate`, which asks first.

Two ways still reach a site you have not approved without asking:

- going back or forward in a tab's history,
- a page on an approved site that redirects or, with its own scripts, sends the tab to another
  site, for example after a click.

The agent then sees only that site's address. A page's own scripts can also open an email
address.

## Tabs on other sites

Tabs on sites you have not approved show the agent only the site's address, with no path, query
or title, and a local file only as `file:`. The sites you allowed always are listed in the
extension's settings page in the add-ons manager, each with a Revoke button.

## The blocklist

Financial and health sites are blocked by default. You can edit the list in the extension's
settings page, one domain per line. Foxleash checks the blocklist before it opens or reloads a
page, and shows the agent a tab on a blocked site only as the site's address.

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
- files named like keys (`id_*`, `*.pem`, `*.key`, `*.kdbx` and similar),
- files that hold a PEM, OpenSSH, PuTTY, PGP or age private key, such as an SSH key named
  `deploy` or a service account key `.json`.

Keys in other forms, such as a WireGuard configuration or a binary DER key, are not recognised.

An upload takes at most 100 files and 10 MB.

## Recipes and site requests

- A recipe is saved only by your click on Foxleash's page in Firefox, after you read it: nothing
  the agent sends can save one. Later agent sessions read a saved recipe as your instructions,
  so read it before you save it.
- Allowing a recipe's sites takes your click too, grants them for the session only, never
  always, and sites on your blocklist or that you refused in the session stay so.
- Allowing the sites an agent asks for takes your click too, on a page that shows only those
  sites, at most 20, grants them for the session only, never always, and sites on your blocklist
  or that you refused in the session stay so.

## Untrusted page content

Tool results mark page content as untrusted, and the agent is told not to follow instructions
found in pages.

## Protected fields

Text results never return the values of these fields, only whether they are filled:

- password fields,
- one-time code and card number fields that the page marks as such for autofill,
- text fields that Firefox filled in from your saved logins, addresses or cards, until you edit
  them.

Firefox fills saved passwords into login pages when they load, and a page you approved could
otherwise hand yours to the agent. A field that is none of these still shows its value.

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

## Saved screenshots

Saved screenshots go only into the agent's working folder, as new files, and never over an
existing file.

## Downloads

Downloads save only a file served by a site you approved, after any redirects: Foxleash checks
the address before the request, and the final address before it reads or saves anything. They
go only into your Firefox download folder, under a plain file name, never over an existing
file. The file's content reaches the agent only when it reads the file with its own tools,
outside Foxleash's untrusted marking.

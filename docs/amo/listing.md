# AMO listing

> This file holds the text Foxleash gives Mozilla's add-on site (AMO) and what Mozilla's
> reviewers compare the extension with. Mozilla disables add-ons whose listing, manifest and
> behaviour disagree, so update this file in the same commit as any change to
> `permissions`, `host_permissions`, `data_collection_permissions`, `web_accessible_resources`,
> `externally_connectable`, `content_security_policy`, the data that leaves the browser or
> where it goes, or what the extension can do on the user's behalf.
>
> It describes the feature set the first signed version declares. Permissions are fixed from
> the first release, because Firefox does not show users host permissions that an update
> adds. No version may be submitted to AMO whose build lacks a capability or safeguard this
> file states.
>
> Where each section goes on AMO:
>
> - **Name**, **Summary**, **Description**: the add-on fields of those names. AMO takes at
>   most 50 characters for the name, 250 for the summary, which may hold no URL, and 15,000
>   for the description. Each release sets the summary and the description from this file at
>   its tag before it submits the version.
> - **Permissions**: the notes to reviewers ("Notes to Reviewer", the version's
>   `approval_notes`), given with every version. AMO takes at most 3,000 characters.
> - **Data collection and handling**: the add-on's privacy policy. AMO keeps it apart from
>   the add-on and version metadata (it has its own page and API endpoint), and each release
>   sets it on that endpoint from this file at its tag before it submits the version. AMO
>   takes at most 150,000 characters.
> - **Compatibility**: not text for AMO. It says which applications each version is
>   submitted for, and why.
> - **Screenshots**: AMO's screenshots of the add-on; not pasted text. Each release makes them
>   the files of `docs/amo/screenshots/` named there, with their captions and in that order,
>   from this file and those files at its tag before it submits the version.
> - **Listing details**: the add-on's other fields on AMO (slug, category, license, homepage,
>   support site, support email), set on the add-on and its versions, not pasted text. Each
>   release sets the category, homepage, support site and support email from this file at its
>   tag before it submits the version, and the license goes with each version. The slug must
>   already match: the release stops when AMO's slug differs and never changes it. The slug is
>   the last segment of `ADDON_PAGE_URL` unless that address is the one by add-on id, in which
>   case the slug line holds the slug AMO has for the add-on.
>
> `docs/amo/icon-128.png` is the add-on's icon on AMO, which each release uploads. It is
> rendered from `apps/extension/icons/foxleash.svg` (see `docs/development.md`) and must be
> rendered again whenever that SVG changes.
>
> The release check fails when the Summary, the Description or the Permissions section is
> longer than AMO takes.
>
> The body of a pasted section is everything between its heading and the next `##` heading.
> In those sections each paragraph and each list item is one line, and they hold plain
> sentences and `- ` list items only, because AMO's fields accept only a small subset of
> formatting.
>
> Why the manifest declares the three data categories that the Data collection and handling
> section names, and no more, is recorded in
> [ADR 0104](../adr/0104-the-manifest-declares-three-data-categories.md).

## Name

Foxleash

## Summary

Lets an AI agent on your computer, such as Claude Code, use your own Firefox for you: it opens tabs, and reads pages, clicks, types and fills in forms on the sites you approve. Needs the Foxleash program on the same computer. Linux only.

## Description

Foxleash lets an AI agent on your own computer, such as Claude Code, use your Firefox for you, in your normal Firefox profile with your logins. The agent opens tabs, and it reads pages, clicks, types and fills in forms only on sites you approve. Foxleash contains no AI model: it makes no model API calls and holds no API keys.

Install steps, the full list of tools and every safeguard with its exceptions are in the project on GitHub: https://github.com/mattiasw/foxleash

Foxleash needs two things on the same computer: the Foxleash program, which needs Node.js 24 or later, and an AI agent. It runs on Linux only, with Firefox desktop 153 or later. When you install the extension, it opens a page that shows the command that installs the program and whether the program is connected.

The main risk: Foxleash acts in your logged-in browser, and a web page can contain instructions aimed at the AI model, such as an instruction to send the contents of the page somewhere. This is called prompt injection. Models can be fooled by these, and no defense is complete.

What protects you:

- the agent reads and acts in pages only on sites you approved with your own click, and Foxleash asks you before the agent opens a site you have not approved,
- Foxleash acts only on tabs in the agent's own orange tab group, and the Foxleash button in the toolbar shows ON on the tabs an agent session can use,
- a built-in list of common financial and health sites is blocked by default,
- the pages the agent reads and the screenshots it takes do not show it the values of password fields, or of the text fields that Firefox fills in from your saved logins, addresses and cards,
- you can stop an agent session at any time in the extension's settings.

Each of these has limits, described in the privacy policy on this add-on's page and in full in the project's security document: https://github.com/mattiasw/foxleash/blob/main/docs/security.md

The agent can:

- open tabs and navigate them,
- read pages,
- click, type and fill in forms,
- take screenshots,
- read the console and network activity,
- upload files from allowed folders,
- propose recipes, written steps for a task across sites, which you read, edit and save or discard in Firefox,
- read the recipes you saved, and ask you to allow a saved recipe's sites for a session in one click,
- ask you on one page to allow the sites a task needs for a session in one click,
- download files from sites you approved into your Firefox download folder.

Firefox gives extensions no way to produce real user input, so all clicks and keystrokes are simulated. Actions that need a real user gesture (writing to the clipboard, entering fullscreen, opening a file picker, and opening pop-up windows and new tabs unless you allow pop-ups for the site) do not work, and neither do sites that ignore simulated events.

Foxleash does not work on Firefox for Android. It does not run in Firefox's private windows, so the agent never sees or acts in them, and it does not work at all when Firefox is set to never remember history, which makes every window private.

If your agent can also run programs on your computer, it can talk to the Foxleash program directly, and then some of Foxleash's checks do not apply to it, as the privacy policy describes. Your agent's own permission settings still apply on top of this, but do not rely on them alone. Avoid using Foxleash on sites where a mistake is costly (banking, health records, admin panels with destructive actions), and stay nearby while it works.

What the agent asks for goes from the extension to the Foxleash program on your computer and from there to the agent, which may send it on to its model provider. Apart from what the agent opens, downloads, types, uploads and submits in web pages on your behalf, Foxleash itself sends nothing anywhere else. The privacy policy on this add-on's page has the details.

For developers: Foxleash works with Claude Code or any other MCP client.

## Permissions

Why Foxleash requests each permission:

- nativeMessaging: talks to the Foxleash program on this computer, which relays to and from the agent.
- tabs: reads the URL and title of the agent's tabs, so the agent can list them and see where each ends up.
- tabGroups: keeps each agent session's tabs in its own orange Foxleash tab group, and acts only on tabs in it.
- scripting: runs its bundled scripts in the agent's tabs to read pages, click, type, fill in forms, record console messages and hand an uploaded file to a page, and during a screenshot adds a style sheet hiding protected fields' and drop-downs' text. It never runs code received from outside the extension.
- webRequest: lets the agent read the network requests of its tabs, with the Cookie, Set-Cookie, Authorization, Proxy-Authorization and request Content-Length headers redacted and request bodies reduced to their structure, never values, and the text of their fetch and XHR responses. It changes no request, nor a response's bytes.
- webRequestBlocking: Firefox lets an extension read only responses its blocking listener saw, so a recorded tab's fetch and XHR requests get one, returning at once. Others cancel: in an agent's tabs, or windows they opened, a page or frame load whose answer is not a web page, from a site not approved or blocked; a download's redirects to such sites; and while a load the agent started in its tab runs, its redirects to blocked sites.
- webRequestFilterResponse: reads the text of fetch and XHR responses, only from approved, not blocklisted sites, capped, with sign-in tokens redacted as a best effort.
- webNavigation: says when a navigation in the agent's tabs ends, lists a page's frames for screenshots, notes which show an error page, starts recording console messages and requests when an approved page loads or access to it begins, and ties windows the agent's tabs open to their session.
- downloads: saves a file the agent asks for in the download folder, with no file chooser, never over an existing file, with the user's cookies, only from approved, not blocklisted sites, redirects included. Cancels, deleting its file, a download that a blocked or unapproved site's service worker or page made in an agent's tab.
- storage: keeps settings, like approved sites and the blocklist, and the agent's tab groups, so their tabs stay checked after a restart.
- <all_urls>: the user may approve any site, so sites cannot be listed in advance. It is needed to run scripts in pages, see requests and take screenshots. It reads and acts in a page only while it is on a site the user approved with a click, not blocklisted. What it embeds from other sites, blocklisted ones too, can show up in what the agent reads.

Firefox for Android: not supported (no native messaging or tab groups).

The native messaging host is the foxleash program (apps/server/, Node.js 24), in the same public repository, https://github.com/mattiasw/foxleash: not extension code, not in the source archive.

## Data collection and handling

Foxleash lets an AI agent on your computer use your Firefox. When the agent asks for it, the extension sends page content and browsing activity to the Foxleash program on your computer, which passes it to the agent. The agent may send it on to the model provider it uses (for a cloud model, the company that runs the model), under that provider's terms, which Foxleash does not control.

Foxleash itself sends nothing anywhere else. It has no servers, no accounts, no analytics and no telemetry, and it contains no AI model. The extension talks only to the Foxleash program on your computer and, when the agent downloads a file, to the sites the file's address and its redirects lead to. Apart from those downloads, neither the extension nor the program makes network connections of its own. The program has two parts, one that your AI agent starts and one that Firefox starts: it talks to Firefox through native messaging and to the agent through the agent's standard input and output, and its two parts talk to each other through a local socket.

The extension declares these kinds of data to Firefox:

- Website content (websiteContent): page text and structure, form fields, screenshots, console messages, and the network requests a page makes (URLs, methods, resource types, status, timing, errors, headers, and of what each request sent the field names, the kind of each value and whether each is filled, never the values), and the text of the responses to fetch and XMLHttpRequest requests to sites you approved, capped, with sign-in token fields redacted as a best effort.
- Browsing activity (browsingActivity): the URLs and titles of the tabs on sites you approved in the agent's tab group, the site address of its other tabs, and where their navigations end.
- Authentication information (authenticationInfo): declared because the URLs and titles of tabs on sites you approved, network requests and responses, console messages and page content the agent reads can carry account details, passwords or sign-in tokens, even though the Cookie, Set-Cookie, Authorization and Proxy-Authorization headers are redacted, and so are, as a best effort, values in request addresses that look like sign-in credentials.

A web page can fool the agent, and no defense is complete, so Foxleash limits what a fooled agent can do:

- Each agent session works in its own orange tab group titled Foxleash, and Foxleash acts only on tabs in that group, including tabs you move into it and tabs that a page in the group opens, also after your own click.
- The agent reads and acts in a tab's page only while that page is on a site you approved. Content that page embeds from other sites, blocklisted ones included, can show up in what the agent reads. The results of the agent's actions, and of opening, navigating and waiting in a tab, also carry a view of the page, read like any page and only on sites you approved. Before the agent opens a page on a site you have not approved, Foxleash asks you in that tab whether to allow it: for this session, always, or not at all. The approval can only come from your click; nothing the agent sends can grant it.
- Foxleash also refuses clicks on links and form buttons that lead to another site or out of the browser. These checks cover where the tab goes, not what a page on an approved site loads or sends. Going back or forward, a redirect or a page's own scripts can still take a tab to a site you have not approved before Foxleash can ask. More in https://github.com/mattiasw/foxleash/blob/main/docs/security.md#site-approval
- For a tab in the group on a site you have not approved, the agent gets only the site's address (scheme, host and port), with no path, query or title, and for a local file or another page that is not a website, only the kind of address, such as file:.
- A built-in list of common financial and health sites is blocked by default: Foxleash refuses to open one of them, or to reload a tab that shows one, before anything is loaded, does not read or act in a tab's page while it shows one, and gives the agent such a tab only as its site's address, even if you approved the site. When the agent opens, reloads, or goes back or forward to an address that answers with a redirect to one of them, directly or after other redirects, Foxleash cancels that step before Firefox requests it, so that site gets no request and none of your cookies. For 5 minutes after the agent opens, reloads, or goes back or forward in a tab, a redirect step to one of them in any load of that tab is cancelled the same way, whoever starts the load. After such a cancel, Firefox can send a later load of that page straight to the blocked site: Foxleash cancels that too when the agent reloads the tab or goes back or forward onto the page. These cancels have exceptions, such as a step to the few sites, like addons.mozilla.org, whose requests Firefox hides from add-ons, every step while Foxleash lacks access to all websites, and a later load after Firefox restarts or in a copy of the tab. The list is short and cannot name every such site: a site that is not on it is not blocked until you add it in the extension's settings, and most sites with an IPv6 address in place of a domain cannot be blocked. More in https://github.com/mattiasw/foxleash/blob/main/docs/security.md#the-blocklist
- When the agent reads a page as text, Foxleash never gives it the values of password fields, of one-time code and card number fields that the page marks as such for autofill, or of text fields that Firefox filled in from your saved logins, addresses or cards, until you edit them, only whether they are filled. When a click or Enter by the agent would send a form with GET, and so put the value of such a field in the page's address, Foxleash refuses the action, unless the page's own script sends the form. These values can still reach the agent, for example when a site sends one back in a response or a downloaded file, when you send a form yourself with GET, when Firefox no longer highlights a field as filled in, when the page turns a password field into another kind of field, and in a drop-down that Firefox filled in. More in https://github.com/mattiasw/foxleash/blob/main/docs/security.md#protected-fields and https://github.com/mattiasw/foxleash/blob/main/docs/security.md#when-a-field-firefox-filled-in-shows-its-value-again
- Screenshots hide the text of the same fields and of drop-downs, also in frames from other sites, with exceptions, such as a password field in a frame that the frame turns into another kind of field, described in https://github.com/mattiasw/foxleash/blob/main/docs/security.md#screenshots
- When the agent reads a page's network requests, Foxleash never gives it the values a request sent, and as a best effort it replaces the values in request addresses that look like sign-in credentials with [redacted]. They can still reach it in an address or a response. More in https://github.com/mattiasw/foxleash/blob/main/docs/security.md#request-bodies and https://github.com/mattiasw/foxleash/blob/main/docs/security.md#request-addresses
- Foxleash gives the agent the text of the responses to a page's fetch and XMLHttpRequest requests, which it keeps only for requests to sites you approved that are not on the blocklist, and only for text content, cut to 32,768 characters, with access, refresh and ID tokens and JWTs redacted as a best effort. Foxleash passes every byte of each response on to the page unchanged and never changes a request; it cancels some loads, such as those this policy describes. If such a response fails while it arrives, the page gets the part that arrived as if it were complete. More in https://github.com/mattiasw/foxleash/blob/main/docs/security.md#response-bodies
- Tool results mark page content as untrusted, and the agent is told not to follow instructions found in pages.
- While Foxleash is asking you something in a tab, the agent cannot select another tab of its group, and Foxleash does not select the tabs it opens for the agent meanwhile. Firefox itself or a page may still select a tab. More in https://github.com/mattiasw/foxleash/blob/main/docs/security.md#questions-stay-in-front-of-you

What the agent sends or saves on your behalf:

- Whatever the agent puts in an address, types or submits in a page goes to that website, and to wherever that page sends it, as it would if you did it yourself.
- When an address the agent opens answers with a redirect to another site, Firefox sends that site all your cookies for it, including those that a link from another site would not carry, unless Foxleash cancels that step as described above. A page on an approved site can also load an address on another site that the agent gave it; that site then gets the address with whatever the agent put in it, and Foxleash does not ask.
- File uploads only read from allowed folders (the agent's working folder and your desktop's download folder by default), and refuse dotfiles, files named like keys, files that hold a PEM, OpenSSH, PuTTY, PGP or age private key, and files saved or changed in the last 5 seconds. Keys in other forms are not recognised. The page gets the file in its file field, or dropped where it takes dropped files, and then sends it to that site as a manual upload would. More in https://github.com/mattiasw/foxleash/blob/main/docs/security.md#uploads
- Downloads request only addresses on sites you approved that are not on the blocklist: the file's address and every address it redirects to. The request carries all your cookies for the file's site, as a request from that site's own page would, and an http:// address is requested over plain http, unless Firefox itself requires https for its host, so the file and your cookies for the site that are not marked Secure travel unencrypted. A redirect step to any other site is cancelled before Firefox requests it, apart from one to the few sites whose requests Firefox hides from add-ons. The file is saved only into your Firefox download folder, under a plain file name, never over an existing file, as the site sent it, with nothing hidden or redacted, so it can hold the value of a protected field and sign-in tokens. The agent gets the file's path and size and can read it with its own tools, and the download shows in Firefox's downloads panel and history. More in https://github.com/mattiasw/foxleash/blob/main/docs/security.md#downloads
- When the agent asks to save a screenshot, the Foxleash program writes it as a PNG file in the folder the agent works in, never outside that folder and never over an existing file, with the same text hidden as in every screenshot.

In the tabs of the agent's tab group, Firefox saves a file that a page loads, as from any page, but Foxleash stops a page or frame load whose answer comes from a site you have not approved, or that is on the blocklist, and is anything other than a web page. The request still reaches that site, with the cookies Firefox sends for it. A file such a site's service worker answers with, or a Blob file a page of such a site builds itself, is cancelled and removed right after Firefox starts saving it. In some cases that also cancels and removes a download of your own, in any tab. Some such files are still not stopped. Windows opened from those tabs are covered too until they close, with exceptions; other tabs outside the agent's group are not. More in https://github.com/mattiasw/foxleash/blob/main/docs/security.md#files-a-page-loads-in-the-agents-tabs

If your agent can also run programs on your computer, it can talk directly to the part of the Foxleash program that Firefox starts (the native host), not through the part that the agent starts (the MCP server). It then gets a new session of its own, which can use every site you allowed always without asking you and which a stop of another session does not reach, and the checks that the agent's part makes, such as the allowed upload folders, the refusal of key files and the untrusted marking, do not apply to it. For everything that reaches Firefox through Foxleash, the extension still enforces site approval, the blocklist, the hiding of tabs on other sites and of the values of protected fields such as passwords, the refusal of clicks that lead to another site and the download rules; no add-on can stop a program that changes your Firefox profile or presses keys on your desktop. Revoking the sites you allowed always and stopping its sessions makes such an agent ask you before it opens a site, and disabling Foxleash in Firefox's add-ons manager cuts it off from Foxleash while the add-on stays disabled. More in https://github.com/mattiasw/foxleash/blob/main/docs/security.md#the-risk

The extension keeps your settings, such as the sites you approved and the blocklist, and the recipes you write (each a task's name, description, sites and steps), in its local storage in your Firefox profile on this computer, which Firefox does not sync. It also keeps there a list of the tab groups it made for agent sessions, so that their tabs stay checked after a restart; past 200 groups it forgets the oldest that have no tab. The extension's settings page, in the Firefox add-ons manager, lists the sites you allowed always and lets you revoke each one, edit the blocklist, and write, edit and delete recipes. It also lists the sites you allowed or refused for each running agent session and the prompts you closed without an answer, and lets you forget each of those answers. Foxleash keeps them only in memory, never in storage, until the session ends. After that it still keeps in memory the sites you allowed for that session only, for the last 200 such sessions, to judge the files the tabs left in its group load, until Firefox restarts or Foxleash is updated or reloaded.

The settings page lists each running agent session with a Stop this session button: after your click Foxleash refuses every tool call of that session, also on sites you allowed always. Nothing the agent sends can undo the stop, which lasts until Firefox restarts or Foxleash is updated or reloaded; a new agent session is not stopped. More in https://github.com/mattiasw/foxleash/blob/main/docs/security.md#stopping-an-agent-session

A recipe is saved only by your click on Foxleash's page in Firefox, after you read it; nothing the agent sends can save one, and a saved recipe is read by later agent sessions as your instructions. Allowing a recipe's sites takes your click too. Allowing the sites an agent asks for takes your click too, on a page that shows only those sites, at most 20. Both grant the sites for the session only, never always, and sites on your blocklist or that you refused in the session stay so. When the agent asks, the extension gives it your recipes. They are text you wrote or approved for the agent, kept on this computer and handed only to your own agent program, so the add-on declares no further data collection category for them.

## Compatibility

Foxleash works on Firefox desktop 153 or later (`gecko.strict_min_version` `153.0`), on Linux:
the local program runs on Linux only.

It does not work on Firefox for Android. Firefox for Android has no `nativeMessaging` or
`tabGroups` API, and there is no local Foxleash program for the extension to talk to.

The manifest declares `"incognito": "not_allowed"`, so Firefox never runs the extension in
private windows, whatever an enterprise policy says, and the add-ons manager offers no switch
for it. When a user granted an earlier version access to private windows, Firefox removes that
permission once the extension starts as a version that declares the key.

The manifest has no `gecko_android` key, so AMO records each version for Firefox desktop
only. That is what each submission requests: `"compatibility": ["firefox"]` in the version
object of the AMO v5 API, which `web-ext sign` passes through `--amo-metadata`. It is also
AMO's default for an API submission that names no compatibility.

addons-linter still checks `data_collection_permissions` against Firefox for Android. When
`gecko_android` is absent it falls back to `gecko.strict_min_version` (153) for its Firefox
for Android checks, and Firefox for Android supports the key from 142, so the linter reports
no warning. The extension build fails on any linter error or warning.

Adding `gecko_android` to quiet the linter would make AMO mark every version compatible with
Firefox for Android. AMO takes Firefox for Android compatibility from that key. This is in
AMO's server code (addons-server, `Version.from_upload` and the version `compatibility`
field of its API), not in the public API documentation. A version whose manifest has the key
is marked compatible with Firefox for Android from its `strict_min_version`, even when the
submission requests Firefox only, and AMO's API refuses to remove that mark afterwards.

## Screenshots

The files are 1280x800, AMO's recommended size; `npm run screenshots:amo` retakes them (see
`docs/development.md`). Each item gives the file and, after the colon, its caption.

- `docs/amo/screenshots/1-approval-prompt.png`: Before the agent opens a site you have not allowed, Foxleash asks you in Firefox.
- `docs/amo/screenshots/2-tab-group.png`: The pages the agent opens stay together in an orange Foxleash tab group.
- `docs/amo/screenshots/3-settings.png`: In the settings you can see and stop running agent sessions, revoke the sites you allowed and edit the list of blocked sites.

## Listing details

- Slug: foxleash
- Category: other
- License: GPL-3.0-or-later, given to AMO as a custom license, because AMO's license list has no GPL-3.0-or-later slug and GPL-3.0-only would misstate the license
- Custom license name: GNU General Public License, version 3 or later
- Custom license text: Foxleash is free software under the GNU General Public License, version 3 or later (GPL-3.0-or-later). The full text: https://github.com/mattiasw/foxleash/blob/main/LICENSE
- Homepage: https://github.com/mattiasw/foxleash
- Support site: https://github.com/mattiasw/foxleash/issues
- Support email: none

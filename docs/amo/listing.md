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
> adds. No version may be submitted to AMO whose build lacks a capability this file states, or
> a safeguard that this file or `docs/security.md`, which it links for the safeguards, states.
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
> longer than AMO takes. It also fails when a pasted section links a file of this repository
> that is not tracked, or a heading that file does not have, and when a URL in a pasted
> section is followed directly by punctuation instead of a space or the end of its line.
>
> The Data collection and handling section links `docs/security.md` for the safeguards and
> their exceptions instead of repeating them, and the release check fails when that link is
> missing, or when the section holds a `<`, since markup could hide the link. So the check
> ties each safeguard claim of `docs/amo/listing-claims.json` to a
> sentence in this file or in `docs/security.md`, and a change to such a sentence there is
> checked like one here
> ([ADR 0108](../adr/0108-safeguard-claims-may-be-stated-in-the-security-document.md)).
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

Each of these has limits, described in the project's security document: https://github.com/mattiasw/foxleash/blob/main/docs/security.md

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

- nativeMessaging: talks to the Foxleash program on this computer, which relays to the agent.
- tabs: reads the address and title of the agent's tabs.
- tabGroups: keeps each agent session's tabs in their own tab group.
- scripting: runs bundled scripts in the agent's tabs to read and act in pages, and adds a style sheet hiding protected fields' and drop-downs' text in screenshots. It never runs code received from outside the extension.
- webRequest: lets the agent read its tabs' network requests.
- webRequestBlocking: Firefox requires it for reading responses. Also cancels some loads, such as a file from a blocked or unapproved site in the agent's tabs.
- webRequestFilterResponse: reads fetch and XHR responses from approved sites for the agent.
- webNavigation: sees when loads in the agent's tabs end, and lists a page's frames.
- downloads: saves files the agent asks for, and cancels and removes some others, such as one from a blocked or unapproved site in the agent's tabs.
- storage: keeps settings, such as approved sites and the blocklist.
- <all_urls>: the user may approve any site, so none can be listed beforehand.

The extension bundles an input probe (apps/extension/src/probe-page.ts), which the program's probe command runs in a tab on a site the user approved. It types short test words into the page's first text field and editors and clicks an expand or collapse toggle and a same-page link, to measure which simulated input the page accepts, and reports each element's tag, type, role and class names, never page text.

Firefox for Android: not supported.

The native messaging host is the foxleash program (apps/server/): not extension code, not in the source archive, but in the same public repository, https://github.com/mattiasw/foxleash

To test: Linux, Node.js 24 or later and an MCP client such as Claude Code; npx foxleash setup installs the program. Foxleash needs no account.

## Data collection and handling

When your AI agent asks, the extension sends page content and browsing activity to the Foxleash program on your computer, which passes it to the agent. The agent may send it on to its model provider (for a cloud model, the company that runs it), under that provider's terms, which Foxleash does not control.

Foxleash uses this data to answer the agent's requests and for its own checks. It has no servers, accounts, analytics or telemetry, and no AI model. The only network connections it makes itself are the agent's downloads.

The extension declares these kinds of data to Firefox:

- Website content (websiteContent): page text and structure, form fields, screenshots, console messages, the network requests a page makes (including addresses, status, the names of the fields sent, and headers, with the Cookie, Set-Cookie, Authorization, Proxy-Authorization and request Content-Length headers redacted), and the text of responses to requests that a page's scripts make to approved sites. The results of the agent's actions in a tab also carry a view of its page. This can include what a page on an approved site embeds from other sites, blocked ones too.
- Browsing activity (browsingActivity): the addresses and titles of the agent's tabs on approved sites, and the site address of its other tabs. Its tabs are those in its tab group: tabs it opens, tabs you move into the group and tabs its pages open.
- Authentication information (authenticationInfo): declared because the data above can carry account details, passwords or sign-in tokens. Foxleash hides or redacts some of these, not all.

The agent's actions also send and save data:

- What the agent puts in an address, types, submits or uploads in a page goes to that website, and wherever that page sends it. Uploads come from folders on your computer, by default the agent's working folder and your desktop's download folder.
- When an address the agent opens redirects to another site, Firefox sends that site your cookies for it. A page on an approved site can also load an address the agent gave it on another site, which gets that address with whatever the agent put in it, without Foxleash asking you.
- A download requests the file's address and those it redirects to, with your cookies for their sites, and an http:// address over plain http, so the file and your cookies not marked Secure travel unencrypted. The file is saved in your Firefox download folder as the site sent it, nothing hidden or redacted, and the agent gets its path and size and can read it with its own tools.
- A screenshot the agent saves becomes a PNG file in its working folder.
- A page in the agent's tabs can load a file from another site. Foxleash stops some such loads, but the request still reaches that site, with the cookies Firefox sends for it. Sometimes Foxleash also cancels and removes a download of your own, in any tab.

The extension keeps your settings, the sites you allowed always, the blocklist, your saved recipes (name, description, sites, steps) and a list of the agent's tab groups in local storage in your Firefox profile, which Firefox does not sync. Sites you allowed or refused for one session stay in memory only, at most until Firefox restarts or Foxleash is updated or reloaded. On the extension's settings page you can revoke a site you allowed always, edit the blocklist, edit and delete recipes, and stop a running session.

When the agent asks, it gets your saved recipes: text you wrote or approved, kept on this computer and handed only to your own agent program, so the add-on declares no further data collection category for them.

If your agent can also run programs on your computer, it can talk to the Foxleash program directly. It then gets its own session, which can use every site you allowed always without asking you, and some checks, such as the upload folders and the refusal of key files, do not apply to it. More in https://github.com/mattiasw/foxleash/blob/main/docs/security.md#the-risk

A web page can fool the agent, and no defense is complete. Foxleash's safeguards, such as site approval and the blocklist, are described with their exceptions in the project's security document, which follows the latest state of the project and can be ahead of your version: https://github.com/mattiasw/foxleash/blob/main/docs/security.md

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

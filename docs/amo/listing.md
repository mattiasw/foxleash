# AMO listing

> This file holds the text Foxhand gives Mozilla's add-on site (AMO) and what Mozilla's
> reviewers compare the extension with. Mozilla disables add-ons whose listing, manifest and
> behaviour disagree, so update this file in the same commit as any change to
> `permissions`, `host_permissions`, `data_collection_permissions`, the data that leaves
> the browser or where it goes, or what the extension can do on the user's behalf.
>
> It describes the feature set the first signed version declares. Permissions are fixed from
> the first release, because Firefox does not show users host permissions that an update
> adds. No version may be submitted to AMO whose build lacks a capability or safeguard this
> file states.
>
> Where each section goes on AMO:
>
> - **Name**, **Summary**, **Description**: the add-on fields of those names.
> - **Permissions**: the notes to reviewers ("Notes to Reviewer", the version's
>   `approval_notes`), given with every version.
> - **Data collection and handling**: the add-on's privacy policy. AMO keeps it apart from
>   the add-on and version metadata (it has its own page and API endpoint), so it is set on
>   its own, not through the submission metadata.
> - **Compatibility**: not text for AMO. It says which applications each version is
>   submitted for, and why.
>
> The body of a pasted section is everything between its heading and the next `##` heading.
> In those sections each paragraph and each list item is one line, and they hold plain
> sentences and `- ` list items only, because AMO's fields accept only a small subset of
> formatting.

## Name

Foxhand

## Summary

Lets an AI agent on your computer use your own Firefox through MCP tools: it opens tabs, and reads pages, clicks, types and fills in forms on the sites you approve.

## Description

Foxhand lets an AI agent on your own computer, such as Claude Code or any other MCP client, use your own Firefox through MCP tools, in your normal Firefox profile with your logins. Foxhand contains no AI model: it makes no model API calls and holds no API keys.

Foxhand has three parts:

- this extension, which carries out the actions,
- a native host that Firefox starts and that the extension talks to,
- an MCP server that your AI agent starts and that talks to the native host.

The native host and the MCP server are one program that runs on your computer and that you install separately. It needs Node.js 24 or later, and the project's README explains how to install it. The extension does nothing without it.

The agent can:

- open tabs and navigate them,
- read pages,
- click, type and fill in forms,
- take screenshots,
- read the console and network activity,
- upload files from allowed folders.

Each agent session works in its own orange tab group titled Foxhand, and Foxhand acts only on tabs in that group, including tabs you move into it. When the agent session ends, Foxhand closes its group if the group holds only blank tabs, so pages you may still be reading stay open.

Foxhand acts in your logged-in browser. The main risk is prompt injection: a web page can contain instructions aimed at the AI model, such as an instruction to send the contents of the page somewhere. Models can be fooled by these, and no defense is complete. Foxhand limits what a fooled agent can do:

- It reads and acts in a tab's page only while that page is on a site you approved in the browser. Content that page embeds from other sites can show up in what the agent reads, for example in a screenshot. The first time a session acts on a site, Foxhand asks you in that tab whether to allow it: once, always, or not at all. The approval can only come from your click; nothing the agent sends can grant it. You can see and revoke your answers in the extension's settings.
- A built-in list of common financial and health sites is blocked by default: Foxhand does not read or act in a tab's page while it shows one of them. You can edit the list.
- File uploads only read from allowed folders (the agent's working folder and ~/Downloads by default), and refuse dotfiles and files named like keys.
- Tool results mark page content as untrusted, and the agent is told not to follow instructions found in pages.

Opening a web address needs no approval, so a fooled agent can still send what it read to another website by putting it in an address it opens. Your agent's own permission settings still apply on top of this, but do not rely on them alone. Avoid using Foxhand on sites where a mistake is costly (banking, health records, admin panels with destructive actions), and stay nearby while it works.

Firefox gives extensions no way to produce real user input, so all clicks and keystrokes are simulated. Actions that need a real user gesture (opening pop-up windows, writing to the clipboard, entering fullscreen, opening a file picker) do not work, and neither do sites that ignore simulated events.

Foxhand runs on Linux only, with Firefox desktop 140 or later. It does not work on Firefox for Android.

What the agent asks for goes from the extension to the Foxhand program on your computer and from there to the agent, which may send it on to its model provider. The URLs and titles of the tabs in the agent's group reach the agent whether or not you approved their sites. Apart from what the agent opens, types, uploads and submits in web pages on your behalf, Foxhand itself sends nothing anywhere else.

## Permissions

Why Foxhand requests each permission in its manifest:

- nativeMessaging: the extension talks to the Foxhand program on the same computer, which relays between the extension and the user's AI agent. Without it the extension cannot work at all.
- tabs: Foxhand reads the URL and title of the tabs in the agent's tab group, so the agent can list its tabs and see where a tab ended up after it opened or navigated it. Without this permission Firefox gives an extension a tab's URL and title only for sites its host permissions cover, and the user can withdraw those in the add-ons manager.
- tabGroups: Foxhand keeps each agent session's tabs in its own orange tab group titled Foxhand, and acts only on tabs in that group.
- scripting: Foxhand runs its own scripts, bundled in the extension, in the pages of the agent's tabs to read them, click, type, fill in forms, record console messages and hand an uploaded file to a page's file field. It never runs code received from outside the extension.
- webRequest: lets the agent read the network requests of the tabs in its group (URLs, methods, status and headers), with the Cookie, Set-Cookie and Authorization headers redacted. Foxhand does not block or change any request.
- webNavigation: the agent's wait tool uses it to know when a navigation in one of the agent's tabs has finished, so the next step starts on the loaded page.
- storage: keeps the user's settings, such as the sites the user approved and the blocklist, in the extension's local storage in the user's Firefox profile.
- <all_urls>: the agent may work on any site the user approves, so the extension cannot list the sites in advance. It needs this to run its scripts in pages, see their network requests and take screenshots. It reads and acts in a tab's page only while that page is on a site the user approved with a click in the browser and not on its blocklist of financial and health sites. Content that page embeds from other sites, blocklisted ones included, can show up in what the agent reads, for example in a screenshot.

Firefox for Android: Foxhand does not work on Firefox for Android, which has no native messaging or tab groups, so the manifest has no gecko_android key and each version is submitted for Firefox desktop only. The linter still reports one warning, that Firefox for Android supports data_collection_permissions only from version 142, because without gecko_android it checks Firefox for Android against the gecko strict_min_version of 140. That warning is expected.

## Data collection and handling

Foxhand lets an AI agent on your computer use your Firefox. This describes what data the Foxhand extension handles and where it goes.

When your AI agent asks for it, the extension sends page content and browsing activity to the Foxhand program on your computer, which passes it to the agent. The agent may send it on to the model provider it uses (for a cloud model, the company that runs the model), under that provider's terms, which Foxhand does not control.

What the agent can reach:

- Only tabs in the agent's Foxhand tab group, such as tabs it opened there and tabs you moved into it.
- Page content (page text, form fields, screenshots, console messages and network requests) comes only from what a tab showed or loaded while its page was on a site you approved with a click in the browser. It can include what that page loads or shows from other sites, blocklisted ones included. The agent cannot approve a site.
- The URLs and titles of the tabs in the group go to the agent whether or not you approved their sites.
- Foxhand lets the agent open web addresses without asking you. Whatever it puts in an address, types or submits in a page goes to that website, and to wherever that page sends it, as it would if you did it yourself.
- A built-in list of common financial and health sites is blocked by default: Foxhand does not read or act in a tab's page while it shows one of them, though the tab's URL and title still reach the agent. You can edit the list.

Foxhand itself sends nothing anywhere else. It has no servers, no accounts, no analytics and no telemetry. The extension talks only to the Foxhand program on your computer, and neither the extension nor the program makes network connections of its own: the program talks to Firefox through native messaging and to the agent through the agent's standard input and output, and its two parts talk to each other through a local socket. Foxhand contains no AI model.

The extension declares these kinds of data to Firefox:

- Website content (websiteContent): page text and structure, form fields, screenshots, console messages, and the network requests a page makes (URLs, methods, status and headers).
- Browsing activity (browsingActivity): the URLs and titles of the tabs in the agent's tab group, and where their navigations end.
- Authentication information (authenticationInfo): declared because the tab URLs and titles, network request URLs and headers, console messages and page content the agent reads can carry account details, passwords or sign-in tokens, even though the Cookie, Set-Cookie and Authorization headers are redacted. Tab URLs and titles reach the agent whether or not you approved their sites.

When the agent uploads a file, the Foxhand program reads it only from folders you allowed and refuses dotfiles and files named like keys. The extension hands it to the page's file field. The page then sends it to that site as a manual upload would.

The extension keeps your settings, such as the sites you approved and the blocklist, in its local storage in your Firefox profile, which Firefox does not sync.

## Compatibility

Foxhand works on Firefox desktop 140 or later (`gecko.strict_min_version` `140.0`), on Linux:
the local program runs on Linux only.

It does not work on Firefox for Android. Firefox for Android has no `nativeMessaging` or
`tabGroups` API, and there is no local Foxhand program for the extension to talk to.

The manifest has no `gecko_android` key, so AMO records each version for Firefox desktop
only. That is what each submission requests: `"compatibility": ["firefox"]` in the version
object of the AMO v5 API, which `web-ext sign` passes through `--amo-metadata`. It is also
AMO's default for an API submission that names no compatibility.

addons-linter still checks `data_collection_permissions` against Firefox for Android. When
`gecko_android` is absent it falls back to `gecko.strict_min_version` (140) for its Firefox
for Android checks, and Firefox for Android supports the key only from 142, so it reports
`KEY_FIREFOX_ANDROID_UNSUPPORTED_BY_MIN_VERSION`. The extension build accepts that as its
one expected warning and fails on any other.

Adding `gecko_android` to quiet the linter would make AMO mark every version compatible with
Firefox for Android. AMO takes Firefox for Android compatibility from that key. This is in
AMO's server code (addons-server, `Version.from_upload` and the version `compatibility`
field of its API), not in the public API documentation. A version whose manifest has the key
is marked compatible with Firefox for Android from its `strict_min_version`, even when the
submission requests Firefox only, and AMO's API refuses to remove that mark afterwards.

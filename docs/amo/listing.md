# AMO listing

> This file holds the text Foxleash gives Mozilla's add-on site (AMO) and what Mozilla's
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
>   `approval_notes`), given with every version. AMO takes at most 3000 characters.
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

Foxleash

## Summary

Lets an AI agent on your computer use your own Firefox through MCP tools: it opens tabs, and reads pages, clicks, types and fills in forms on the sites you approve.

## Description

Foxleash lets an AI agent on your own computer, such as Claude Code or any other MCP client, use your own Firefox through MCP tools, in your normal Firefox profile with your logins. Foxleash contains no AI model: it makes no model API calls and holds no API keys.

Foxleash has three parts:

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
- upload files from allowed folders,
- propose recipes, written steps for a task across sites, which you read, edit and save or discard in Firefox, and read the recipes you saved, and ask you to allow a saved recipe's sites for a session in one click,
- download files from sites you approved into your Firefox download folder.

Each agent session works in its own orange tab group titled Foxleash, and Foxleash acts only on tabs in that group, including tabs you move into it and tabs that a page in the group opens, also after your own click. When the agent session ends, Foxleash closes its group if the group holds only blank tabs, so pages you may still be reading stay open. The Foxleash button in the toolbar shows ON on the tabs an agent session can use, and clicking it opens Foxleash's settings.

Foxleash acts in your logged-in browser. The main risk is prompt injection: a web page can contain instructions aimed at the AI model, such as an instruction to send the contents of the page somewhere. Models can be fooled by these, and no defense is complete. Foxleash limits what a fooled agent can do:

- It reads and acts in a tab's page only while that page is on a site you approved in the browser. Content that page embeds from other sites can show up in what the agent reads, for example in a screenshot. Before the agent opens a page on a site you have not approved, Foxleash asks you in that tab whether to allow it: for this session, always, or not at all. The approval can only come from your click; nothing the agent sends can grant it. The sites you allowed always are listed in the extension's settings, where you can revoke them. The settings also list the sites you allowed or refused for each running agent session, and the prompts you closed without an answer, where you can forget each of those answers.
- A built-in list of common financial and health sites is blocked by default: when the agent asks to open one of them or to reload a tab that shows one, Foxleash refuses before anything is loaded, and it does not read or act in a tab's page while it shows one of them. Such a tab reaches the agent only as its site's address, even if you approved the site. You can edit the list in the extension's settings.
- File uploads only read from allowed folders (the agent's working folder and ~/Downloads by default), and refuse dotfiles and files named like keys.
- Downloads save only a file served by a site you approved, after any redirects, and only into your Firefox download folder under a plain file name, never over an existing file.
- A recipe is saved only by your click on Foxleash's page in Firefox, after you read it; nothing the agent sends can save one, and a saved recipe is read by later agent sessions as your instructions, so read it before saving.
- Allowing a recipe's sites takes your click too, grants them for the session only, never always, and sites on your blocklist or that you refused in the session stay so.
- Tool results mark page content as untrusted, and the agent is told not to follow instructions found in pages.
- When the agent reads a page as text, Foxleash never gives it the values of password fields, of one-time code and card number fields that the page marks as such for autofill, or of text fields that Firefox filled in from your saved logins, addresses or cards, until you edit them, only whether they are filled: Firefox fills saved passwords into login pages when they load, and a page you approved could otherwise hand yours to the agent. A password field that the page turns into another kind of field stays protected only if the agent read the page, took a screenshot of it or acted in it while it was still a password field, and a text field that the page puts in its place shows its value. A text field Firefox filled in shows its value again once Firefox no longer highlights it as filled in: after you edit it; after the page's own scripts report a change to it, reload the page or go back or forward; after the agent goes back or forward to a page that a form sent with POST or that holds a frame a form sent with POST, or to a page on a site you had not approved and then approve; in a frame, after the agent goes back or forward and only that frame changes; after a tab that was unloaded, by you or by Firefox to save memory, is loaded again; and after Firefox restores your windows and tabs when it starts again. Possibly also after you reopen a tab or window you closed; after the agent goes back or forward and the page delays that, or Firefox delays telling Foxleash about the page's request, by more than a second, or the computer's clock is set back meanwhile; and to another tool call that reads the page while the agent goes back or forward to it. Screenshots hide the text of the same fields, also in frames from other sites, with a style sheet Foxleash adds to each frame while it takes the screenshot; if a frame does not take that style sheet, Foxleash takes no screenshot, unless that frame shows Firefox's error page for a page that could not be loaded or does not allow being shown in a frame, or is a frame of another add-on, such as a password manager's menu, or lies inside one. While it takes a screenshot of a page with such a frame, Foxleash hides that frame and every other frame of the page or frame that holds it, so none of their content is in the screenshot.

Foxleash asks before it opens a page on a site you have not approved, and it refuses clicks on links and form buttons that lead to another site or out of the browser, such as to an email address, so a fooled agent cannot send what it read to another site by putting it in an address, with two exceptions: going back or forward in a tab's history can return to a page on a site you have not approved, and a page on an approved site can redirect, including through an address the agent chose, or send the tab to another site with its own scripts, for example after a click, before Foxleash can ask. In both cases the agent sees only that site's address. A page's own scripts can also open an email address. Your agent's own permission settings still apply on top of this, but do not rely on them alone. Avoid using Foxleash on sites where a mistake is costly (banking, health records, admin panels with destructive actions), and stay nearby while it works.

Firefox gives extensions no way to produce real user input, so all clicks and keystrokes are simulated. Actions that need a real user gesture (writing to the clipboard, entering fullscreen, opening a file picker, and opening pop-up windows and new tabs unless you allow pop-ups for the site) do not work, and neither do sites that ignore simulated events.

Foxleash runs on Linux only, with Firefox desktop 142 or later. It does not work on Firefox for Android.

About the name: the agent works in your Firefox on a leash that you hold, and a leash is also an old collective noun for foxes, as in a leash of foxes.

What the agent asks for goes from the extension to the Foxleash program on your computer and from there to the agent, which may send it on to its model provider. For a tab in the agent's group on a site you approved, the agent gets its URL and title. For any other tab in its group it gets only the site's address (scheme, host and port), with no path, query or title, and for a local file or another page that is not a website, only the kind of address, such as file:. Apart from what the agent opens, downloads, types, uploads and submits in web pages on your behalf, Foxleash itself sends nothing anywhere else.

## Permissions

Why Foxleash requests each permission in its manifest:

- nativeMessaging: the extension talks to the Foxleash program on the same computer, which relays between the extension and the user's AI agent.
- tabs: Foxleash reads the URL and title of the tabs in the agent's tab group, so the agent can list its tabs and see where a tab ended up after it opened or navigated it.
- tabGroups: Foxleash keeps each agent session's tabs in its own orange tab group titled Foxleash, and acts only on tabs in that group.
- scripting: Foxleash runs its own scripts, bundled in the extension, in the agent's tabs to read pages, click, type, fill in forms, record console messages and hand an uploaded file to a page. During a screenshot it adds a style sheet that hides the text of password fields, of one-time code and card number fields marked for autofill, and of fields Firefox filled in from saved logins, addresses or cards, until the user edits them. It never runs code received from outside the extension.
- webRequest: lets the agent read the network requests of the tabs in its group, with the Cookie, Set-Cookie, Authorization and Proxy-Authorization headers redacted. Foxleash does not block or change any request.
- webNavigation: tells Foxleash when a navigation in one of the agent's tabs has finished, lists a page's frames for screenshots and notes which show Firefox's error page (in memory only), and starts recording console messages and network requests when a page loads on a site the user approved.
- downloads: the agent's download tool saves a file into the user's Firefox download folder without a file chooser and never over an existing file. The extension fetches the file with the user's cookies for that site and saves it only when the address the agent gave and the address after any redirects are on sites the user approved and not on the blocklist.
- storage: keeps the user's settings, such as the sites the user approved and the blocklist, in the extension's local storage.
- <all_urls>: the agent may work on any site the user approves, so the extension cannot list the sites in advance. It needs this to run its scripts in pages, see their network requests and take screenshots. It reads and acts in a page only while it is on a site the user approved with a click in the browser and not on its blocklist of financial and health sites. Content that page embeds from other sites, blocklisted ones included, can show up in what the agent reads.

Firefox for Android: not supported (no native messaging or tab groups), so each version is submitted for Firefox desktop only.

The native messaging host is the foxleash command from the same repository (apps/server/), run with Node.js 24. It is not extension code and is not in the source archive. The repository is private while Foxleash is in development; we can provide the program to you on request.

## Data collection and handling

Foxleash lets an AI agent on your computer use your Firefox. This describes what data the Foxleash extension handles and where it goes.

When your AI agent asks for it, the extension sends page content and browsing activity to the Foxleash program on your computer, which passes it to the agent. The agent may send it on to the model provider it uses (for a cloud model, the company that runs the model), under that provider's terms, which Foxleash does not control.

What the agent can reach:

- Only tabs in the agent's Foxleash tab group, such as tabs it opened there, tabs you moved into it and tabs that a page in the group opened.
- Page content (page text, form fields, screenshots, console messages and network requests) comes only from what a tab showed or loaded while its page was on a site you approved with a click in the browser. It can include what that page loads or shows from other sites, blocklisted ones included. The agent cannot approve a site.
- For a tab on a site you approved, the agent gets its URL and title. For any other tab in the group it gets only the site's address (scheme, host and port), with no path, query or title, and for a local file or another page that is not a website, only the kind of address, such as file:.
- Foxleash asks you before the agent opens a page on a site you have not approved. The extension's settings list the sites you allowed or refused for each running agent session, where you can forget those answers. Going back or forward in a tab's history, and a page on an approved site that redirects or, with its own scripts, sends the tab to another site, for example after a click, can still reach a site you have not approved without asking; the agent then sees only that site's address. Whatever the agent puts in an address, types or submits in a page goes to that website, and to wherever that page sends it, as it would if you did it yourself.
- A built-in list of common financial and health sites is blocked by default: when the agent asks to open one of them or to reload a tab that shows one, Foxleash refuses before anything is loaded, and it does not read or act in a tab's page while it shows one of them. Such a tab reaches the agent only as its site's address, even if you approved the site. You can edit the list in the extension's settings.

Foxleash itself sends nothing anywhere else. It has no servers, no accounts, no analytics and no telemetry. The extension talks only to the Foxleash program on your computer and, when the agent downloads a file, to the sites the file's address and its redirects lead to. Apart from those downloads, neither the extension nor the program makes network connections of its own: the program talks to Firefox through native messaging and to the agent through the agent's standard input and output, and its two parts talk to each other through a local socket. Foxleash contains no AI model.

The extension declares these kinds of data to Firefox:

- Website content (websiteContent): page text and structure, form fields, screenshots, console messages, and the network requests a page makes (URLs, methods, resource types, status, timing, errors and headers).
- Browsing activity (browsingActivity): the URLs and titles of the tabs on sites you approved in the agent's tab group, the site address of its other tabs, and where their navigations end.
- Authentication information (authenticationInfo): declared because the URLs and titles of tabs on sites you approved, network request URLs and headers, console messages and page content the agent reads can carry account details, passwords or sign-in tokens, even though the Cookie, Set-Cookie, Authorization and Proxy-Authorization headers are redacted. Other tabs in the group show the agent only their site's address.

When the agent uploads a file, the Foxleash program reads it only from folders you allowed and refuses dotfiles and files named like keys. The extension hands it to the page's file field, or drops it where the page takes dropped files. The page then sends it to that site as a manual upload would.

When the agent asks to download a file, the extension requests it from the site with your cookies for that site, as following the link would, and saves it in your Firefox download folder on this computer under the name the agent gives, never over an existing file. It saves the file only when the address the agent gave, and the address the file comes from after any redirects, are on sites you approved and not on the blocklist. On the way, a redirect can make Firefox request an address on a site you have not approved, with your cookies for that site, as following the link would; nothing from such a site is saved. The agent gets the file's path and size, and can read the file from there with its own tools. The download shows in Firefox's downloads panel and history.

When the agent asks to save a screenshot, the Foxleash program on your computer writes it as a PNG file in the folder the agent works in, never outside that folder and never over an existing file. The file holds what the page showed, with the text hidden in password fields, in one-time code and card number fields that the page marks as such for autofill, and in text fields that Firefox filled in from your saved logins, addresses or cards, until you edit them.

The extension keeps your settings, such as the sites you approved and the blocklist, and the recipes you write (a task's steps with the sites it uses), in its local storage in your Firefox profile on this computer, which Firefox does not sync. The extension's settings page, in the Firefox add-ons manager, lists the sites you allowed always and lets you revoke each one, lets you edit the blocklist, and lets you write, edit and delete recipes. It also lists the sites you allowed or refused for each running agent session, and the prompts you closed without an answer, and lets you forget each of those answers. Foxleash keeps these session answers only in memory, never in storage, until the session ends. The agent can also propose a recipe. The extension then opens a page in the agent's tab group that shows the proposed name, description, sites and steps, and, when you have a recipe with that name, your saved version and the changes to its steps; the recipe is stored only when you click Save on that page. When the agent asks, the extension gives it your recipes: their names, descriptions, sites and steps. The agent can also ask you to allow a saved recipe's sites for its session. The extension then opens a page in the agent's tab group that lists them, the sites are allowed for that session only when you click Allow there, and the settings page lists them with the session's other answers. A recipe is text you wrote or approved for the agent, kept on this computer and handed only to your own agent program when it asks, so the add-on declares no further data collection category for it.

## Compatibility

Foxleash works on Firefox desktop 142 or later (`gecko.strict_min_version` `142.0`), on Linux:
the local program runs on Linux only.

It does not work on Firefox for Android. Firefox for Android has no `nativeMessaging` or
`tabGroups` API, and there is no local Foxleash program for the extension to talk to.

The manifest has no `gecko_android` key, so AMO records each version for Firefox desktop
only. That is what each submission requests: `"compatibility": ["firefox"]` in the version
object of the AMO v5 API, which `web-ext sign` passes through `--amo-metadata`. It is also
AMO's default for an API submission that names no compatibility.

addons-linter still checks `data_collection_permissions` against Firefox for Android. When
`gecko_android` is absent it falls back to `gecko.strict_min_version` (142) for its Firefox
for Android checks, and Firefox for Android supports the key from 142, so the linter reports
no warning. The extension build fails on any linter error or warning.

Adding `gecko_android` to quiet the linter would make AMO mark every version compatible with
Firefox for Android. AMO takes Firefox for Android compatibility from that key. This is in
AMO's server code (addons-server, `Version.from_upload` and the version `compatibility`
field of its API), not in the public API documentation. A version whose manifest has the key
is marked compatible with Firefox for Android from its `strict_min_version`, even when the
submission requests Firefox only, and AMO's API refuses to remove that mark afterwards.

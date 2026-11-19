# 0002: The safeguards live in Foxleash, not in the MCP client

**Status:** Accepted, 2026-10-17. Its default upload folder `~/Downloads` is superseded by [0095](0095-uploads-default-to-the-desktop-download-folder.md), 2026-11-19.

## Context

This record is Foxleash's threat model.

Foxleash acts in the user's logged-in browser. The main threat is prompt injection: content
on a web page that tells the model to do something the user did not ask for, such as
sending the page's contents somewhere. Models can be fooled this way. Anthropic measured
an 11.2% prompt-injection success rate for its Chrome extension after mitigations
([Anthropic's post on Claude for Chrome](https://claude.com/blog/claude-for-chrome)).

The MCP client usually asks the user before a tool runs, but those prompts are not a floor
Foxleash can rely on. Users can switch them off, with a bypass mode or with one allow rule
for the whole server. So the protection has to sit in Foxleash itself, where no client
setting can switch it off.

## Decision

Foxleash keeps these invariants:

1. **Per-site approval in the browser.** The first time a session acts on a site, the
   extension asks the user in that tab: once, always, or no. Only a user click grants
   approval. Nothing that arrives over native messaging or MCP can grant it. Approved
   sites are listed in the extension's settings, where the user can revoke them.
2. **A default blocklist of financial and health sites.** A short built-in list of domain
   patterns, which the user can edit. Foxleash refuses these sites without a prompt.
3. **Upload folders.** `upload_file` reads only from allowed folders: by default the MCP
   client's working directory and `~/Downloads`, and the user can change the list. It
   refuses dotfiles and files shaped like keys, and logs every upload.
4. **Untrusted page content.** Every tool result marks page content as untrusted, and the
   server's MCP instructions tell the agent not to follow instructions found in pages.
5. **A private socket directory.** The host's socket lives in a directory with mode 0700,
   as described in [0001](0001-two-processes-joined-by-a-unix-socket.md).
6. **A visible indicator.** Tabs under control show it in the extension badge and in the
   tab group title.

Only the user can change the blocklist and the allowed upload folders, just as only the
user can grant approval. No tool call and no tool parameter can change either list.

Weakening any of these invariants takes a new ADR that supersedes this one.

## Alternatives rejected

- **Rely on the MCP client's permission prompts.** Users can switch them off, and Foxleash
  cannot see whether they are on. A safeguard that can be off without Foxleash knowing is
  not a floor.
- **Grant approval from the MCP side**, for example with a tool parameter or a confirm
  tool. The model that would call it is the one a page may have fooled, so an injected
  model could approve itself. The same goes for a tool that edits the blocklist or the
  upload folders: an injected model could unblock a site or widen its own folders.
- **No default blocklist.** The sites where a fooled agent does the most damage would then
  be open until the user thought to block them. A short default list costs little, and the
  user can edit it.

## Consequences

Some risk remains. An approved site can still carry injected content, and the model can
still act on it within that site. No defense against prompt injection is complete.
README.md's Security section states this risk for users.

The safeguards bound what a model can do through Foxleash's tools. If the MCP client also
lets the model run shell commands as the user, the model can change Foxleash's files and
settings outside those tools, and Foxleash cannot prevent that.

The approval prompt adds a step on the first visit to each site. That friction is the
price of keeping the decision with the user.

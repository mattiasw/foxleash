# 0095: Uploads default to the desktop's download folder, read from user-dirs.dirs

**Status:** Accepted, 2026-11-19. Supersedes the default folder `~/Downloads` of
[0012](0012-upload-path-policy.md) and [0002](0002-safeguards-live-in-foxleash-not-the-mcp-client.md).

## Context

The default upload folders were the folder `foxleash mcp` was started in and `~/Downloads`. On an
Ubuntu 26.04 desktop in Swedish, `xdg-user-dir DOWNLOAD` prints `/home/<user>/Hämtningar`, and
Firefox from the .deb, the Snap and the Flatpak all saved downloads there. The `download` tool
returned `/home/<user>/Hämtningar/check12.txt`, and `upload_file` of that path was refused as
outside the upload folders. Any desktop whose download folder is translated or moved has the same
problem.

Measured on Firefox 153.7.0esr without starting it: `libxul.so` holds the literals of
xdg-user-dirs' reference lookup (`xdg-user-dir-lookup.c`: `/.config/user-dirs.dirs`,
`/user-dirs.dirs`, `$HOME/`, `XDG_CONFIG_HOME`) and imports no `g_get_user_special_dir`, so Firefox
carries its own copy of that lookup rather than GLib's. When the lookup names no folder,
`DownloadIntegration.sys.mjs` uses `<home>/<downloadsFolder>`, where `downloadsFolder` is a
translated string, `Downloads` in the en-US build.

## Decision

The second default upload folder is the desktop's download folder, which replaces `~/Downloads`.
`downloadFolder` in `apps/server/src/upload-policy.ts` finds it once, when `foxleash mcp` starts:

- The file is `user-dirs.dirs` in `XDG_CONFIG_HOME` when that is set and absolute, else in
  `~/.config`. `XDG_CONFIG_HOME` and the home folder come from the environment the MCP client
  starts `foxleash mcp` with, not from Firefox's.
- It is read only when it is a regular file of at most 64 KiB, opened without blocking, so a FIFO
  or a device there cannot hang or exhaust the server. Anything else, or any read error, gives
  `~/Downloads`.
- The text is parsed as the reference lookup parses it: each line, cut at a NUL, may start with
  spaces and tabs, then `XDG_DOWNLOAD_DIR`, optional spaces and tabs, `=`, optional spaces and tabs,
  and `"`. The value starts with `$HOME/`, which becomes the home folder followed by `/` (joined as
  text, so `$HOME//etc` stays under home), or with `/`. It runs to the first unescaped `"` or the
  end of the line; a backslash makes the next character literal. The last valid line wins. The
  bytes are decoded as UTF-8 with a leading BOM kept, so a first line after a BOM does not match,
  as in the reference.
- No valid line gives `~/Downloads`.
- The folder found goes through the same exclusions as before: one whose real path is the home
  folder or holds it, or lies in a folder whose name starts with a dot, is left out with a note,
  and is not replaced by `~/Downloads`.

A download folder chosen in Firefox's own settings is not read; the user adds it with
`FOXLEASH_UPLOAD_DIRS`.

## Alternatives rejected

- Both folders, the desktop's and `~/Downloads`: widens the defaults with a folder Firefox does not
  save into on such a desktop, so the file guard of
  [0081](0081-session-tabs-cancel-files-from-sites-the-session-may-not-act-on.md), which protects
  the folder Firefox saves into, does not cover it.
- Running `xdg-user-dir`: a child process at every start for a few lines of parsing, found through
  `PATH`, and not installed everywhere.
- Reading Firefox's `browser.download.dir`: needs profile discovery, and the server cannot tell
  which profile is in use.
- GLib's reading of the file: Firefox does not use it, so it could name another folder.

## Consequences

- Whoever can write `user-dirs.dirs` can move this default: the user and the user's own programs,
  the same trust as the MCP client's environment, which already sets `FOXLEASH_UPLOAD_DIRS`. No
  Foxleash tool writes there unless the config folder is itself Firefox's download folder, where
  `download` could create a missing `user-dirs.dirs`: downloads go only into that folder, under a
  plain name that does not start with a dot, never over an existing file. Screenshots save only
  `.png` names in the working folder.
- The file cannot make the home folder, `/`, `~/.ssh` or `~/.config` an upload folder: those are
  left out with a note. A folder outside home that is not under a dot folder, such as `/tmp`, is
  allowed, as with `FOXLEASH_UPLOAD_DIRS`, and Firefox saves there too.
- `~/Downloads` is no longer an upload folder on a desktop whose download folder is elsewhere.
- Known gaps and differences from Firefox: a download folder chosen in Firefox's settings; an MCP
  client whose `XDG_CONFIG_HOME` or home folder differs from Firefox's reads another file; a
  relative `XDG_CONFIG_HOME` counts as unset here, while the reference uses any non-empty value; a
  FIFO or a file over 64 KiB gives `~/Downloads` here; the reference reads lines in 512-byte pieces,
  so it sees the rest of a longer line as a new line, which xdg-user-dirs never writes; a folder
  name that is not valid UTF-8 is decoded with replacement characters, so it names a folder
  Firefox does not save into and its downloads are refused; `..` in `XDG_CONFIG_HOME` or in the
  value is resolved as text here, by the kernel there; a desktop with no `user-dirs.dirs` whose
  Firefox uses a translated folder name keeps `~/Downloads` (not measured whether language packs
  translate `downloadsFolder`).
- Not measured: where Firefox saves when the file says `XDG_DOWNLOAD_DIR="$HOME/"`, which
  xdg-user-dirs writes for a disabled folder. Foxleash leaves the home folder out, so only the
  working folder stays. If Firefox saves into `~/Downloads` there, uploads of its downloads are
  refused, which fails closed.
- The file is read once: a change takes effect when the MCP client restarts `foxleash mcp`.

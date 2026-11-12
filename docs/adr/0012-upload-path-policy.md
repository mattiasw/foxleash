# 0012: Uploads read only allowed folders, checked on the open descriptor, and travel in chunks

**Status:** Accepted, 2026-10-20.

## Context

The `upload_file` tool hands local files to a page: into a file field, or dropped on an
element. Page content can steer the agent to name any path, so ADR 0002 (invariant 3) has
uploads read only from allowed folders and never dotfiles or key files. That leaves open which
folders are allowed, what counts as a dotfile, and where and when the check runs.

The process that reads the file is `foxleash mcp`, started by the MCP client in its working
folder. Many clients start it in the home folder, which would allow everything below it.
Credentials often sit under a dot folder with a plain file name (`~/.aws/credentials`,
`~/.mozilla/firefox/<profile>/logins.json`). Between a check on a path and the read, a symlink
can be swapped, and opening a FIFO without `O_NONBLOCK` blocks until a writer appears; opening
a device can have side effects (a serial device resets many boards).

Firefox caps a message from the native host to the extension at 1 MB, and the bridge and the
host refuse a larger request. The host relays requests unchanged (ADR 0001).

## Decision

- **Folders** (`uploadFolders` in `apps/server/src/upload-policy.ts`, computed once when
  `foxleash mcp` starts). By default the folder `foxleash mcp` was started in and `~/Downloads`.
  A default whose real path is the home folder or one of its ancestors (`/`, `/home`), or
  that has a component starting with a dot, is left out with a note on stderr, so a symlinked
  `~/Downloads -> ~` or a client started in `~/.config` does not open the home folder or a dot
  folder. `FOXLEASH_UPLOAD_DIRS`, colon-separated absolute folders with a leading `~` expanded,
  replaces the defaults; an explicit home folder or dot folder is allowed there, and when no
  entry is usable no upload is possible. No tool parameter or message changes the folders.
- **Names**. A file is refused when any name below the folder that holds it starts with a dot
  (`.env*` included), or when its name is key-shaped: `id_*`, or with `.pem`, `.key`, `.p12`,
  `.pfx`, `.ppk`, `.jks` or `.keystore` as any of its extensions, also before a trailing `~`
  (`server.pem.bak`, `tls.key~`), in any case. Both the requested name and the
  real name are checked, so a link named `id_rsa` and a link `notes.txt` to `server.pem` are
  refused. A file passes when any folder holds it this way, so an explicit `~/.config/app`
  inside an explicit `~` still serves its own files.
- **The check before the open** (`readAllowedFile`). The requested path is resolved with
  `realpath` and `stat` and refused, without opening it, when it lies outside every folder,
  fails the name rules or is not a regular file. A path that cannot be resolved is judged by
  the real path of its longest leading part that exists, followed by the rest: it reads as
  outside unless that lies in a folder, so no answer tells which paths outside the folders
  exist, also through a link inside a folder to a folder outside it.
- **The deciding check, on the descriptor**. The file is opened with
  `O_RDONLY | O_NOCTTY | O_NONBLOCK`, and its real path is read from `/proc/self/fd/<fd>`; the
  folder and name rules run again on that path. `fstat` on the descriptor must show a regular
  file with a link count above 0 (a file deleted after the open shows its path with
  ` (deleted)` appended, which the name rules cannot judge) and a size that fits what is left
  of 10 MB for the call. Exactly that many bytes are read; a short or long read refuses the
  file as changed. All paths are read before any byte is sent: one refusal ends the call.
- **Chunks**. The MCP server sends the bytes of all files, concatenated, as `upload_chunk`
  requests of at most 512 KiB under a random upload id, then `upload_file` with the names,
  types and sizes. The extension's background (`apps/extension/src/uploads.ts`) stages chunks
  per session and upload id, only in order, at most 10 MB per session across its uploads,
  drops an upload 60 s after its last chunk and all of a session's at its end, and takes the
  bytes out before it validates anything else of `upload_file`.
- **In the page** (`apps/extension/src/page-upload.ts`). The files and their `DataTransfer`
  are built in the page's realm, through `window.wrappedJSObject` and `cloneInto`, because
  Firefox hides from the page the items a content script added. A file field gets the files
  through that `DataTransfer` and `input` and `change` events. Any other element gets `dragenter` and
  `dragover`, and `drop` only when the page canceled `dragover`, as in a real drag.

## Alternatives rejected

- **`realpath`, then open, as the deciding check.** A symlink swapped between the two would
  change what is read. `realpath` and `stat` still run first, but only so Foxleash does not
  open what it would refuse; the descriptor decides.
- **`O_PATH` with a check before the read.** Node does not expose it, and its value differs
  between architectures.
- **Chunking in the native host.** The host relays requests unchanged and would have to
  understand methods.
- **Always dispatching `drop`.** A page that did not cancel `dragover` would get a drop no
  real drag delivers.

## Consequences

- A path swapped between the check before the open and the open is opened before the
  descriptor check refuses it. Only a local process can race this.
- Hard links and bind mounts inside an allowed folder count as inside it.
- A page's `dragover` listener sees the files of a drop it then declines.
- Building the files calls the page's own `File`, `DataTransfer` and `items.add`, which the page
  can replace; they get only page-realm copies of the bytes, names and types the page receives
  anyway, so a page that replaces them spoils only its own upload. They are built only after a
  file field's checks pass, so a refused file field gets nothing.
- A default folder that later becomes a link to home is not checked again; the home rule runs
  at startup.
- A key with a plain name and no key extension, such as `deploy` holding a private key, is
  read.
- This refines ADR 0002 invariant 3 and does not supersede it.

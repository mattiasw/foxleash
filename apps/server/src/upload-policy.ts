import { constants, realpathSync } from "node:fs";
import { open, readlink, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { codeOf, hasDotPart, isInside } from "./save-file.ts";

export interface UploadFolders {
  folders: string[];
  notes: { folder: string; reason: string }[];
}

export type ReadResult =
  | { ok: true; path: string; name: string; bytes: Buffer }
  | { ok: false; reason: string };

/** What `readAllowedFile` needs of an open file; `FileHandle` is one. */
export interface ReadHandle {
  fd: number;
  stat(): Promise<{ isFile(): boolean; size: number; nlink: number }>;
  read(
    buffer: Buffer,
    offset: number,
    length: number,
    position: number,
  ): Promise<{ bytesRead: number }>;
  close(): Promise<void>;
}

export interface ReadContext {
  cwd: string | undefined;
  home: string;
  /** What is left of UPLOAD_MAX_BYTES for this call. */
  remaining: number;
  open?: (file: string, flags: number) => Promise<ReadHandle>;
}

const KEY_EXTENSIONS = new Set([
  "pem",
  "key",
  "p12",
  "pfx",
  "ppk",
  "jks",
  "keystore",
  "kdbx",
  "keytab",
  "skr",
]);
// Text only a private key's own file format holds, matched raw and as base64 (a kubeconfig's
// client-key-data is a base64 PEM key).
const PRIVATE_KEY_MARKERS = [
  "PRIVATE KEY-----", // PEM: PKCS#1, PKCS#8 (also encrypted), SEC1, OpenSSH
  "PRIVATE KEY BLOCK-----", // an armored OpenPGP secret key
  "PRIVATE KEY ----", // an SSH2 key as ssh.com and PuTTYgen write it
  "PuTTY-User-Key-File-", // a PuTTY .ppk key
  "AGE-SECRET-KEY-", // an age identity
  "openssh-key-v1\u0000", // an OpenSSH key's own bytes, also without its PEM lines
].flatMap((marker) => [marker, ...base64Forms(marker)]);
// The smallest real secret key packet body is larger; keeps small binary data, such as
// MessagePack arrays, from matching.
const MIN_KEY_BODY = 40;
// O_NONBLOCK: opening a FIFO swapped in after the pre-check would otherwise hang the server.
const OPEN_FLAGS = constants.O_RDONLY | constants.O_NOCTTY | constants.O_NONBLOCK;
const TYPES = new Map([
  ["pdf", "application/pdf"],
  ["png", "image/png"],
  ["jpg", "image/jpeg"],
  ["jpeg", "image/jpeg"],
  ["gif", "image/gif"],
  ["webp", "image/webp"],
  ["svg", "image/svg+xml"],
  ["txt", "text/plain"],
  ["csv", "text/csv"],
  ["json", "application/json"],
  ["html", "text/html"],
  ["htm", "text/html"],
  ["zip", "application/zip"],
  ["doc", "application/msword"],
  ["docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"],
  ["xls", "application/vnd.ms-excel"],
  ["xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"],
  ["mp3", "audio/mpeg"],
  ["mp4", "video/mp4"],
]);

const NUL = "contains a NUL character; give a path without one.";
const RELATIVE_WITHOUT_CWD =
  "is a relative path, and the folder Foxleash was started in no longer exists; give an absolute path.";
const DOT_NAME =
  "has a folder or file name starting with a dot below its upload folder; Foxleash never uploads those.";
const KEY_NAME = "is named like a key file; Foxleash never uploads those.";
const PRIVATE_KEY = "holds a private key; Foxleash never uploads those.";
const NOT_FILE = "is not a regular file; Foxleash uploads only files.";
const MISSING = "does not exist.";
const UNREADABLE = "cannot be read.";
const CHANGED = "changed while Foxleash read it; try again.";
const TOO_LARGE = "would bring this upload over 10 MB, the most Foxleash uploads in one call.";

/**
 * The folders uploads may read from, and a note for each folder left out. `FOXLEASH_UPLOAD_DIRS`
 * replaces the defaults, also when none of its entries is usable; the defaults are the folder
 * Foxleash was started in and `~/Downloads`, each unless it covers the whole home folder or lies
 * in a folder whose name starts with a dot.
 */
export function uploadFolders(ctx: {
  env: NodeJS.ProcessEnv;
  cwd: string | undefined;
  home: string;
}): UploadFolders {
  const configured = ctx.env.FOXLEASH_UPLOAD_DIRS;
  if (configured !== undefined && configured !== "") {
    return configuredFolders(configured, ctx.home);
  }
  return defaultFolders(ctx.cwd, ctx.home);
}

/**
 * Reads `requested` when it is a regular file inside one of `folders` with no name below the
 * folder starting with a dot and no key-shaped name, fits in `ctx.remaining`, and whose bytes
 * hold no private key. The deciding checks run on the real path and the bytes of the descriptor
 * that is read. Never throws for a file-system error: a refusal is one sentence that follows the
 * quoted path.
 */
export async function readAllowedFile(
  requested: string,
  folders: readonly string[],
  ctx: ReadContext,
): Promise<ReadResult> {
  // Before any fs call: open throws a TypeError, not an errno, on a NUL.
  if (requested.includes("\0")) return refused(NUL);
  const expanded = expandHome(requested, ctx.home);
  if (!path.isAbsolute(expanded) && ctx.cwd === undefined) return refused(RELATIVE_WITHOUT_CWD);
  const resolved = path.resolve(ctx.cwd ?? "/", expanded);
  const name = path.basename(resolved);
  // Also catches a symlink named like a dotfile or a key that leads to a plain file.
  if (name.startsWith(".")) return refused(DOT_NAME);
  if (keyShaped(name)) return refused(KEY_NAME);
  const realFolders = await existingRealFolders(folders);
  const early = await preCheck(resolved, folders, realFolders);
  if (early !== undefined) return refused(early);
  const openFile = ctx.open ?? openForRead;
  let handle: ReadHandle;
  try {
    handle = await openFile(resolved, OPEN_FLAGS);
  } catch (error: unknown) {
    return refused(fileSystemProblem(error));
  }
  try {
    const read = await readOpened(handle, folders, realFolders, ctx.remaining);
    return "reason" in read
      ? refused(read.reason)
      : { ok: true, path: read.path, name, bytes: read.bytes };
  } catch (error: unknown) {
    return refused(fileSystemProblem(error));
  } finally {
    await handle.close().catch(ignore);
  }
}

/** The MIME type for a file name's extension, or "" for one not in the map. */
export function fileType(name: string): string {
  return TYPES.get(path.extname(name).slice(1).toLowerCase()) ?? "";
}

function configuredFolders(configured: string, home: string): UploadFolders {
  const folders: string[] = [];
  const notes: UploadFolders["notes"] = [];
  for (const entry of configured.split(":")) {
    if (entry === "") continue;
    const expanded = expandHome(entry, home);
    if (path.isAbsolute(expanded)) {
      folders.push(path.resolve(expanded));
    } else {
      notes.push({ folder: entry, reason: "is not an absolute path" });
    }
  }
  return { folders, notes };
}

function defaultFolders(cwd: string | undefined, home: string): UploadFolders {
  const folders: string[] = [];
  const notes: UploadFolders["notes"] = [];
  const candidates: string[] = [];
  if (cwd === undefined) {
    notes.push({ folder: "the folder Foxleash was started in", reason: "no longer exists" });
  } else {
    candidates.push(path.resolve(cwd));
  }
  candidates.push(path.join(home, "Downloads"));
  const realHome = realOrResolved(home);
  for (const candidate of candidates) {
    const real = realOrResolved(candidate);
    const toHome = path.relative(real, realHome);
    if (toHome === "" || isInside(toHome)) {
      notes.push({
        folder: candidate,
        reason: "is your home folder or contains it, so it would cover your whole home folder",
      });
    } else if (hasDotPart(path.relative("/", real))) {
      notes.push({ folder: candidate, reason: "is inside a folder whose name starts with a dot" });
    } else {
      folders.push(candidate);
    }
  }
  return { folders, notes };
}

/** The real path, or the path as given when it cannot be resolved, such as one not made yet. */
function realOrResolved(folder: string): string {
  try {
    return realpathSync(folder);
  } catch {
    return path.resolve(folder);
  }
}

function expandHome(given: string, home: string): string {
  if (given === "~") return home;
  return given.startsWith("~/") ? path.join(home, given.slice(2)) : given;
}

/**
 * `id_*`, `krb5cc*` (Kerberos credential caches), `secring*` (PGP and GnuPG secret keyrings), or
 * a key extension anywhere after the first part: `server.pem.bak`, `tls.key~`.
 */
function keyShaped(name: string): boolean {
  const lower = name.toLowerCase();
  return (
    lower.startsWith("id_") ||
    lower.startsWith("krb5cc") ||
    lower.startsWith("secring") ||
    lower
      .split(".")
      .slice(1)
      .some((extension) => KEY_EXTENSIONS.has(extension.replace(/~+$/, "")))
  );
}

/** The real paths of the folders that exist now. */
async function existingRealFolders(folders: readonly string[]): Promise<string[]> {
  const real = await Promise.all(folders.map((folder) => realpath(folder).catch(ignore)));
  return real.filter((folder) => folder !== undefined);
}

/**
 * Why the path is refused before it is opened, or undefined: opening a device can have side
 * effects, and an open's error would tell which paths outside the folders exist.
 */
async function preCheck(
  resolved: string,
  folders: readonly string[],
  realFolders: readonly string[],
): Promise<string | undefined> {
  let real: string;
  let isFile: boolean;
  try {
    real = await realpath(resolved);
    isFile = (await stat(real)).isFile();
  } catch (error: unknown) {
    return missingProblem(error, await realPrefixed(resolved), folders, realFolders);
  }
  return placeProblem(real, folders, realFolders) ?? (isFile ? undefined : NOT_FILE);
}

/**
 * `resolved` with its longest leading part that exists replaced by that part's real path, so a
 * link inside a folder to a folder outside it does not make a missing path look inside.
 */
async function realPrefixed(resolved: string): Promise<string> {
  const rest: string[] = [];
  for (let head = resolved; head !== "/"; head = path.dirname(head)) {
    const real = await realpath(head).catch(ignore);
    if (real !== undefined) return path.join(real, ...rest);
    rest.unshift(path.basename(head));
  }
  return path.join("/", ...rest);
}

/** A path that cannot be resolved says "outside" unless `wouldBe` lies in a folder. */
function missingProblem(
  error: unknown,
  wouldBe: string,
  folders: readonly string[],
  realFolders: readonly string[],
): string {
  const inside = [...folders, ...realFolders]
    .map((folder) => path.relative(folder, wouldBe))
    .filter((relative) => relative !== "" && isInside(relative));
  if (inside.length === 0) return outside(folders);
  if (inside.every(hasDotPart)) return DOT_NAME;
  return fileSystemProblem(error);
}

/**
 * Why a file at real path `real` is not one uploads may read, or undefined: some folder must
 * hold it with no name below the folder starting with a dot, and its real name is not key-shaped.
 */
function placeProblem(
  real: string,
  folders: readonly string[],
  realFolders: readonly string[],
): string | undefined {
  let contained = false;
  for (const folder of realFolders) {
    const relative = path.relative(folder, real);
    if (relative === "" || !isInside(relative)) continue;
    if (!hasDotPart(relative)) return keyShaped(path.basename(real)) ? KEY_NAME : undefined;
    contained = true;
  }
  return contained ? DOT_NAME : outside(folders);
}

async function readOpened(
  handle: ReadHandle,
  folders: readonly string[],
  realFolders: readonly string[],
  remaining: number,
): Promise<{ path: string; bytes: Buffer } | { reason: string }> {
  // The descriptor's own path, so a symlink swapped after the pre-check cannot change what is read.
  const real = await readlink(`/proc/self/fd/${handle.fd}`);
  const problem = placeProblem(real, folders, realFolders);
  if (problem !== undefined) return { reason: problem };
  // Also refuses a descriptor whose link is no path, such as a pipe's "pipe:[...]".
  const info = await handle.stat();
  if (!info.isFile()) return { reason: NOT_FILE };
  // Deleted after the open: its link then ends in " (deleted)", so the name checks miss it.
  if (info.nlink === 0) return { reason: CHANGED };
  if (info.size > remaining) return { reason: TOO_LARGE };
  const bytes = Buffer.alloc(info.size);
  let offset = 0;
  while (offset < info.size) {
    const { bytesRead } = await handle.read(bytes, offset, info.size - offset, offset);
    if (bytesRead === 0) return { reason: CHANGED };
    offset += bytesRead;
  }
  const { bytesRead: beyond } = await handle.read(Buffer.alloc(1), 0, 1, info.size);
  if (beyond > 0) return { reason: CHANGED };
  if (holdsPrivateKey(bytes)) return { reason: PRIVATE_KEY };
  return { path: real, bytes };
}

function holdsPrivateKey(bytes: Buffer): boolean {
  return (
    startsWithSecretKeyPacket(bytes) || PRIVATE_KEY_MARKERS.some((marker) => bytes.includes(marker))
  );
}

/** Whether the file starts with an OpenPGP Secret-Key or Secret-Subkey packet that fits in it. */
function startsWithSecretKeyPacket(bytes: Buffer): boolean {
  const packet = firstPacket(bytes);
  if (packet === undefined || (packet.tag !== 5 && packet.tag !== 7)) return false;
  if (packet.length < MIN_KEY_BODY || packet.start + packet.length > bytes.length) return false;
  const version = bytes[packet.start];
  return version !== undefined && version >= 2 && version <= 6;
}

// RFC 9580 section 4.2: an old- or new-format packet header with a definite length.
function firstPacket(bytes: Buffer): { tag: number; start: number; length: number } | undefined {
  const first = bytes[0];
  if (first === undefined || (first & 0x80) === 0) return undefined;
  if ((first & 0x40) === 0) {
    const size = [1, 2, 4][first & 0x03];
    if (size === undefined || bytes.length < 1 + size) return undefined;
    const length =
      size === 1 ? bytes.readUInt8(1) : size === 2 ? bytes.readUInt16BE(1) : bytes.readUInt32BE(1);
    return { tag: (first >> 2) & 0x0f, start: 1 + size, length };
  }
  const tag = first & 0x3f;
  const octet = bytes[1];
  if (octet === undefined) return undefined;
  if (octet < 192) return { tag, start: 2, length: octet };
  if (octet <= 223) {
    const second = bytes[2];
    if (second === undefined) return undefined;
    return { tag, start: 3, length: ((octet - 192) << 8) + second + 192 };
  }
  if (octet === 255 && bytes.length >= 6) return { tag, start: 6, length: bytes.readUInt32BE(2) };
  return undefined;
}

/**
 * `marker` (ASCII) as it shows inside base64 wherever it starts in a 3-byte group: the
 * encoding of the whole groups it fills after skipping 0, 1 or 2 of its bytes.
 */
function base64Forms(marker: string): string[] {
  return [0, 1, 2].map((skip) => {
    const whole = marker.length - ((marker.length - skip) % 3);
    return Buffer.from(marker.slice(skip, whole)).toString("base64");
  });
}

function openForRead(file: string, flags: number): Promise<ReadHandle> {
  return open(file, flags);
}

function fileSystemProblem(error: unknown): string {
  const code = codeOf(error);
  return code === "ENOENT" || code === "ENOTDIR" ? MISSING : UNREADABLE;
}

function outside(folders: readonly string[]): string {
  const list = folders.length === 0 ? "none" : folders.join(", ");
  return `is outside the upload folders (${list}); the user can change them with FOXLEASH_UPLOAD_DIRS.`;
}

function refused(reason: string): ReadResult {
  return { ok: false, reason };
}

function ignore(): undefined {
  return undefined;
}

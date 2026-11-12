import { lstatSync, mkdirSync, readdirSync, type Stats } from "node:fs";
import path from "node:path";

export interface SocketDirResolution {
  dir: string;
  skipped: string[];
}

export type SocketDirCheck = { ok: true } | { ok: false; reason: string };

export interface SocketEntry {
  path: string;
  pid: number;
  mtimeMs: number;
}

export class SocketDirError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SocketDirError";
  }
}

const SOCKET_NAME = /^([1-9][0-9]{0,9})\.sock$/;
const MAX_PID = 0x7fffffff;
const MISSING = "does not exist";

export function resolveSocketDir(
  env: NodeJS.ProcessEnv,
  uid: number,
  runUserBase = "/run/user",
): SocketDirResolution {
  const skipped: string[] = [];
  const value = env.XDG_RUNTIME_DIR;
  if (value === "") {
    skipped.push("XDG_RUNTIME_DIR is empty");
  } else if (value !== undefined && !path.isAbsolute(value)) {
    skipped.push(`XDG_RUNTIME_DIR ${value} is not an absolute path`);
  } else if (value !== undefined) {
    // Checked on the same normalised string the result is built from.
    const base = path.resolve(value);
    const check = checkSocketDir(base, uid);
    if (check.ok) {
      return { dir: path.join(base, "foxleash"), skipped };
    }
    skipped.push(`XDG_RUNTIME_DIR ${base} ${check.reason}`);
  }
  const base = path.join(runUserBase, String(uid));
  const check = checkSocketDir(base, uid);
  if (check.ok) {
    return { dir: path.join(base, "foxleash"), skipped };
  }
  skipped.push(`${base} ${check.reason}`);
  // Literal /tmp, not os.tmpdir(): Firefox and the MCP client can give their children different
  // TMPDIRs, and both ends must agree.
  return { dir: `/tmp/foxleash-${uid}`, skipped };
}

export function checkSocketDir(dir: string, uid: number): SocketDirCheck {
  try {
    // Resolved, so a trailing slash or /. cannot make lstat follow a symlink.
    return checkStats(lstatSync(path.resolve(dir)), uid);
  } catch (error: unknown) {
    const code = errorCode(error);
    if (code === "ENOENT") {
      return { ok: false, reason: MISSING };
    }
    return { ok: false, reason: `cannot be read: ${code}` };
  }
}

function checkStats(stats: Stats, uid: number): SocketDirCheck {
  if (!stats.isDirectory()) {
    return { ok: false, reason: "is not a directory" };
  }
  if (stats.uid !== uid) {
    return { ok: false, reason: `belongs to uid ${stats.uid}, not you (uid ${uid})` };
  }
  // A named-user ACL entry is limited by the ACL mask, which stat reports as the group bits.
  if ((stats.mode & 0o077) !== 0) {
    const mode = (stats.mode & 0o777).toString(8).padStart(3, "0");
    return { ok: false, reason: `is open to other users (mode 0${mode})` };
  }
  return { ok: true };
}

function errorCode(error: unknown): string {
  if (typeof error === "object" && error !== null && "code" in error) {
    const { code } = error;
    if (typeof code === "string") {
      return code;
    }
  }
  return "UNKNOWN";
}

export function ensureSocketDir(dir: string, uid: number): void {
  const target = path.resolve(dir);
  try {
    // Not recursive: the base must already exist. A planted symlink gives EEXIST, then the check
    // refuses it.
    mkdirSync(target, { mode: 0o700 });
  } catch (error: unknown) {
    const code = errorCode(error);
    if (code !== "EEXIST") {
      throw new SocketDirError(sentence(target, `cannot be created: ${code}`));
    }
  }
  const check = checkSocketDir(target, uid);
  if (!check.ok) {
    throw new SocketDirError(sentence(target, check.reason));
  }
}

function sentence(dir: string, reason: string): string {
  return `The Foxleash socket directory ${dir} ${reason}; remove it, or set XDG_RUNTIME_DIR to a private directory, and try again.`;
}

export function socketPath(dir: string, pid: number): string {
  return path.join(dir, `${pid}.sock`);
}

export function listSockets(dir: string, uid: number): SocketEntry[] {
  const target = path.resolve(dir);
  // The entry checks below mean nothing in a directory another user can swap.
  const check = checkSocketDir(target, uid);
  if (!check.ok) {
    if (check.reason === MISSING) {
      return [];
    }
    throw new SocketDirError(sentence(target, check.reason));
  }
  const entries: SocketEntry[] = [];
  for (const name of readNames(target)) {
    const pid = pidFromName(name);
    if (pid === undefined) {
      continue;
    }
    const entryPath = path.join(target, name);
    try {
      const stats = lstatSync(entryPath);
      if (stats.isSocket() && stats.uid === uid) {
        entries.push({ path: entryPath, pid, mtimeMs: stats.mtimeMs });
      }
    } catch {
      // Vanished since readdir, or cannot be verified as the user's socket: not offered.
    }
  }
  return entries.sort((a, b) => b.mtimeMs - a.mtimeMs);
}

function readNames(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch (error: unknown) {
    throw new SocketDirError(sentence(dir, `cannot be read: ${errorCode(error)}`));
  }
}

function pidFromName(name: string): number | undefined {
  const match = SOCKET_NAME.exec(name);
  if (match === null) {
    return undefined;
  }
  const pid = Number(match[1]);
  return pid <= MAX_PID ? pid : undefined;
}

export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error: unknown) {
    return errorCode(error) !== "ESRCH";
  }
}

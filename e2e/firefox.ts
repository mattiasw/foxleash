import { type ChildProcess, spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { connect as connectTcp } from "node:net";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { EXTENSION_ID } from "@foxhand/protocol";

/**
 * Firefox's own lifetime, enforced by a watchdog inside its process group (LIFETIME_WRAPPER).
 * Above the sum of a test file's deadlines (the longest: setup hook 120 s, eight tests at 60 s
 * and one at 90 s, teardown hook 60 s = 750 s), so it never cuts a slow run short. It fires
 * only when the harness could not clean up, for example when node was killed with SIGKILL and
 * none of its handlers ran.
 */
export const FIREFOX_LIFETIME_SECONDS = 900;

/**
 * Starts a watchdog that SIGKILLs the process group whose id is the wrapper's own pid ($$, which
 * a subshell keeps) after $1 seconds, then execs Firefox, which so keeps that pid. The spawn is
 * detached, so that group is Firefox's alone. Named by id rather than `kill 0` on purpose: were
 * the spawn ever not detached, `kill 0` would kill the caller's group (the test runner, the
 * shell); a group id that does not exist is only an ESRCH. The watchdog holds no pipe open, so it
 * cannot keep node waiting, and it stays a member of the group until it fires, so the id cannot
 * be reused under it.
 *
 * Not `timeout -s KILL`: GNU timeout signals the whole group, but uutils coreutils' timeout
 * (0.8.0) sends the KILL to the command only, which was measured leaving a grandchild running.
 */
const LIFETIME_WRAPPER =
  'lifetime=$1; shift; (sleep "$lifetime"; kill -s KILL -- "-$$") </dev/null >/dev/null 2>&1 & exec "$@"';

const TAIL_BYTES = 8 * 1024;
const LISTEN_TIMEOUT_MS = 30_000;
const CONNECT_TIMEOUT_MS = 30_000;
const COMMAND_TIMEOUT_MS = 30_000;
const CLOSE_TIMEOUT_MS = 5_000;
/** How long a page may take to load, or to show what a test waits for. */
export const PAGE_TIMEOUT_MS = 15_000;
// Below the 60 s per-test timeout, so a helper whose commands stall fails with its own message.
const HELPER_TIMEOUT_MS = 20_000;
const POLL_MS = 100;
// The WebDriver web element identifier, the key of an element reference.
const ELEMENT_KEY = "element-6066-11e4-a52e-4f735466cecf";

// An empty form action origin matches any form on the origin.
const SAVE_LOGIN = `const [origin, username, password] = arguments;
const login = Cc["@mozilla.org/login-manager/loginInfo;1"].createInstance(Ci.nsILoginInfo);
login.init(origin, "", null, username, password, "", "");
return Services.logins.addLoginAsync(login).then(() => null);`;
const REMOVE_LOGINS = "return Services.logins.removeAllUserFacingLoginsAsync().then(() => null);";

/** The extension's internal UUID, pinned in user.js, so its pages have known URLs. */
export const EXTENSION_UUID = "6c1f9a52-3d8e-4b7a-9f20-5e4d1c3b2a10";

export interface FirefoxOutput {
  stdout: string;
  stderr: string;
}

/** A top-level browsing context, that is a tab, and the URL of its document. */
export interface BrowsingContext {
  context: string;
  url: string;
}

export interface Firefox {
  /** Installs the unpacked extension in `path` as a temporary add-on and returns its id. */
  installExtension(path: string): Promise<string>;
  /** The URL of a file in the installed extension, such as its settings page. */
  extensionUrl(path: string): string;
  contexts(): Promise<BrowsingContext[]>;
  /** Opens `url` in a new tab, as a user would, and returns the tab's context once it loaded. */
  openContext(url: string): Promise<string>;
  /** Loads `url` in a tab, as a user would, and returns once it has loaded. */
  navigate(context: string, url: string): Promise<void>;
  /** Evaluates `expression` in the tab's page, awaiting a promise, and returns a primitive. */
  evaluate(context: string, expression: string): Promise<unknown>;
  /** The tab's viewport as Firefox draws it, a base64 PNG, taken without Foxhand. */
  captureViewport(context: string): Promise<string>;
  /** Clicks the first element matching `cssSelector` with real (trusted) input. */
  click(context: string, cssSelector: string): Promise<void>;
  /**
   * Shows and focuses the tab with the Marionette switch that `click` sends before it clicks.
   * BiDi's `browsingContext.activate` refuses extension pages.
   */
  activate(context: string): Promise<void>;
  closeContext(context: string): Promise<void>;
  /** Saves a login for `origin` that Firefox fills into any form on it. */
  saveLogin(origin: string, username: string, password: string): Promise<void>;
  /** Removes every saved login. */
  removeLogins(): Promise<void>;
  /** Resolves with the first tab that matches, polling until `timeoutMs`. */
  waitForContext(
    predicate: (context: BrowsingContext) => boolean,
    timeoutMs: number,
  ): Promise<string>;
  output(): FirefoxOutput;
  close(): Promise<void>;
}

export interface LaunchOptions {
  binary: string;
  profileDir: string;
  env: Record<string, string>;
  /** Where Firefox saves downloads. */
  downloadDir: string;
  lifetimeSeconds?: number;
}

/**
 * Starts Firefox headless in its own process group under a hard lifetime, opens the WebDriver
 * session over Marionette as soon as it listens, so this run holds Firefox's single session from
 * the start, and connects BiDi to that session. BiDi does everything it can; Marionette only
 * clicks and brings a tab to the front, because BiDi has no input in extension pages and does
 * not activate them (ADR 0008). Any failure kills the group before it rejects.
 */
export async function launchFirefox({
  binary,
  profileDir,
  env,
  downloadDir,
  lifetimeSeconds = FIREFOX_LIFETIME_SECONDS,
}: LaunchOptions): Promise<Firefox> {
  writeFileSync(join(profileDir, "user.js"), buildUserJs(downloadDir));
  const child = spawn(
    "sh",
    [
      "-c",
      LIFETIME_WRAPPER,
      "foxhand-e2e",
      String(lifetimeSeconds),
      binary,
      "--headless",
      "--no-remote",
      "--profile",
      profileDir,
      "--remote-debugging-port=0",
      "--marionette",
      // WebDriver may open and script extension pages only with system access.
      "--remote-allow-system-access",
    ],
    {
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
      // No crash reporter: its helper process puts itself in a session and process group of its
      // own, out of reach of the group kill and the watchdog, and a crash would write a minidump
      // outside the throwaway profile and try to upload it.
      env: { ...env, MOZ_CRASHREPORTER_DISABLE: "1" },
    },
  );
  track(child);

  const stdoutTail = tailBuffer();
  const stderrTail = tailBuffer();
  child.stdout?.setEncoding("utf8");
  child.stdout?.on("data", (chunk: string) => stdoutTail.push(chunk));
  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", (chunk: string) => stderrTail.push(chunk));
  const closed = new Promise<void>((resolve) => {
    child.once("close", () => resolve());
  });

  function output(): FirefoxOutput {
    return { stdout: stdoutTail.read(), stderr: stderrTail.read() };
  }

  let marionette: Marionette | undefined;
  let bidi: Bidi | undefined;
  try {
    // Each line can be on either stream; a tail can roll past one line before the other comes.
    const streams = [stdoutTail.read, stderrTail.read];
    const [, port] = await Promise.all([
      waitForLine(child, streams, parseListeningLine, "the BiDi listening line"),
      waitForLine(child, streams, parseMarionettePort, "the Marionette listening line"),
    ]);
    marionette = await connectMarionette(port);
    const created = await marionette.send("WebDriver:NewSession", { webSocketUrl: true });
    bidi = await connectBidi(webSocketUrlOf(created));
  } catch (error: unknown) {
    killGroupSync(child);
    untrack(child);
    bidi?.close();
    marionette?.close();
    throw new Error(`Firefox did not start: ${messageOf(error)}${describeOutput(output())}`, {
      cause: error,
    });
  }
  const session = bidi;
  const input = marionette;

  async function evaluate(context: string, expression: string): Promise<unknown> {
    const result = await session.send("script.evaluate", {
      expression,
      target: { context },
      awaitPromise: true,
      resultOwnership: "none",
    });
    return primitiveOf(result, expression);
  }

  // Never `wait: "complete"`: Firefox sends no navigation events for extension pages. Right after
  // `wait: "none"` the old document can still answer, so the URL must match too.
  async function load(context: string, url: string): Promise<void> {
    await session.send("browsingContext.navigate", { context, url, wait: "none" });
    const expected = `complete ${new URL(url).href}`;
    await pollUntil(
      async () => {
        const state = await evaluate(context, 'document.readyState + " " + location.href');
        if (state === expected) return true;
        throw new Error(`the tab is at ${JSON.stringify(state)}`);
      },
      PAGE_TIMEOUT_MS,
      `${url} to load`,
    );
  }

  async function contexts(): Promise<BrowsingContext[]> {
    const result = await session.send("browsingContext.getTree", { maxDepth: 0 });
    const tree: unknown = isRecord(result) ? result.contexts : undefined;
    if (!Array.isArray(tree)) {
      throw new Error(`browsingContext.getTree returned ${JSON.stringify(result)}`);
    }
    return tree.map((entry: unknown) => {
      if (!isRecord(entry) || typeof entry.context !== "string" || typeof entry.url !== "string") {
        throw new Error(`browsingContext.getTree returned the context ${JSON.stringify(entry)}`);
      }
      return { context: entry.context, url: entry.url };
    });
  }

  async function switchTo(context: string): Promise<void> {
    await input.send("WebDriver:SwitchToWindow", { handle: context });
  }

  // Runs `script` with Firefox's privileges, awaiting a promise it returns. Back to content after,
  // which click's commands need.
  async function chrome(script: string, args: unknown[]): Promise<void> {
    await input.send("Marionette:SetContext", { value: "chrome" });
    try {
      await input.send("WebDriver:ExecuteScript", { script, args });
    } finally {
      await input.send("Marionette:SetContext", { value: "content" });
    }
  }

  let closing: Promise<void> | undefined;
  return {
    async installExtension(path) {
      const result = await session.send("webExtension.install", {
        extensionData: { type: "path", path },
      });
      const extension = isRecord(result) ? result.extension : undefined;
      if (typeof extension !== "string") {
        throw new Error(`webExtension.install returned ${JSON.stringify(result)}`);
      }
      return extension;
    },
    extensionUrl: (path) => `moz-extension://${EXTENSION_UUID}/${path}`,
    contexts,
    openContext(url) {
      return withDeadline(
        (async () => {
          const created = await session.send("browsingContext.create", { type: "tab" });
          const context = isRecord(created) ? created.context : undefined;
          if (typeof context !== "string") {
            throw new Error(`browsingContext.create returned ${JSON.stringify(created)}`);
          }
          try {
            await load(context, url);
          } catch (error: unknown) {
            await session.send("browsingContext.close", { context }).catch(() => {});
            throw error;
          }
          return context;
        })(),
        HELPER_TIMEOUT_MS,
        `openContext ${url}`,
      );
    },
    navigate(context, url) {
      return withDeadline(load(context, url), HELPER_TIMEOUT_MS, `navigate ${context} ${url}`);
    },
    evaluate,
    captureViewport(context) {
      return withDeadline(
        (async () => {
          const result = await session.send("browsingContext.captureScreenshot", { context });
          const data = isRecord(result) ? result.data : undefined;
          if (typeof data !== "string") {
            throw new Error(`browsingContext.captureScreenshot returned ${JSON.stringify(result)}`);
          }
          return data;
        })(),
        HELPER_TIMEOUT_MS,
        `captureViewport ${context}`,
      );
    },
    click(context, cssSelector) {
      return withDeadline(
        (async () => {
          await switchTo(context);
          let found: unknown;
          try {
            found = await input.send("WebDriver:FindElement", {
              using: "css selector",
              value: cssSelector,
            });
          } catch (error: unknown) {
            throw new Error(`cannot find ${cssSelector}: ${messageOf(error)}`, { cause: error });
          }
          const element = isRecord(found) && isRecord(found.value) ? found.value[ELEMENT_KEY] : "";
          if (typeof element !== "string" || element === "") {
            throw new Error(`WebDriver:FindElement returned ${JSON.stringify(found)}`);
          }
          await input.send("WebDriver:ElementClick", { id: element });
        })(),
        HELPER_TIMEOUT_MS,
        `click ${context} ${cssSelector}`,
      );
    },
    activate(context) {
      // The same switch as click's, so a click right after this changes neither focus nor
      // visibility.
      return withDeadline(switchTo(context), HELPER_TIMEOUT_MS, `activate ${context}`);
    },
    async closeContext(context) {
      await session.send("browsingContext.close", { context });
    },
    saveLogin(origin, username, password) {
      return withDeadline(
        chrome(SAVE_LOGIN, [origin, username, password]),
        HELPER_TIMEOUT_MS,
        `saveLogin ${origin}`,
      );
    },
    removeLogins() {
      return withDeadline(chrome(REMOVE_LOGINS, []), HELPER_TIMEOUT_MS, "removeLogins");
    },
    waitForContext(predicate, timeoutMs) {
      return pollUntil(
        async () => {
          const all = await contexts();
          const match = all.find(predicate);
          if (match !== undefined) return match.context;
          throw new Error(`the tabs show ${JSON.stringify(all.map(({ url }) => url))}`);
        },
        timeoutMs,
        "a matching tab",
      );
    },
    output,
    close() {
      closing ??= (async () => {
        killGroupSync(child);
        try {
          await withDeadline(closed, CLOSE_TIMEOUT_MS, "Firefox to exit after the group kill");
        } finally {
          untrack(child);
          session.close();
          input.close();
        }
      })();
      return closing;
    },
  };
}

/** The throwaway profile's user.js. Every pref carries its reason. */
function buildUserJs(downloadDir: string): string {
  const prefs: Array<[string, string | number | boolean, string]> = [
    [
      "browser.startup.page",
      0,
      "Start blank: the default about:home is a privileged page that fetches remote content.",
    ],
    ["browser.startup.homepage", "about:blank", "Same reason."],
    [
      "extensions.webextensions.uuids",
      JSON.stringify({ [EXTENSION_ID]: EXTENSION_UUID }),
      "Pin the extension's internal UUID (Firefox's UUIDMap reads this pref), so its settings page has a known moz-extension: URL.",
    ],
    [
      "marionette.port",
      0,
      "Marionette listens on a free port and prints it, so runs never collide on 2828.",
    ],
    [
      "devtools.console.stdout.content",
      true,
      "Echo console output, the extension's warnings included, to stdout, whose tail a failing test shows.",
    ],
    [
      "browser.download.folderList",
      2,
      "Save downloads in the folder browser.download.dir names, not the default one.",
    ],
    [
      "browser.download.dir",
      downloadDir,
      "Downloads go into the test's temp home, never the developer's folder.",
    ],
    [
      "signon.autofillForms",
      true,
      "Fill saved logins into login forms on load; Firefox's remote agent sets its recommended false unless the profile sets it.",
    ],
    [
      "signon.rememberSignons",
      true,
      "Login autofill does nothing unless saving logins is on; the remote agent's recommended value is false.",
    ],
    [
      "signon.autofillForms.http",
      true,
      "The fixture server is plain http on 127.0.0.1, and Firefox fills saved logins into http pages only with this; its default is false.",
    ],
  ];
  return prefs
    .map(
      ([name, value, reason]) =>
        `// ${reason}\nuser_pref(${JSON.stringify(name)}, ${JSON.stringify(value)});\n`,
    )
    .join("");
}

// Every launched group, killed by the exit and signal handlers below while it is running.
const running = new Set<ChildProcess>();

function track(child: ChildProcess): void {
  running.add(child);
  if (running.size === 1) {
    process.on("exit", killAllSync);
    process.on("SIGINT", onSignal);
    process.on("SIGTERM", onSignal);
  }
}

function untrack(child: ChildProcess): void {
  running.delete(child);
  if (running.size === 0) removeHandlers();
}

function killAllSync(): void {
  for (const child of running) killGroupSync(child);
}

// Ctrl-C would otherwise end node without its exit handlers and leave Firefox to the watchdog.
function onSignal(signal: NodeJS.Signals): void {
  killAllSync();
  running.clear();
  removeHandlers();
  process.kill(process.pid, signal);
}

function removeHandlers(): void {
  process.off("exit", killAllSync);
  process.off("SIGINT", onSignal);
  process.off("SIGTERM", onSignal);
}

/** Kills Firefox's whole process group: Firefox, its content processes and the watchdog. */
export function killGroupSync(child: ChildProcess): void {
  // No pid: the spawn itself failed, so there is no group to kill.
  if (child.pid === undefined) return;
  try {
    process.kill(-child.pid, "SIGKILL");
  } catch (error: unknown) {
    if (!(error instanceof Error && "code" in error && error.code === "ESRCH")) throw error;
  }
}

interface Tail {
  push(chunk: string): void;
  read(): string;
}

function tailBuffer(): Tail {
  let text = "";
  return {
    push(chunk) {
      text = (text + chunk).slice(-TAIL_BYTES);
    },
    read: () => text,
  };
}

/**
 * Resolves with the first match of `parse` in any of the output `streams`, checked whenever
 * Firefox writes to stdout or stderr.
 */
function waitForLine<T>(
  child: ChildProcess,
  streams: Array<() => string>,
  parse: (text: string) => T | null,
  what: string,
): Promise<T> {
  const { promise, resolve, reject } = Promise.withResolvers<T>();
  const timer = setTimeout(() => {
    finish();
    reject(new Error(`timed out after ${LISTEN_TIMEOUT_MS} ms waiting for ${what}`));
  }, LISTEN_TIMEOUT_MS);

  function onData(): void {
    for (const stream of streams) {
      const found = parse(stream());
      if (found === null) continue;
      finish();
      resolve(found);
      return;
    }
  }

  // 'close', not 'exit': 'exit' can arrive before the last of the output is read, and the
  // failure would then quote an empty tail.
  function onClose(code: number | null, signal: NodeJS.Signals | null): void {
    finish();
    reject(new Error(`Firefox exited (code ${code}, signal ${signal}) before ${what}`));
  }

  function onError(error: Error): void {
    finish();
    reject(new Error(`could not start Firefox: ${error.message}`));
  }

  function finish(): void {
    clearTimeout(timer);
    child.stdout?.off("data", onData);
    child.stderr?.off("data", onData);
    child.off("close", onClose);
    child.off("error", onError);
  }

  // Added after launchFirefox's own listeners, so the tails already hold the chunk.
  child.stdout?.on("data", onData);
  child.stderr?.on("data", onData);
  child.once("close", onClose);
  child.once("error", onError);
  return promise;
}

/**
 * The BiDi WebSocket URL from Firefox's stderr, or null. Pass the whole accumulated text: the
 * line can arrive split across chunks, so it counts only once its line end is in (a URL cut
 * inside the port names another port).
 */
export function parseListeningLine(text: string): string | null {
  const match = /WebDriver BiDi listening on (ws:\/\/\S+)\r?\n/.exec(text);
  return match?.[1] ?? null;
}

/** Marionette's port from Firefox's output, or null; like `parseListeningLine`, whole lines only. */
export function parseMarionettePort(text: string): number | null {
  const match = /Marionette\s+INFO\s+Listening on port ([0-9]+)\r?\n/.exec(text);
  return match?.[1] === undefined ? null : Number(match[1]);
}

/** The BiDi WebSocket URL of the session `WebDriver:NewSession` opened. */
function webSocketUrlOf(created: unknown): string {
  const capabilities = isRecord(created) ? created.capabilities : undefined;
  const url = isRecord(capabilities) ? capabilities.webSocketUrl : undefined;
  if (typeof url !== "string" || !url.startsWith("ws://")) {
    throw new Error(`WebDriver:NewSession returned no webSocketUrl: ${JSON.stringify(created)}`);
  }
  return url;
}

interface Bidi {
  send(method: string, params: Record<string, unknown>): Promise<unknown>;
  close(): void;
}

/** A BiDi client over Node's global WebSocket, connected to the session at `url`. */
async function connectBidi(url: string): Promise<Bidi> {
  const socket = new WebSocket(url);
  const pending = pendingCommands("BiDi");

  socket.addEventListener("message", (event) => {
    const data: unknown = event.data;
    if (typeof data !== "string") return;
    let message: unknown;
    try {
      message = JSON.parse(data);
    } catch {
      return;
    }
    // Events carry no id; a reply to a command that already timed out finds no waiter.
    if (!isRecord(message) || typeof message.id !== "number") return;
    const waiter = pending.take(message.id);
    if (waiter === undefined) return;
    if (message.type === "success") {
      waiter.resolve(message.result);
    } else if (message.type === "error") {
      waiter.reject(new Error(`BiDi error ${String(message.error)}: ${String(message.message)}`));
    } else {
      waiter.reject(new Error(`BiDi reply of unknown type ${JSON.stringify(message.type)}`));
    }
  });
  socket.addEventListener("close", () => pending.rejectAll("the BiDi connection closed"));

  const opened = new Promise<void>((resolve, reject) => {
    socket.addEventListener("open", () => resolve());
    socket.addEventListener("error", () => reject(new Error(`could not connect to ${url}`)));
  });
  try {
    await withDeadline(opened, CONNECT_TIMEOUT_MS, `the BiDi connection to ${url}`);
  } catch (error: unknown) {
    socket.close();
    throw error;
  }

  return {
    send(method, params) {
      // A closing or closed WebSocket drops what is sent, and the command would then wait out
      // its whole deadline for a reply that cannot come.
      if (socket.readyState !== WebSocket.OPEN) {
        return Promise.reject(new Error(`the BiDi connection is closed; cannot send ${method}`));
      }
      const { id, promise } = pending.start(method);
      socket.send(JSON.stringify({ id, method, params }));
      return promise;
    },
    close() {
      socket.close();
    },
  };
}

interface Marionette {
  send(name: string, params: Record<string, unknown>): Promise<unknown>;
  close(): void;
}

/**
 * A Marionette client on 127.0.0.1:`port`. Frames are `<byte length>:<JSON>`; the server's first
 * frame is its hello, commands are `[0, id, name, params]` and replies `[1, id, error, result]`.
 */
async function connectMarionette(port: number): Promise<Marionette> {
  const socket = connectTcp({ host: "127.0.0.1", port });
  const pending = pendingCommands("Marionette");
  const hello = Promise.withResolvers<void>();
  let greeted = false;
  let buffered = Buffer.alloc(0);

  socket.on("data", (chunk: Buffer) => {
    buffered = Buffer.concat([buffered, chunk]);
    try {
      for (let frame = nextFrame(); frame !== undefined; frame = nextFrame()) {
        onMessage(frame.message);
      }
    } catch (error: unknown) {
      socket.destroy(error instanceof Error ? error : new Error(String(error)));
    }
  });
  socket.on("error", (error) => hello.reject(new Error(`Marionette: ${error.message}`)));
  socket.on("close", () => {
    hello.reject(new Error("the Marionette connection closed before its hello"));
    pending.rejectAll("the Marionette connection closed");
  });

  /** The next whole frame, removed from the buffer, or undefined until one is complete. */
  function nextFrame(): { message: unknown } | undefined {
    const colon = buffered.indexOf(":");
    if (colon < 0) return undefined;
    const prefix = buffered.subarray(0, colon).toString("latin1");
    if (!/^[0-9]+$/.test(prefix)) throw new Error(`Marionette sent a frame of length ${prefix}`);
    const end = colon + 1 + Number(prefix);
    if (buffered.length < end) return undefined;
    const body = buffered.subarray(colon + 1, end).toString("utf8");
    buffered = buffered.subarray(end);
    return { message: JSON.parse(body) };
  }

  function onMessage(message: unknown): void {
    if (!greeted) {
      greeted = true;
      if (isRecord(message) && message.marionetteProtocol === 3) hello.resolve();
      else hello.reject(new Error(`unexpected Marionette hello ${JSON.stringify(message)}`));
      return;
    }
    if (!Array.isArray(message) || message[0] !== 1 || typeof message[1] !== "number") return;
    const [, id, error, result]: unknown[] = message;
    const waiter = pending.take(Number(id));
    if (waiter === undefined) return;
    if (error === null) {
      waiter.resolve(result);
    } else {
      const { error: code, message: text } = isRecord(error) ? error : { error, message: "" };
      waiter.reject(
        new Error(`Marionette ${waiter.command} error ${String(code)}: ${String(text)}`),
      );
    }
  }

  try {
    await withDeadline(hello.promise, CONNECT_TIMEOUT_MS, `Marionette's hello on port ${port}`);
  } catch (error: unknown) {
    socket.destroy();
    throw error;
  }

  return {
    send(name, params) {
      if (socket.destroyed || !socket.writable) {
        return Promise.reject(
          new Error(`the Marionette connection is closed; cannot send ${name}`),
        );
      }
      const { id, promise } = pending.start(name);
      const json = JSON.stringify([0, id, name, params]);
      socket.write(`${Buffer.byteLength(json)}:${json}`);
      return promise;
    },
    close() {
      socket.destroy();
    },
  };
}

interface Waiter {
  command: string;
  resolve(result: unknown): void;
  reject(error: Error): void;
  timer: NodeJS.Timeout;
}

interface PendingCommands {
  start(command: string): { id: number; promise: Promise<unknown> };
  /** Removes the waiter for a reply, or returns undefined when none waits (it timed out). */
  take(id: number): Waiter | undefined;
  rejectAll(reason: string): void;
}

/** The commands a client sent and still waits on, each failing after COMMAND_TIMEOUT_MS. */
function pendingCommands(protocol: string): PendingCommands {
  const waiters = new Map<number, Waiter>();
  let nextId = 0;
  return {
    start(command) {
      nextId += 1;
      const id = nextId;
      const { promise, resolve, reject } = Promise.withResolvers<unknown>();
      const timer = setTimeout(() => {
        waiters.delete(id);
        reject(new Error(`no answer to ${protocol} ${command} within ${COMMAND_TIMEOUT_MS} ms`));
      }, COMMAND_TIMEOUT_MS);
      waiters.set(id, { command, resolve, reject, timer });
      return { id, promise };
    },
    take(id) {
      const waiter = waiters.get(id);
      if (waiter === undefined) return undefined;
      waiters.delete(id);
      clearTimeout(waiter.timer);
      return waiter;
    },
    rejectAll(reason) {
      for (const waiter of waiters.values()) {
        clearTimeout(waiter.timer);
        waiter.reject(new Error(reason));
      }
      waiters.clear();
    },
  };
}

/** The primitive a `script.evaluate` result holds; throws for an exception or any other value. */
function primitiveOf(result: unknown, expression: string): unknown {
  if (isRecord(result) && result.type === "exception") {
    const details = isRecord(result.exceptionDetails) ? result.exceptionDetails.text : undefined;
    throw new Error(`evaluating ${expression} threw ${String(details)}`);
  }
  const value = isRecord(result) && result.type === "success" ? result.result : undefined;
  if (!isRecord(value)) throw new Error(`script.evaluate returned ${JSON.stringify(result)}`);
  switch (value.type) {
    case "undefined":
      return undefined;
    case "null":
      return null;
    case "string":
    case "boolean":
      return value.value;
    case "number":
      // NaN, -0, Infinity and -Infinity come as strings.
      return typeof value.value === "number" ? value.value : Number(value.value);
    default:
      throw new Error(`evaluating ${expression} returned a ${String(value.type)}, not a primitive`);
  }
}

/**
 * Calls `probe` every POLL_MS until it returns a value other than undefined, within `ms` in all.
 * A probe that throws counts as not yet; the timeout quotes the last error.
 */
export async function pollUntil<T>(
  probe: () => Promise<T | undefined>,
  ms: number,
  what: string,
): Promise<T> {
  const deadline = Date.now() + ms;
  let last = "no answer yet";
  for (;;) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error(`timed out after ${ms} ms waiting for ${what}: ${last}`);
    try {
      const value = await withDeadline(probe(), remaining, what);
      if (value !== undefined) return value;
      last = "the probe returned nothing";
    } catch (error: unknown) {
      last = messageOf(error);
    }
    await sleep(Math.min(POLL_MS, Math.max(deadline - Date.now(), 0)));
  }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function withDeadline<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out after ${ms} ms waiting for ${what}`)), ms);
  });
  try {
    return await Promise.race([promise, deadline]);
  } finally {
    clearTimeout(timer);
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The output tails, for a failure message. */
export function describeOutput({ stdout, stderr }: FirefoxOutput): string {
  return (
    `\n--- Firefox stderr (last ${TAIL_BYTES} bytes) ---\n${stderr || "(empty)"}` +
    `\n--- Firefox stdout (last ${TAIL_BYTES} bytes) ---\n${stdout || "(empty)"}`
  );
}

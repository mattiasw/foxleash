import type {
  BrowserApi,
  BrowserEvent,
  BrowserWindow,
  CaptureOptions,
  CssInjection,
  DocumentDetails,
  DownloadDelta,
  DownloadItem,
  FrameDetails,
  InjectionResult,
  MessageSender,
  NavigationDetails,
  Permissions,
  Port,
  RuntimePort,
  StorageChange,
  Tab,
  TabChangeInfo,
  TabGroup,
  TabUpdatedFilter,
  TabUpdatedListener,
  Timers,
  WebRequestEvent,
} from "./browser-api.ts";

/** An in-memory stand-in for Firefox's `browser.*`, for unit tests. */
export interface FakeBrowser {
  browser: BrowserApi;
  tabs: Map<number, FakeTab>;
  groups: Map<number, TabGroup>;
  ports: FakePort[];
  /** The window Firefox puts new tabs and groups in when no window is given. */
  currentWindowId: number;
  /** What `permissions.contains({ origins: ["<all_urls>"] })` answers. */
  allUrls: boolean;
  version: string;
  /** How many times `runtime.openOptionsPage` ran. */
  optionsPageOpened: number;
  /** The per-tab badge text `action.setBadgeText` set; a load clears the tab's entry. */
  badgeText: Map<number, string>;
  /** The per-tab title `action.setTitle` set; a load clears the tab's entry. */
  badgeTitle: Map<number, string>;
  /** Every `tabs.update` call, in order. */
  tabUpdates: TabUpdate[];
  /** Every `windows.update` call, in order. */
  windowUpdates: WindowUpdate[];
  /** Each window's size, as `windows.update` set it; a window without an entry is 1280x800. */
  windowSizes: Map<number, { width: number; height: number }>;
  /** Makes the next `storage.local.set` reject, once. */
  failNextSet(): void;
  /** Every `scripting.executeScript` call, in order, with only the keys it was given. */
  injections: Injection[];
  /** What each `scripting.executeScript` call resolves to, once `nextInjectionResults` is empty. */
  injectionResults: InjectionResult<unknown>[];
  /** What the next `scripting.executeScript` calls resolve to, one entry each, first to last. */
  nextInjectionResults: InjectionResult<unknown>[][];
  /** Makes the next `scripting.executeScript` reject with `error`, once. */
  failNextInjection(error: unknown): void;
  /** Every `tabs.captureTab` call, in order, with only the option keys it was given. */
  captures: Capture[];
  /** What each `tabs.captureTab` call resolves to; a one-pixel PNG data URL by default. */
  captureResult: string;
  /** Makes the next `tabs.captureTab` reject with `error`, once. */
  failNextCapture(error: unknown): void;
  /** Leaves the next `tabs.captureTab` pending until `release` runs; it then resolves with `captureResult`. */
  holdNextCapture(): () => void;
  /** Every `scripting.insertCSS` and `removeCSS` call, in order. */
  cssCalls: CssCall[];
  /**
   * What `webNavigation.getAllFrames` answers for the tab, or null when discarded. A frame id `n`
   * lists `{ frameId: n, documentId: "document-<tabId>-<n>", parentFrameId }`, the parent -1 for
   * frame 0 and 0 for any other; an object is listed as given. Without it, the tab lists its top
   * frame only.
   */
  setFrames(tabId: number, frames: readonly (number | FrameDetails)[] | null): void;
  /**
   * Makes the next `scripting.insertCSS` into that frame reject with `error`, once; with `css`,
   * the next one into that frame whose css starts with it.
   */
  failInsertCSS(frameId: number, error: unknown, css?: string): void;
  /**
   * Leaves the next `scripting.insertCSS` pending until `release` runs; with `css`, the next one
   * whose css starts with it.
   */
  holdNextInsertCSS(css?: string): () => void;
  /** Leaves the next `scripting.removeCSS` pending until `release` runs. */
  holdNextRemoveCSS(): () => void;
  /** Makes the next `scripting.removeCSS` reject with `error`, once. */
  failNextRemoveCSS(error: unknown): void;
  /**
   * Fires `webNavigation.onBeforeNavigate`. A load in a tab fires it for its top frame before its
   * loading, at the latest `timeStamp` so far. Without a `timeStamp`, it gets one later than every
   * `timeStamp` fired so far.
   */
  emitBeforeNavigate(details: Omit<NavigationDetails, "timeStamp"> & { timeStamp?: number }): void;
  beforeNavigateListenerCount(): number;
  /**
   * Fires `webNavigation.onCommitted`. A load in a tab fires it for its top frame too. Without a
   * `timeStamp`, the commit gets one later than every `timeStamp` fired so far, as a commit comes
   * after the requests that led to it.
   */
  emitCommitted(details: Omit<NavigationDetails, "timeStamp"> & { timeStamp?: number }): void;
  committedListenerCount(): number;
  /**
   * Whether `tabs.create` fires `webNavigation.onCommitted` for the created tab's top frame and
   * URL, as Firefox's own load of it does; true by default. `openTab` and a `discarded` create,
   * which loads nothing until `tabs.update` loads a URL into the tab or selects it, never fire it.
   */
  commitOnCreate: boolean;
  /** Fires `webNavigation.onCompleted`. A load in a tab fires it for its top frame too. */
  emitCompleted(details: Omit<NavigationDetails, "timeStamp"> & { timeStamp?: number }): void;
  /** Fires `webNavigation.onHistoryStateUpdated`; `pushState` fires it for the top frame too. */
  emitHistoryStateUpdated(
    details: Omit<NavigationDetails, "timeStamp"> & { timeStamp?: number },
  ): void;
  /** Listeners on `webNavigation.onCompleted` and `onHistoryStateUpdated` together. */
  navigationListenerCount(): number;
  /** Fires `webNavigation.onDOMContentLoaded`. */
  emitDOMContentLoaded(details: DocumentDetails): void;
  /** Listeners on `tabs.onRemoved`. */
  removedListenerCount(): number;
  /** Every `tabs.sendMessage` call, in order, with only the keys it was given. */
  tabMessages: TabMessage[];
  /**
   * Installs the content script that answers `tabs.sendMessage` in the tab's top frame, or
   * removes it. The fake runs no page, so an injection installs nothing. A load in the tab, and
   * closing it, removes it, rejecting every reply still pending from it.
   */
  setContentScript(tabId: number, handler: ContentScript | undefined): void;
  /** The user granting or revoking access to all websites in about:addons. */
  setAllUrls(granted: boolean): void;
  openTab(properties?: Partial<Omit<FakeTab, "id" | "history" | "index">>): FakeTab;
  /** The user closing a group: the group and its tabs go away. */
  closeGroup(groupId: number): void;
  /** The user closing a tab; an emptied group goes away. */
  removeTab(tabId: number): void;
  /** The user loading a URL in the tab, as by typing it in the address bar. */
  navigateByUser(tabId: number, url: string): void;
  /** The page changing its URL with `history.pushState`: no load, so no commit. */
  pushState(tabId: number, url: string): void;
  /**
   * An extension page in a tab opening `runtime.connect({ name })`. Returns the page's end:
   * `posted` holds what the background posted, `deliver` sends a message as the page, `drop`
   * closes the page, and `disconnected` is set when the background disconnects.
   */
  connectPage(name: string, sender: MessageSender): FakePort;
  /**
   * A `runtime.sendMessage` from an extension page or content script with that sender. Returns
   * the first listener's reply, or undefined when no listener replied.
   */
  sendMessage(message: unknown, sender: MessageSender): Promise<unknown> | undefined;
  /** The user dragging a tab out of its group; an emptied group goes away. */
  ungroup(tabId: number): void;
  /** The user clicking the toolbar button while the tab is shown. */
  clickAction(tabId: number): void;
  emitStatus(tabId: number, status: string): void;
  /** Fires `tabs.onDetached` alone, as when the user starts dragging the tab to another window. */
  emitDetached(tabId: number): void;
  /** Fires `storage.onChanged` with no changes, as for a storage area the fake does not keep. */
  emitStorageChanged(areaName: string): void;
  listenerCount(): number;
  /** Every `webRequest` listener added, in order, with the filter and extra info it was given. */
  webRequestRegistrations: WebRequestRegistration[];
  /** Fires a `webRequest` event; returns what each listener returned, in order. */
  emitWebRequest<E extends WebRequestEventName>(
    event: E,
    details: WebRequestDetailsOf<E>,
  ): unknown[];
  /** Every `downloads.download` call, in order. */
  downloadCalls: DownloadCall[];
  /** The downloads Firefox knows, by id, as `downloads.search` answers for them. */
  downloads: Map<number, DownloadItem>;
  /** The state the next downloads end in. */
  downloadState: "complete" | "interrupted";
  /**
   * When the next downloads end. "immediate": already ended when `download()` resolves, with no
   * `onChanged` event. "event_before_id": `onChanged` fires before `download()` resolves, while
   * `search` still shows the download in progress. "held": in progress until `finishDownload`.
   */
  downloadTiming: "immediate" | "event_before_id" | "held";
  /** Makes the next `downloads.download` reject with `error`, once. */
  failNextDownload(error: unknown): void;
  /** Ends the download in `state` and fires `downloads.onChanged`, even when it is not listed. */
  finishDownload(id: number, state: "complete" | "interrupted"): void;
  /** Fires `downloads.onChanged` alone. */
  emitDownloadChanged(delta: DownloadDelta): void;
  /** Every `downloads.cancel` call's id, in order. */
  cancelledDownloads: number[];
  /** Makes every later `downloads.cancel` reject with `error`. */
  failCancel(error: unknown): void;
  /** Listeners on `downloads.onChanged`. */
  downloadListenerCount(): number;
}

export interface DownloadCall {
  url: string;
  filename: string;
  saveAs: boolean;
  conflictAction: string;
}

/** The folder the fake saves downloads in. */
export const FAKE_DOWNLOAD_FOLDER = "/home/user/Downloads";

type WebRequestEvents = BrowserApi["webRequest"];
export type WebRequestEventName = keyof WebRequestEvents;
type WebRequestListenerOf<E extends WebRequestEventName> = Parameters<
  WebRequestEvents[E]["addListener"]
>[0];
export type WebRequestDetailsOf<E extends WebRequestEventName> = Parameters<
  WebRequestListenerOf<E>
>[0];

export interface WebRequestRegistration {
  event: WebRequestEventName;
  filter: { urls: string[] };
  extraInfoSpec?: string[];
}

export interface FakeTab {
  id: number;
  windowId: number;
  active: boolean;
  url: string;
  title: string;
  status: string;
  discarded?: boolean;
  groupId: number;
  history: string[];
  index: number;
}

export interface Injection {
  tabId: number;
  func?: unknown;
  args?: unknown[];
  world?: string;
  frameIds?: number[];
  files?: string[];
  injectImmediately?: boolean;
}

export interface Capture extends CaptureOptions {
  tabId: number;
}

export interface CssCall {
  method: "insertCSS" | "removeCSS";
  tabId: number;
  frameIds: number[];
  css: string;
  origin: string;
}

export interface TabMessage {
  tabId: number;
  message: unknown;
  frameId?: number;
}

/** A content script's `runtime.onMessage` listener: a promise to reply, undefined not to. */
export type ContentScript = (message: unknown) => Promise<unknown> | undefined;

export interface WindowUpdate {
  windowId: number;
  drawAttention?: boolean;
  state?: "normal";
  width?: number;
  height?: number;
}

export interface TabUpdate {
  tabId: number;
  url?: string;
  active?: boolean;
  loadReplace?: boolean;
}

/** A real 1x1 PNG, as `tabs.captureTab` returns it. */
export const ONE_PIXEL_PNG =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

/** The extension's id in the fake, and the host of its `getURL` URLs. */
export const FAKE_EXTENSION_ID = "foxleash@example.org";
const FAKE_EXTENSION_ORIGIN = "moz-extension://8a7f9c1e-2b3d-4e5f-a6b7-c8d9e0f1a2b3";

export interface FakePort extends Port {
  posted: unknown[];
  /** Set by `disconnect()`; posting then throws, as in Firefox. */
  disconnected: boolean;
  deliver(message: unknown): void;
  /** The other side closing the port, optionally with an error. */
  drop(error?: string): void;
}

export function createFakeBrowser(): FakeBrowser {
  const updatedListeners: { listener: TabUpdatedListener; filter: TabUpdatedFilter | undefined }[] =
    [];
  let nextTabId = 1;
  let nextGroupId = 1;
  const onAdded = createEvent<(permissions: Permissions) => void>();
  const onRemoved = createEvent<(permissions: Permissions) => void>();
  const stored = new Map<string, unknown>();
  const onStorageChanged =
    createEvent<(changes: Record<string, StorageChange>, areaName: string) => void>();
  const onCreated = createEvent<(tab: Tab) => void>();
  const onClicked = createEvent<(tab: Tab) => void>();
  const onConnect = createEvent<(port: RuntimePort) => void>();
  const onMessage =
    createEvent<(message: unknown, sender: MessageSender) => Promise<unknown> | undefined>();
  const onTabRemoved = createEvent<(tabId: number) => void>();
  const onTabDetached = createEvent<(tabId: number) => void>();
  let failSet = false;
  let injectionFailure: { error: unknown } | undefined;
  let captureFailure: { error: unknown } | undefined;
  let captureHold: Promise<void> | undefined;
  const frames = new Map<number, FrameDetails[] | null>();
  const insertFailures = new Map<number, { error: unknown; css: string }>();
  let insertHold: { promise: Promise<void>; css: string } | undefined;
  let removeHold: Promise<void> | undefined;
  let removeFailure: { error: unknown } | undefined;
  const onBeforeNavigate = createEvent<(details: NavigationDetails) => void>();
  const onCommitted = createEvent<(details: NavigationDetails) => void>();
  // Not `onCompleted`: in this file that name is webRequest's.
  const onNavigationCompleted = createEvent<(details: NavigationDetails) => void>();
  const onHistoryStateUpdated = createEvent<(details: NavigationDetails) => void>();
  const onDOMContentLoaded = createEvent<(details: DocumentDetails) => void>();
  // The latest timeStamp a commit or a webRequest event carried.
  let latestTimeStamp = 0;
  const contentScripts = new Map<
    number,
    { handler: ContentScript; pending: Set<(error: Error) => void> }
  >();
  const webRequestListeners = new Map<WebRequestEventName, Set<(details: never) => void>>();
  const onDownloadChanged = createEvent<(delta: DownloadDelta) => void>();
  let downloadFailure: { error: unknown } | undefined;
  let cancelFailure: { error: unknown } | undefined;
  let nextDownloadId = 1;

  const browser: BrowserApi = {
    runtime: {
      connectNative,
      onStartup: createEvent(),
      onInstalled: createEvent(),
      getManifest: () => ({ version: fake.version }),
      openOptionsPage: async () => {
        fake.optionsPageOpened += 1;
      },
      id: FAKE_EXTENSION_ID,
      getURL: (path) => `${FAKE_EXTENSION_ORIGIN}/${path}`,
      onConnect,
      onMessage,
      // As the settings page. Firefox resolves with undefined when no listener replies.
      sendMessage: (message) =>
        fake.sendMessage(message, {
          id: FAKE_EXTENSION_ID,
          url: browser.runtime.getURL("options.html"),
        }) ?? Promise.resolve(undefined),
    },
    action: {
      setBadgeText: async ({ tabId, text }) => {
        fake.badgeText.set(tabOf(tabId).id, text);
      },
      setTitle: async ({ tabId, title }) => {
        fake.badgeTitle.set(tabOf(tabId).id, title);
      },
      onClicked,
    },
    permissions: {
      contains: async () => fake.allUrls,
      onAdded,
      onRemoved,
    },
    tabs: {
      query: async ({ groupId, windowId }) =>
        [...fake.tabs.values()]
          .filter((tab) => groupId === undefined || tab.groupId === groupId)
          .filter((tab) => windowId === undefined || tab.windowId === windowId)
          .map(snapshot),
      get: async (tabId) => snapshot(tabOf(tabId)),
      create: async ({ url, active, windowId, discarded }) => {
        if (discarded === true) {
          if (active) throw new Error("Active tabs cannot be created and discarded.");
          if (url.startsWith("about:")) {
            throw new Error('Cannot create a discarded new tab or "about" urls.');
          }
          // Firefox labels a tab it has not loaded with its URL, and loads it once selected.
          const tab = fake.openTab({
            url,
            active: false,
            discarded: true,
            title: url,
            windowId: windowId ?? fake.currentWindowId,
          });
          return snapshot(tab);
        }
        const tab = fake.openTab({ url, active, windowId: windowId ?? fake.currentWindowId });
        // Firefox loads the URL a tab is created on and reports that commit. Here it reaches
        // listeners before the caller's await of create resumes: a listener added after misses it.
        if (fake.commitOnCreate) {
          queueMicrotask(() => {
            if (fake.tabs.has(tab.id))
              fake.emitCommitted({ tabId: tab.id, frameId: 0, url: tab.url });
          });
        }
        return snapshot(tab);
      },
      update: async (tabId, properties) => {
        const tab = tabOf(tabId);
        fake.tabUpdates.push({ tabId, ...properties });
        if (properties.active === true) activate(tab);
        const { url } = properties;
        if (url === undefined) {
          // Firefox loads a tab it has not loaded yet once it is selected, without a new entry.
          if (properties.active === true && tab.discarded === true) {
            load(tab, tab.history[tab.index] ?? tab.url);
          }
          return snapshot(tab);
        }
        if (properties.loadReplace === true) {
          tab.history = [...tab.history.slice(0, tab.index), url];
        } else {
          tab.history = [...tab.history.slice(0, tab.index + 1), url];
          tab.index += 1;
        }
        load(tab, url);
        return snapshot(tab);
      },
      goBack: async (tabId) => go(tabOf(tabId), -1),
      goForward: async (tabId) => go(tabOf(tabId), 1),
      reload: async (tabId) => {
        const tab = tabOf(tabId);
        load(tab, tab.url);
      },
      remove: async (tabIds) => removeTabs(tabIds.map(tabOf)),
      sendMessage: (tabId, message, options) => {
        const call: TabMessage = { tabId, message };
        if (options?.frameId !== undefined) call.frameId = options.frameId;
        fake.tabMessages.push(call);
        const script = contentScripts.get(tabId);
        if (script === undefined || (options?.frameId ?? 0) !== 0) {
          return Promise.reject(
            new Error("Could not establish connection. Receiving end does not exist."),
          );
        }
        const { promise, resolve, reject } = Promise.withResolvers<unknown>();
        script.pending.add(reject);
        // Both directions are structured clones in Firefox; a value that cannot be cloned rejects.
        const reply = (async () =>
          structuredClone(await script.handler(structuredClone(message))))();
        reply.then(resolve, reject).finally(() => script.pending.delete(reject));
        return promise;
      },
      captureTab,
      group: async ({ tabIds, groupId, createProperties }) => {
        const group =
          groupId === undefined ? createGroup(createProperties?.windowId) : groupOf(groupId);
        for (const tab of tabIds.map(tabOf)) {
          tab.groupId = group.id;
          tab.windowId = group.windowId;
          emit(tab, { groupId: group.id });
        }
        return group.id;
      },
      onUpdated: {
        addListener: (listener, filter) => updatedListeners.push({ listener, filter }),
        removeListener: (listener) => {
          const index = updatedListeners.findIndex((entry) => entry.listener === listener);
          if (index >= 0) updatedListeners.splice(index, 1);
        },
      },
      onCreated,
      onRemoved: onTabRemoved,
      onDetached: onTabDetached,
    },
    windows: {
      update: async (windowId, updateInfo) => {
        fake.windowUpdates.push({ windowId, ...updateInfo });
        const size = sizeOf(windowId);
        fake.windowSizes.set(windowId, {
          width: updateInfo.width ?? size.width,
          height: updateInfo.height ?? size.height,
        });
      },
      get: async (windowId): Promise<BrowserWindow> => ({
        id: windowId,
        state: "normal",
        ...sizeOf(windowId),
      }),
    },
    tabGroups: {
      get: async (groupId) => ({ ...groupOf(groupId) }),
      update: async (groupId, properties) => ({ ...Object.assign(groupOf(groupId), properties) }),
    },
    storage: {
      local: {
        get: async () =>
          Object.fromEntries([...stored].map(([key, value]) => [key, structuredClone(value)])),
        set: async (items) => {
          if (failSet) {
            failSet = false;
            throw new Error("Storage is full");
          }
          const changes = new Map<string, StorageChange>();
          for (const [key, value] of Object.entries(items)) {
            const change: StorageChange = { newValue: structuredClone(value) };
            if (stored.has(key)) change.oldValue = stored.get(key);
            stored.set(key, change.newValue);
            changes.set(key, change);
          }
          emitStorage(Object.fromEntries(changes), "local");
        },
        remove: async (key) => {
          if (!stored.has(key)) return;
          const oldValue = stored.get(key);
          stored.delete(key);
          emitStorage(Object.fromEntries([[key, { oldValue }]]), "local");
        },
      },
      onChanged: onStorageChanged,
    },
    scripting: {
      executeScript,
      insertCSS,
      removeCSS,
    },
    webNavigation: {
      getAllFrames: async ({ tabId }) => {
        tabOf(tabId);
        const listed = frames.get(tabId);
        if (listed === null) return null;
        return (listed ?? [frameOf(tabId, 0)]).map((frame) => ({ ...frame }));
      },
      onBeforeNavigate,
      onCommitted,
      onCompleted: onNavigationCompleted,
      onHistoryStateUpdated,
      onDOMContentLoaded,
    },
    webRequest: {
      onBeforeRequest: createWebRequestEvent("onBeforeRequest"),
      onSendHeaders: createWebRequestEvent("onSendHeaders"),
      onHeadersReceived: createWebRequestEvent("onHeadersReceived"),
      onBeforeRedirect: createWebRequestEvent("onBeforeRedirect"),
      onCompleted: createWebRequestEvent("onCompleted"),
      onErrorOccurred: createWebRequestEvent("onErrorOccurred"),
    },
    downloads: {
      download: async (options) => {
        fake.downloadCalls.push(structuredClone(options));
        const failure = downloadFailure;
        downloadFailure = undefined;
        if (failure !== undefined) throw failure.error;
        const id = nextDownloadId++;
        const item: DownloadItem = {
          id,
          filename: `${FAKE_DOWNLOAD_FOLDER}/${options.filename}`,
          state: "in_progress",
        };
        fake.downloads.set(id, item);
        if (fake.downloadTiming === "immediate") item.state = fake.downloadState;
        if (fake.downloadTiming === "event_before_id") {
          emitDownloadChanged({ id, state: { current: fake.downloadState } });
        }
        return id;
      },
      search: async ({ id }) => {
        const item = fake.downloads.get(id);
        return item === undefined ? [] : [{ ...item }];
      },
      cancel: async (id) => {
        fake.cancelledDownloads.push(id);
        if (cancelFailure !== undefined) throw cancelFailure.error;
      },
      onChanged: onDownloadChanged,
    },
  };

  const fake: FakeBrowser = {
    browser,
    tabs: new Map(),
    groups: new Map(),
    ports: [],
    currentWindowId: 1,
    allUrls: true,
    version: "0.1.0",
    optionsPageOpened: 0,
    badgeText: new Map(),
    badgeTitle: new Map(),
    tabUpdates: [],
    windowUpdates: [],
    windowSizes: new Map(),
    failNextSet: () => {
      failSet = true;
    },
    injections: [],
    injectionResults: [{ frameId: 0, result: null }],
    nextInjectionResults: [],
    failNextInjection: (error) => {
      injectionFailure = { error };
    },
    captures: [],
    captureResult: ONE_PIXEL_PNG,
    failNextCapture: (error) => {
      captureFailure = { error };
    },
    holdNextCapture: () => {
      const { promise, resolve } = Promise.withResolvers<void>();
      captureHold = promise;
      return () => resolve();
    },
    cssCalls: [],
    setFrames: (tabId, listed) => {
      frames.set(
        tabId,
        listed === null
          ? null
          : listed.map((frame) =>
              typeof frame === "number" ? frameOf(tabId, frame) : { ...frame },
            ),
      );
    },
    failInsertCSS: (frameId, error, css = "") => {
      insertFailures.set(frameId, { error, css });
    },
    holdNextInsertCSS: (css = "") => {
      const { promise, resolve } = Promise.withResolvers<void>();
      insertHold = { promise, css };
      return () => resolve();
    },
    holdNextRemoveCSS: () => {
      const { promise, resolve } = Promise.withResolvers<void>();
      removeHold = promise;
      return () => resolve();
    },
    failNextRemoveCSS: (error) => {
      removeFailure = { error };
    },
    emitBeforeNavigate: (details) => emitNavigation(onBeforeNavigate, details),
    beforeNavigateListenerCount: () => onBeforeNavigate.listeners.size,
    emitCommitted: (details) => emitNavigation(onCommitted, details),
    committedListenerCount: () => onCommitted.listeners.size,
    commitOnCreate: true,
    emitCompleted: (details) => emitNavigation(onNavigationCompleted, details),
    emitHistoryStateUpdated: (details) => emitNavigation(onHistoryStateUpdated, details),
    navigationListenerCount: () =>
      onNavigationCompleted.listeners.size + onHistoryStateUpdated.listeners.size,
    emitDOMContentLoaded: (details) => {
      for (const listener of [...onDOMContentLoaded.listeners]) listener({ ...details });
    },
    removedListenerCount: () => onTabRemoved.listeners.size,
    tabMessages: [],
    setContentScript: (tabId, handler) => {
      dropContentScript(tabId);
      if (handler !== undefined) contentScripts.set(tabId, { handler, pending: new Set() });
    },
    setAllUrls: (granted) => {
      fake.allUrls = granted;
      const changed = granted ? onAdded : onRemoved;
      for (const listener of [...changed.listeners]) {
        listener({ permissions: [], origins: ["<all_urls>"] });
      }
    },
    openTab: (properties = {}) => {
      const url = properties.url ?? "about:blank";
      const tab: FakeTab = {
        id: nextTabId++,
        windowId: fake.currentWindowId,
        active: false,
        url,
        title: titleOf(url),
        status: "complete",
        groupId: -1,
        ...properties,
        history: [url],
        index: 0,
      };
      if (tab.active) activate(tab);
      fake.tabs.set(tab.id, tab);
      for (const listener of [...onCreated.listeners]) listener(snapshot(tab));
      return tab;
    },
    closeGroup: (groupId) => {
      fake.groups.delete(groupId);
      for (const tab of fake.tabs.values()) {
        if (tab.groupId !== groupId) continue;
        fake.tabs.delete(tab.id);
        dropContentScript(tab.id);
        for (const listener of [...onTabRemoved.listeners]) listener(tab.id);
      }
    },
    removeTab: (tabId) => removeTabs([tabOf(tabId)]),
    navigateByUser: (tabId, url) => {
      const tab = tabOf(tabId);
      tab.history = [...tab.history.slice(0, tab.index + 1), url];
      tab.index += 1;
      load(tab, url);
    },
    pushState: (tabId, url) => {
      const tab = tabOf(tabId);
      tab.history = [...tab.history.slice(0, tab.index + 1), url];
      tab.index += 1;
      tab.url = url;
      emit(tab, { url });
      fake.emitHistoryStateUpdated({ tabId, frameId: 0, url });
    },
    connectPage: (name, sender) => {
      const port = createPort();
      const runtimePort: RuntimePort = Object.assign(port, { name, sender });
      for (const listener of [...onConnect.listeners]) listener(runtimePort);
      return port;
    },
    sendMessage: (message, sender) => {
      for (const listener of [...onMessage.listeners]) {
        const reply = listener(message, sender);
        if (reply !== undefined) return reply;
      }
      return undefined;
    },
    ungroup: (tabId) => {
      const tab = tabOf(tabId);
      const { groupId } = tab;
      tab.groupId = -1;
      const empty = ![...fake.tabs.values()].some((other) => other.groupId === groupId);
      if (empty) fake.groups.delete(groupId);
      emit(tab, { groupId: -1 });
    },
    clickAction: (tabId) => {
      const tab = snapshot(tabOf(tabId));
      for (const listener of [...onClicked.listeners]) listener(tab);
    },
    emitStatus: (tabId, status) => {
      const tab = tabOf(tabId);
      tab.status = status;
      emit(tab, { status });
    },
    emitStorageChanged: (areaName) => emitStorage({}, areaName),
    emitDetached: (tabId) => {
      for (const listener of [...onTabDetached.listeners]) listener(tabId);
    },
    listenerCount: () => updatedListeners.length,
    webRequestRegistrations: [],
    emitWebRequest: (event, details) => {
      latestTimeStamp = Math.max(latestTimeStamp, details.timeStamp);
      return [...(webRequestListeners.get(event) ?? [])].map(
        (listener: (details: never) => unknown) => listener(details as never),
      );
    },
    downloadCalls: [],
    downloads: new Map(),
    downloadState: "complete",
    downloadTiming: "immediate",
    failNextDownload: (error) => {
      downloadFailure = { error };
    },
    finishDownload: (id, state) => {
      const item = fake.downloads.get(id);
      if (item !== undefined) item.state = state;
      emitDownloadChanged({ id, state: { current: state } });
    },
    emitDownloadChanged: (delta) => emitDownloadChanged(delta),
    cancelledDownloads: [],
    failCancel: (error) => {
      cancelFailure = { error };
    },
    downloadListenerCount: () => onDownloadChanged.listeners.size,
  };
  return fake;

  function emitDownloadChanged(delta: DownloadDelta): void {
    for (const listener of [...onDownloadChanged.listeners]) listener(delta);
  }

  function emitNavigation(
    event: { listeners: Set<(details: NavigationDetails) => void> },
    {
      timeStamp = latestTimeStamp + 1,
      ...details
    }: Omit<NavigationDetails, "timeStamp"> & { timeStamp?: number },
  ): void {
    latestTimeStamp = Math.max(latestTimeStamp, timeStamp);
    for (const listener of [...event.listeners]) listener({ ...details, timeStamp });
  }

  function createWebRequestEvent<E extends WebRequestEventName>(
    event: E,
  ): WebRequestEvent<WebRequestListenerOf<E>> {
    const listeners = new Set<(details: never) => void>();
    webRequestListeners.set(event, listeners);
    return {
      addListener: (listener, filter, extraInfoSpec) => {
        const registration: WebRequestRegistration = { event, filter: structuredClone(filter) };
        if (extraInfoSpec !== undefined) registration.extraInfoSpec = [...extraInfoSpec];
        fake.webRequestRegistrations.push(registration);
        listeners.add(listener);
      },
      removeListener: (listener) => listeners.delete(listener),
    };
  }

  function executeScript<Args extends unknown[], Result>(injection: {
    target: { tabId: number; frameIds?: number[] };
    func: (...args: Args) => Result;
    args: Args;
    world: "ISOLATED" | "MAIN";
    injectImmediately?: boolean;
  }): Promise<InjectionResult<Awaited<Result>>[]>;
  function executeScript(injection: {
    target: { tabId: number; frameIds?: number[] };
    files: string[];
    injectImmediately?: boolean;
  }): Promise<InjectionResult<unknown>[]>;
  async function executeScript(injection: {
    target: { tabId: number; frameIds?: number[] };
    func?: unknown;
    args?: unknown[];
    world?: string;
    files?: string[];
    injectImmediately?: boolean;
  }): Promise<InjectionResult<unknown>[]> {
    const { target, ...given } = injection;
    const call: Injection = { tabId: target.tabId, ...given };
    if (target.frameIds !== undefined) call.frameIds = target.frameIds;
    fake.injections.push(call);
    const failure = injectionFailure;
    injectionFailure = undefined;
    if (failure !== undefined) throw failure.error;
    // The fake runs no page, so what each frame returned is the test's to say.
    return structuredClone(fake.nextInjectionResults.shift() ?? fake.injectionResults);
  }

  async function captureTab(tabId: number, options: CaptureOptions): Promise<string> {
    fake.captures.push({ tabId, ...structuredClone(options) });
    const failure = captureFailure;
    captureFailure = undefined;
    const hold = captureHold;
    captureHold = undefined;
    if (failure !== undefined) throw failure.error;
    tabOf(tabId);
    await hold;
    return fake.captureResult;
  }

  async function insertCSS(injection: CssInjection): Promise<void> {
    fake.cssCalls.push(cssCall("insertCSS", injection));
    const held = insertHold !== undefined && injection.css.startsWith(insertHold.css);
    const hold = held ? insertHold?.promise : undefined;
    if (held) insertHold = undefined;
    for (const frameId of injection.target.frameIds) {
      const failure = insertFailures.get(frameId);
      if (failure === undefined || !injection.css.startsWith(failure.css)) continue;
      insertFailures.delete(frameId);
      throw failure.error;
    }
    await hold;
  }

  async function removeCSS(injection: CssInjection): Promise<void> {
    fake.cssCalls.push(cssCall("removeCSS", injection));
    const failure = removeFailure;
    removeFailure = undefined;
    const hold = removeHold;
    removeHold = undefined;
    if (failure !== undefined) throw failure.error;
    await hold;
  }

  /** The document went away: its content script with it, and the replies it still owed. */
  function dropContentScript(tabId: number): void {
    const script = contentScripts.get(tabId);
    if (script === undefined) return;
    contentScripts.delete(tabId);
    for (const reject of script.pending) reject(new Error("Message manager disconnected"));
  }

  function emitStorage(changes: Record<string, StorageChange>, areaName: string): void {
    for (const listener of [...onStorageChanged.listeners]) listener(changes, areaName);
  }

  function connectNative(): Port {
    const port = createPort();
    fake.ports.push(port);
    return port;
  }

  function createPort(): FakePort {
    const onMessage = createEvent<(message: unknown) => void>();
    const onDisconnect = createEvent<(port: Port) => void>();
    const port: FakePort = {
      posted: [],
      disconnected: false,
      error: null,
      onMessage,
      onDisconnect,
      postMessage: (message) => {
        if (port.disconnected) throw new Error("Attempt to postMessage on disconnected port");
        port.posted.push(message);
      },
      disconnect: () => {
        port.disconnected = true;
      },
      deliver: (message) => {
        for (const listener of [...onMessage.listeners]) listener(message);
      },
      drop: (error) => {
        port.error = error === undefined ? null : { message: error };
        for (const listener of [...onDisconnect.listeners]) listener(port);
      },
    };
    return port;
  }

  function removeTabs(removed: FakeTab[]): void {
    for (const tab of removed) {
      fake.tabs.delete(tab.id);
      dropContentScript(tab.id);
    }
    for (const { groupId } of removed) {
      const empty = ![...fake.tabs.values()].some((tab) => tab.groupId === groupId);
      if (empty) fake.groups.delete(groupId);
    }
    for (const tab of removed) {
      for (const listener of [...onTabRemoved.listeners]) listener(tab.id);
    }
  }

  function activate(tab: FakeTab): void {
    for (const other of fake.tabs.values()) {
      if (other.windowId === tab.windowId) other.active = false;
    }
    tab.active = true;
  }

  function tabOf(tabId: number): FakeTab {
    const tab = fake.tabs.get(tabId);
    if (tab === undefined) throw new Error(`Invalid tab ID: ${tabId}`);
    return tab;
  }

  function snapshot(tab: FakeTab): Tab {
    const { history: _history, index: _index, ...fields } = tab;
    return fields;
  }

  function load(tab: FakeTab, url: string): void {
    if (tab.discarded === true) tab.discarded = false;
    // At the latest time stamp, so the time stamps fired after it stay as they were without it.
    fake.emitBeforeNavigate({ tabId: tab.id, frameId: 0, url, timeStamp: latestTimeStamp });
    const changed = tab.url !== url;
    tab.url = url;
    dropContentScript(tab.id);
    tab.status = "loading";
    // Firefox resets a tab's per-tab action values when it navigates.
    fake.badgeText.delete(tab.id);
    fake.badgeTitle.delete(tab.id);
    emit(tab, changed ? { status: "loading", url } : { status: "loading" });
    fake.emitCommitted({ tabId: tab.id, frameId: 0, url });
    queueMicrotask(() => {
      if (!fake.tabs.has(tab.id)) return;
      tab.status = "complete";
      tab.title = titleOf(url);
      emit(tab, { status: "complete" });
      if (fake.tabs.has(tab.id)) fake.emitCompleted({ tabId: tab.id, frameId: 0, url });
    });
  }

  function sizeOf(windowId: number): { width: number; height: number } {
    return fake.windowSizes.get(windowId) ?? { width: 1280, height: 800 };
  }

  function emit(tab: FakeTab, changeInfo: TabChangeInfo): void {
    for (const { listener, filter } of [...updatedListeners]) {
      if (filter === undefined || filter.tabId === tab.id)
        listener(tab.id, changeInfo, snapshot(tab));
    }
  }

  function go(tab: FakeTab, step: number): void {
    const url = tab.history[tab.index + step];
    if (url === undefined) return;
    tab.index += step;
    load(tab, url);
  }

  function createGroup(windowId = fake.currentWindowId): TabGroup {
    const group: TabGroup = { id: nextGroupId++, windowId };
    fake.groups.set(group.id, group);
    return group;
  }

  function groupOf(groupId: number): TabGroup {
    const group = fake.groups.get(groupId);
    if (group === undefined) throw new Error(`No group with id: ${groupId}`);
    return group;
  }
}

function cssCall(method: CssCall["method"], { target, css, origin }: CssInjection): CssCall {
  return structuredClone({ method, tabId: target.tabId, frameIds: target.frameIds, css, origin });
}

function frameOf(tabId: number, frameId: number): FrameDetails {
  return {
    frameId,
    documentId: `document-${tabId}-${frameId}`,
    parentFrameId: frameId === 0 ? -1 : 0,
  };
}

function createEvent<Listener>(): BrowserEvent<Listener> & { listeners: Set<Listener> } {
  const listeners = new Set<Listener>();
  return {
    listeners,
    addListener: (listener) => listeners.add(listener),
    removeListener: (listener) => listeners.delete(listener),
  };
}

function titleOf(url: string): string {
  return `Title of ${url}`;
}

export interface FakeTimers extends Timers<number> {
  /** Moves the clock forward, running each due callback in time order. */
  advance(ms: number): void;
  pending(): number;
}

export function createFakeTimers(): FakeTimers {
  const timers = new Map<number, { at: number; callback: () => void }>();
  let now = 0;
  let nextHandle = 1;
  return {
    setTimeout: (callback, delay) => {
      const handle = nextHandle++;
      timers.set(handle, { at: now + delay, callback });
      return handle;
    },
    clearTimeout: (handle) => {
      timers.delete(handle);
    },
    advance: (ms) => {
      const end = now + ms;
      for (let due = nextDue(end); due !== undefined; due = nextDue(end)) {
        const [handle, timer] = due;
        timers.delete(handle);
        now = timer.at;
        timer.callback();
      }
      now = end;
    },
    pending: () => timers.size,
  };

  function nextDue(end: number): [number, { at: number; callback: () => void }] | undefined {
    let next: [number, { at: number; callback: () => void }] | undefined;
    for (const entry of timers) {
      if (entry[1].at <= end && (next === undefined || entry[1].at < next[1].at)) next = entry;
    }
    return next;
  }
}

/** Resolves once every pending promise callback has run. */
export function flush(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

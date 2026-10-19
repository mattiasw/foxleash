import type {
  BrowserApi,
  BrowserEvent,
  MessageSender,
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
  windowUpdates: { windowId: number; drawAttention?: boolean }[];
  /** Makes the next `storage.local.set` reject, once. */
  failNextSet(): void;
  /** The user granting or revoking access to all websites in about:addons. */
  setAllUrls(granted: boolean): void;
  openTab(properties?: Partial<Omit<FakeTab, "id" | "history" | "index">>): FakeTab;
  /** The user closing a group: the group and its tabs go away. */
  closeGroup(groupId: number): void;
  /** The user closing a tab; an emptied group goes away. */
  removeTab(tabId: number): void;
  /** The user loading a URL in the tab, as by typing it in the address bar. */
  navigateByUser(tabId: number, url: string): void;
  /**
   * An extension page in a tab opening `runtime.connect({ name })`. Returns the page's end:
   * `posted` holds what the background posted, `deliver` sends a message as the page, `drop`
   * closes the page, and `disconnected` is set when the background disconnects.
   */
  connectPage(name: string, sender: MessageSender): FakePort;
  /** The user dragging a tab out of its group; an emptied group goes away. */
  ungroup(tabId: number): void;
  /** The user clicking the toolbar button while the tab is shown. */
  clickAction(tabId: number): void;
  emitStatus(tabId: number, status: string): void;
  /** Fires `storage.onChanged` with no changes, as for a storage area the fake does not keep. */
  emitStorageChanged(areaName: string): void;
  listenerCount(): number;
}

export interface FakeTab {
  id: number;
  windowId: number;
  active: boolean;
  url: string;
  title: string;
  status: string;
  groupId: number;
  history: string[];
  index: number;
}

export interface TabUpdate {
  tabId: number;
  url?: string;
  active?: boolean;
  loadReplace?: boolean;
}

/** The extension's id in the fake, and the host of its `getURL` URLs. */
export const FAKE_EXTENSION_ID = "foxhand@example.org";
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
  const onTabRemoved = createEvent<(tabId: number) => void>();
  let failSet = false;

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
      create: async ({ url, active, windowId }) =>
        snapshot(fake.openTab({ url, active, windowId: windowId ?? fake.currentWindowId })),
      update: async (tabId, properties) => {
        const tab = tabOf(tabId);
        fake.tabUpdates.push({ tabId, ...properties });
        if (properties.active === true) activate(tab);
        const { url } = properties;
        if (url === undefined) return snapshot(tab);
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
    },
    windows: {
      update: async (windowId, updateInfo) => {
        fake.windowUpdates.push({ windowId, ...updateInfo });
      },
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
    failNextSet: () => {
      failSet = true;
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
    connectPage: (name, sender) => {
      const port = createPort();
      const runtimePort: RuntimePort = Object.assign(port, { name, sender });
      for (const listener of [...onConnect.listeners]) listener(runtimePort);
      return port;
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
    listenerCount: () => updatedListeners.length,
  };
  return fake;

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
    for (const tab of removed) fake.tabs.delete(tab.id);
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
    const changed = tab.url !== url;
    tab.url = url;
    tab.status = "loading";
    // Firefox resets a tab's per-tab action values when it navigates.
    fake.badgeText.delete(tab.id);
    fake.badgeTitle.delete(tab.id);
    emit(tab, changed ? { status: "loading", url } : { status: "loading" });
    queueMicrotask(() => {
      if (!fake.tabs.has(tab.id)) return;
      tab.status = "complete";
      tab.title = titleOf(url);
      emit(tab, { status: "complete" });
    });
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

/** The part of Firefox's `browser.*` API that the extension uses. */
export interface BrowserApi {
  runtime: {
    connectNative(application: string): Port;
    onStartup: BrowserEvent<() => void>;
    onInstalled: BrowserEvent<() => void>;
    getManifest(): { version: string };
    openOptionsPage(): Promise<void>;
    /** This extension's id. */
    id: string;
    /** The full `moz-extension:` URL of a file in the extension. */
    getURL(path: string): string;
    onConnect: BrowserEvent<(port: RuntimePort) => void>;
    /** A listener replies by returning a promise, and returns undefined to not reply. */
    onMessage: BrowserEvent<
      (message: unknown, sender: MessageSender) => Promise<unknown> | undefined
    >;
    sendMessage(message: unknown): Promise<unknown>;
  };
  action: {
    setBadgeText(details: { tabId: number; text: string }): Promise<void>;
    setTitle(details: { tabId: number; title: string }): Promise<void>;
    onClicked: BrowserEvent<(tab: Tab) => void>;
  };
  permissions: {
    contains(permissions: { origins: string[] }): Promise<boolean>;
    onAdded: BrowserEvent<(permissions: Permissions) => void>;
    onRemoved: BrowserEvent<(permissions: Permissions) => void>;
  };
  tabs: {
    query(queryInfo: { groupId?: number; windowId?: number }): Promise<Tab[]>;
    get(tabId: number): Promise<Tab>;
    create(createProperties: { url: string; active: boolean; windowId?: number }): Promise<Tab>;
    update(
      tabId: number,
      updateProperties: { url?: string; active?: boolean; loadReplace?: boolean },
    ): Promise<Tab>;
    goBack(tabId: number): Promise<void>;
    goForward(tabId: number): Promise<void>;
    reload(tabId: number): Promise<void>;
    remove(tabIds: number[]): Promise<void>;
    group(options: {
      tabIds: number[];
      groupId?: number;
      createProperties?: { windowId: number };
    }): Promise<number>;
    onUpdated: {
      addListener(listener: TabUpdatedListener, filter?: TabUpdatedFilter): void;
      removeListener(listener: TabUpdatedListener): void;
    };
    onCreated: BrowserEvent<(tab: Tab) => void>;
    onRemoved: BrowserEvent<(tabId: number) => void>;
  };
  windows: {
    update(windowId: number, updateInfo: { drawAttention?: boolean }): Promise<unknown>;
  };
  tabGroups: {
    get(groupId: number): Promise<TabGroup>;
    update(groupId: number, updateProperties: { title: string; color: string }): Promise<TabGroup>;
  };
  storage: {
    local: {
      get(keys: null): Promise<Record<string, unknown>>;
      set(items: Record<string, unknown>): Promise<void>;
      remove(keys: string): Promise<void>;
    };
    onChanged: BrowserEvent<(changes: Record<string, StorageChange>, areaName: string) => void>;
  };
}

export interface BrowserEvent<Listener> {
  addListener(listener: Listener): void;
  removeListener(listener: Listener): void;
}

/** Firefox's `permissions.Permissions`. */
export interface Permissions {
  permissions?: string[];
  origins?: string[];
}

/** Firefox's `storage.StorageChange`. */
export interface StorageChange {
  oldValue?: unknown;
  newValue?: unknown;
}

export interface Port {
  postMessage(message: unknown): void;
  disconnect(): void;
  onMessage: BrowserEvent<(message: unknown) => void>;
  onDisconnect: BrowserEvent<(port: Port) => void>;
  error: { message: string } | null | undefined;
}

/** A port an extension page opened with `runtime.connect`. */
export interface RuntimePort extends Port {
  name: string;
  sender?: MessageSender;
}

/** Firefox's `runtime.MessageSender`, as far as the extension reads it. */
export interface MessageSender {
  id?: string;
  url?: string;
  tab?: { id: number };
}

export interface Tab {
  id: number;
  windowId: number;
  active: boolean;
  url?: string;
  title?: string;
  status?: string;
  /** -1 when the tab is in no group. */
  groupId?: number;
}

export interface TabGroup {
  id: number;
  windowId: number;
  title?: string;
  color?: string;
}

export interface TabChangeInfo {
  status?: string;
  url?: string;
  groupId?: number;
}

export type TabUpdatedListener = (tabId: number, changeInfo: TabChangeInfo, tab: Tab) => void;

export interface TabUpdatedFilter {
  tabId: number;
  properties: string[];
}

/** `setTimeout` and `clearTimeout`, passed in so tests control time. */
export interface Timers<Handle> {
  setTimeout(callback: () => void, delay: number): Handle;
  clearTimeout(handle: Handle): void;
}

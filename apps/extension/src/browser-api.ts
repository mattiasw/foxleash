/** The part of Firefox's `browser.*` API that the extension uses. */
export interface BrowserApi {
  runtime: {
    connectNative(application: string): Port;
    onStartup: BrowserEvent<() => void>;
    onInstalled: BrowserEvent<() => void>;
    getManifest(): { version: string };
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
    update(tabId: number, updateProperties: { url: string }): Promise<Tab>;
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
  };
  tabGroups: {
    get(groupId: number): Promise<TabGroup>;
    update(groupId: number, updateProperties: { title: string; color: string }): Promise<TabGroup>;
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

export interface Port {
  postMessage(message: unknown): void;
  disconnect(): void;
  onMessage: BrowserEvent<(message: unknown) => void>;
  onDisconnect: BrowserEvent<(port: Port) => void>;
  error: { message: string } | null | undefined;
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

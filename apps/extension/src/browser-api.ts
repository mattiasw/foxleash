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
    create(createProperties: {
      url: string;
      active: boolean;
      windowId?: number;
      discarded?: boolean;
    }): Promise<Tab>;
    update(
      tabId: number,
      updateProperties: { url?: string; active?: boolean; loadReplace?: boolean },
    ): Promise<Tab>;
    goBack(tabId: number): Promise<void>;
    goForward(tabId: number): Promise<void>;
    reload(tabId: number, reloadProperties?: { bypassCache?: boolean }): Promise<void>;
    remove(tabIds: number[]): Promise<void>;
    /** Rejects when no content script listens in the frame, or its page unloads before replying. */
    sendMessage(tabId: number, message: unknown, options?: { frameId?: number }): Promise<unknown>;
    /** Resolves to a data URL; `rect` is in CSS pixels, relative to the page. */
    captureTab(tabId: number, options: CaptureOptions): Promise<string>;
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
    /** A tab became the selected one of its window. */
    onActivated: BrowserEvent<(activeInfo: { tabId: number; windowId: number }) => void>;
    onRemoved: BrowserEvent<
      (tabId: number, removeInfo: { windowId: number; isWindowClosing: boolean }) => void
    >;
    /** The tab left its window, as when the user drags it to another one. */
    onDetached: BrowserEvent<(tabId: number) => void>;
  };
  windows: {
    update(
      windowId: number,
      updateInfo: {
        drawAttention?: boolean;
        focused?: boolean;
        state?: "normal";
        width?: number;
        height?: number;
      },
    ): Promise<unknown>;
    get(windowId: number): Promise<BrowserWindow>;
    create(createData: { url: string; focused: boolean }): Promise<BrowserWindow>;
    remove(windowId: number): Promise<void>;
    getAll(getInfo: { windowTypes: "normal"[]; populate: true }): Promise<BrowserWindow[]>;
    onRemoved: BrowserEvent<(windowId: number) => void>;
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
  scripting: {
    executeScript<Args extends unknown[], Result>(injection: {
      target: { tabId: number; frameIds?: number[] };
      func: (...args: Args) => Result;
      args: Args;
      world: "ISOLATED" | "MAIN";
      injectImmediately?: boolean;
    }): Promise<InjectionResult<Awaited<Result>>[]>;
    executeScript(injection: {
      target: { tabId: number; frameIds?: number[] };
      files: string[];
      injectImmediately?: boolean;
    }): Promise<InjectionResult<unknown>[]>;
    /** Rejects when a frame of the target does not take the sheet. */
    insertCSS(injection: CssInjection): Promise<void>;
    /** Removes a sheet `insertCSS` added with the same details. */
    removeCSS(injection: CssInjection): Promise<void>;
  };
  webNavigation: {
    /** Null for a tab Firefox has discarded. */
    getAllFrames(details: { tabId: number }): Promise<FrameDetails[] | null>;
    /** A frame of a tab, the top one included, is about to navigate. */
    onBeforeNavigate: BrowserEvent<(details: NavigationDetails) => void>;
    /** A frame of a tab, the top one included, committed to a new document. */
    onCommitted: BrowserEvent<(details: NavigationDetails) => void>;
    /** A frame of a tab finished loading its document. */
    onCompleted: BrowserEvent<(details: NavigationDetails) => void>;
    /** A frame's page changed its address with the History API, without a load. */
    onHistoryStateUpdated: BrowserEvent<(details: NavigationDetails) => void>;
    /** A frame's document finished parsing. */
    onDOMContentLoaded: BrowserEvent<(details: DocumentDetails) => void>;
  };
  /** Non-blocking listeners only: Foxleash watches requests and never blocks or changes one. */
  webRequest: {
    onBeforeRequest: WebRequestEvent<(details: RequestDetails) => void>;
    onSendHeaders: WebRequestEvent<(details: SendHeadersDetails) => void>;
    onHeadersReceived: WebRequestEvent<(details: HeadersReceivedDetails) => void>;
    onBeforeRedirect: WebRequestEvent<(details: RedirectDetails) => void>;
    onCompleted: WebRequestEvent<(details: CompletedDetails) => void>;
    onErrorOccurred: WebRequestEvent<(details: ErrorDetails) => void>;
  };
  downloads: {
    /** Resolves to the new download's id; rejects when Firefox refuses the options. */
    download(options: {
      url: string;
      filename: string;
      saveAs: false;
      conflictAction: "uniquify";
    }): Promise<number>;
    search(query: { id: number }): Promise<DownloadItem[]>;
    cancel(id: number): Promise<void>;
    onChanged: BrowserEvent<(delta: DownloadDelta) => void>;
  };
}

/** Firefox's `downloads.DownloadItem`, as far as the extension reads it. */
export interface DownloadItem {
  id: number;
  /** The absolute path of the file. */
  filename: string;
  /** "in_progress", "interrupted" or "complete". */
  state: string;
}

/** Firefox's `downloads.onChanged` delta, as far as the extension reads it. */
export interface DownloadDelta {
  id: number;
  state?: { current?: string };
}

export interface WebRequestEvent<Listener> {
  addListener(
    listener: Listener,
    filter: { urls: string[] },
    extraInfoSpec?: ("requestHeaders" | "responseHeaders" | "requestBody")[],
  ): void;
  removeListener(listener: Listener): void;
}

/** What every `webRequest` event carries, as far as the extension reads it. */
export interface WebRequestDetails {
  requestId: string;
  /** -1 for a request that belongs to no tab. */
  tabId: number;
  /** ms since the epoch. */
  timeStamp: number;
}

export interface RequestDetails extends WebRequestDetails {
  frameId: number;
  url: string;
  method: string;
  type: string;
  documentUrl?: string;
  originUrl?: string;
  /** From the requesting frame's parent up to the top-level document. */
  frameAncestors?: { url: string; frameId: number }[];
  /** With "requestBody": null for a request that sent no body. */
  requestBody?: RequestBody | null;
}

/** Firefox's webRequest requestBody. */
export interface RequestBody {
  error?: string;
  /** A urlencoded part with no `=` gives an `undefined` value. */
  formData?: Record<string, (string | undefined)[]>;
  raw?: UploadChunk[];
}

export interface UploadChunk {
  bytes?: ArrayBuffer;
  file?: string;
  /** Not in Firefox's schema: set when its byte limit cut the body. */
  truncated?: boolean;
}

export interface SendHeadersDetails extends WebRequestDetails {
  requestHeaders?: HttpHeader[];
}

export interface HeadersReceivedDetails extends WebRequestDetails {
  statusCode: number;
  responseHeaders?: HttpHeader[];
}

export interface RedirectDetails extends WebRequestDetails {
  statusCode: number;
  redirectUrl: string;
  fromCache: boolean;
}

export interface CompletedDetails extends WebRequestDetails {
  statusCode: number;
  fromCache: boolean;
  responseHeaders?: HttpHeader[];
}

export interface ErrorDetails extends WebRequestDetails {
  error: string;
}

/** Firefox's `webRequest.HttpHeaders` entry; its `binaryValue` is never read. */
export interface HttpHeader {
  name: string;
  value?: string;
}

/** A style sheet for `scripting.insertCSS` and `removeCSS`, one frame at a time here. */
export interface CssInjection {
  target: { tabId: number; frameIds: number[] };
  css: string;
  origin: "USER";
}

/** One frame of `webNavigation.getAllFrames`, as far as the extension reads it. */
export interface FrameDetails {
  frameId: number;
  /** Firefox's id of the frame's current document. */
  documentId?: string;
  /** The address the frame shows; for Firefox's error page, the URL that failed. */
  url?: string;
  /** The parent frame's id, -1 for the top frame. */
  parentFrameId?: number;
}

/** The details of `webNavigation.onDOMContentLoaded`, as far as the extension reads them. */
export interface DocumentDetails {
  tabId: number;
  frameId: number;
  /**
   * The document's own address: `about:neterror?...` for Firefox's error page, where
   * `onCommitted` gives the URL that failed.
   */
  url: string;
  /** The document the frame shows when Firefox handles the event. */
  documentId?: string;
}

/** The details of a `webNavigation` event, as far as the extension reads them. */
export interface NavigationDetails {
  tabId: number;
  frameId: number;
  url: string;
  /** ms since the epoch, the clock of `webRequest`'s `timeStamp`. */
  timeStamp: number;
  /** Firefox's id of the frame's document, where Firefox gives one. */
  documentId?: string;
}

/** The options of `tabs.captureTab` that the extension uses. */
export interface CaptureOptions {
  format: "png";
  scale?: number;
  rect?: CaptureArea;
}

export interface CaptureArea {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** One frame's outcome of `scripting.executeScript`. */
export interface InjectionResult<T> {
  frameId: number;
  /** Firefox's id of the document the script ran in, where Firefox gives one. */
  documentId?: string;
  result?: T;
  error?: unknown;
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
  /** True while Firefox has unloaded the tab to save memory. */
  discarded?: boolean;
  /** -1 when the tab is in no group. */
  groupId?: number;
}

/** Firefox's `windows.Window`, as far as the extension reads it. */
export interface BrowserWindow {
  id?: number;
  width?: number;
  height?: number;
  state?: string;
  focused?: boolean;
  /** With `populate`, and on `windows.create`. */
  tabs?: Tab[];
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

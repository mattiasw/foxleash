import { PAGE_VIEW_MAX_CHARS, type PageView } from "@foxleash/protocol";
import type { BrowserApi } from "./browser-api.ts";
import { type DiffLine, lineDiff } from "./line-diff.ts";
import { createLiveDocuments, type LiveDocument } from "./live-documents.ts";
import { INTERACTIVE_ROLES, LANDMARK_ROLES } from "./page-tree.ts";
import type { SessionGroups } from "./session-groups.ts";
import type { SiteAccess } from "./site-access.ts";

/**
 * The tree the view reads, as read_page's filter: prices, counts and messages such as "Added to
 * cart" are text, which the interactive filter leaves out (ADR 0050).
 */
export const VIEW_FILTER = "all";
/** The lines the relevance cut keeps before and after each line of the element the act aimed at. */
export const FOCUS_CONTEXT_LINES = 5;

/** Roles whose lines, with all they contain, the relevance cut keeps right after the act's element. */
const LIVE_ROLES: ReadonlySet<string> = new Set([
  "alert",
  "alertdialog",
  "status",
  "log",
  "dialog",
]);
const ADDED = "+ ";
const REMOVED = "- ";
const UNCHANGED = "  ";

/** A read_page reply, checked. */
export interface TreeRead {
  tree: string;
  truncated: boolean;
}

export interface PageViewsDeps {
  browser: Pick<BrowserApi, "tabs" | "webNavigation" | "storage">;
  groups: Pick<SessionGroups, "sessionOf">;
  access: Pick<SiteAccess, "view" | "openPrompt" | "onWithdraw" | "onGrant">;
}

export interface PageViews {
  /** The tab's live document now: a new object at each top-frame commit (see live-documents.ts). */
  document(tabId: number): LiveDocument | undefined;
  /**
   * The view of `read` for the session's tab, `before` being `document(tabId)` right before the
   * read: the whole tree, cut by relevance past PAGE_VIEW_MAX_CHARS with `focus` (refs) kept
   * first, or what changed since the last view of the same document. Records the read as that
   * last view, unless the document changed during the read or is not live.
   */
  view(
    session: string,
    tabId: number,
    before: LiveDocument | undefined,
    read: TreeRead,
    focus: readonly string[],
  ): PageView;
  /** Records a whole read_page as the last view given, under the same rule as `view`. */
  record(session: string, tabId: number, before: LiveDocument | undefined, read: TreeRead): void;
  forget(session: string, tabId: number): void;
  endSession(session: string): void;
}

interface Entry {
  document: LiveDocument;
  tree: string;
  truncated: boolean;
}

/**
 * Keeps, per tab and session, the last view of the page given, and builds the next one against
 * it. Adds its listeners at once (call it at the top level of the background script).
 */
export function createPageViews({ browser, groups, access }: PageViewsDeps): PageViews {
  const documents = createLiveDocuments({ browser, groups, access, failure: "page_view_failed" });
  const memory = new Map<number, Map<string, Entry>>();
  browser.tabs.onRemoved.addListener((tabId) => {
    memory.delete(tabId);
  });
  access.onWithdraw(withdraw);

  return { document, view, record, forget, endSession };

  function document(tabId: number): LiveDocument | undefined {
    return documents.live(tabId);
  }

  function view(
    session: string,
    tabId: number,
    before: LiveDocument | undefined,
    read: TreeRead,
    focus: readonly string[],
  ): PageView {
    const current = documents.live(tabId);
    // A commit during the read, or a page the gate passed with no live document: shown, not kept.
    if (current === undefined || current !== before) return treeView(read, focus);
    const last = lastView(session, tabId, current);
    keep(session, tabId, { document: current, ...read });
    return last === undefined ? treeView(read, focus) : changedView(last, read, focus);
  }

  function record(
    session: string,
    tabId: number,
    before: LiveDocument | undefined,
    read: TreeRead,
  ): void {
    const current = documents.live(tabId);
    if (current !== undefined && current === before) {
      keep(session, tabId, { document: current, ...read });
    }
  }

  /** The session's last view of the tab, when it was of `current`; `keep` replaces an older one. */
  function lastView(session: string, tabId: number, current: LiveDocument): Entry | undefined {
    const entry = memory.get(tabId)?.get(session);
    return entry?.document === current ? entry : undefined;
  }

  function keep(session: string, tabId: number, entry: Entry): void {
    const sessions = memory.get(tabId) ?? new Map<string, Entry>();
    memory.set(tabId, sessions);
    sessions.set(session, entry);
  }

  function forget(session: string, tabId: number): void {
    const sessions = memory.get(tabId);
    sessions?.delete(session);
    if (sessions?.size === 0) memory.delete(tabId);
  }

  /** The session's approval of the site ended: what it was shown on that site is dropped. */
  function withdraw(session: string, site: string): void {
    for (const [tabId, sessions] of [...memory]) {
      if (sessions.get(session)?.document.site === site) forget(session, tabId);
    }
  }

  function endSession(session: string): void {
    for (const tabId of [...memory.keys()]) forget(session, tabId);
  }
}

/** The tree, whole when it fits in PAGE_VIEW_MAX_CHARS, else cut by relevance. */
function treeView(read: TreeRead, focus: readonly string[]): PageView {
  if (read.tree.length <= PAGE_VIEW_MAX_CHARS) {
    return { kind: "tree", tree: read.tree, omitted: 0, truncated: read.truncated };
  }
  const { tree, omitted } = cutTree(read.tree, focus);
  return { kind: "tree", tree, omitted, truncated: read.truncated };
}

/**
 * The lines that changed from `last` to `read`, or the tree view when that is shorter: so the
 * changes stay within what the tree view takes.
 */
function changedView(last: Entry, read: TreeRead, focus: readonly string[]): PageView {
  const truncated = read.truncated || last.truncated;
  if (last.tree === read.tree) return { kind: "unchanged", truncated };
  const diff = lineDiff(last.tree, read.tree);
  const lines = changedLines(read.truncated ? withoutCutTail(diff) : diff);
  if (lines === "") return { kind: "unchanged", truncated };
  const whole = treeView(read, focus);
  if (whole.kind === "tree" && lines.length > whole.tree.length) return whole;
  return { kind: "changes", lines, truncated };
}

/**
 * The diff without its last removed lines: a read cut at READ_PAGE_MAX_CHARS ends where the cut
 * fell, so lines past its last line were pushed past the cut, not removed.
 */
function withoutCutTail(diff: readonly DiffLine[]): readonly DiffLine[] {
  const last = diff.findLastIndex((line) => line.kind !== "removed");
  return diff.slice(0, last + 1);
}

interface ShownLine {
  text: string;
  level: number;
  shown: boolean;
}

/**
 * Each changed line with its marker, after the unchanged lines that contain it and were not shown
 * yet: those of an added line from the new tree, of a removed line from the old one.
 */
export function changedLines(diff: readonly DiffLine[]): string {
  const out: string[] = [];
  // The lines that contain the current line, outermost first, in the old tree and in the new.
  const old: ShownLine[] = [];
  const current: ShownLine[] = [];
  for (const { kind, text } of diff) {
    const line = { text, level: levelOf(text), shown: kind !== "same" };
    if (kind !== "added") climbTo(old, line.level);
    if (kind !== "removed") climbTo(current, line.level);
    if (kind === "removed") show(old, out, REMOVED, text);
    if (kind === "added") show(current, out, ADDED, text);
    if (kind !== "added") old.push(line);
    if (kind !== "removed") current.push(line);
  }
  return out.join("\n");
}

function climbTo(chain: ShownLine[], level: number): void {
  while ((chain.at(-1)?.level ?? -1) >= level) chain.pop();
}

function show(chain: readonly ShownLine[], out: string[], marker: string, text: string): void {
  for (const outer of chain) {
    if (outer.shown) continue;
    out.push(`${UNCHANGED}${outer.text}`);
    outer.shown = true;
  }
  out.push(`${marker}${text}`);
}

interface TreeLine {
  text: string;
  level: number;
  role: string;
  ref: string | undefined;
  /** The index of the line that contains it, or -1. */
  parent: number;
  /** The index after its last contained line. */
  end: number;
}

/** A run of left-out lines under one kept line, from `first` to `last`. */
interface Run {
  first: number;
  last: number;
}

/**
 * The lines of a tree to keep within `max` characters, by relevance: the lines of `focus` and
 * those around them, live regions and dialogs with all they contain, headings and landmarks,
 * fields and buttons, links, then the rest. Each kept line comes with the lines that contain it,
 * in document order; each run of lines left out under one line is one line, `… N lines`, at the
 * level of the lines it stands for. `omitted` counts the tree lines left out.
 */
export function cutTree(
  tree: string,
  focus: readonly string[],
  max: number = PAGE_VIEW_MAX_CHARS,
): { tree: string; omitted: number } {
  const lines = parseTree(tree);
  const kept = new Set<number>();
  const runs = new Map<number, Run[]>([[-1, [{ first: 0, last: lines.length - 1 }]]]);
  // Each line and each placeholder with its newline; the last has none.
  let used = runCost(lines, -1, { first: 0, last: lines.length - 1 });
  for (const index of candidates(lines, focus)) {
    if (kept.has(index)) continue;
    const step = keepStep(lines, kept, runs, index);
    if (step === undefined || used + step.cost - 1 > max) continue;
    for (const line of step.lines) kept.add(line);
    const [parent, replaced] = step.replaced;
    runs.set(
      parent,
      (runs.get(parent) ?? []).filter((run) => run !== replaced),
    );
    for (const [under, run] of step.added) runs.set(under, [...(runs.get(under) ?? []), run]);
    used += step.cost;
  }
  return { tree: render(lines, kept, runs), omitted: lines.length - kept.size };
}

interface KeepStep {
  /** The line and the lines containing it that are not kept yet, outermost first. */
  lines: number[];
  /** The run that held the outermost of them, with the line it is under. */
  replaced: [number, Run];
  /** The runs left around and under the lines, each with the line it is under. */
  added: [number, Run][];
  /** The characters keeping them adds, newlines included. */
  cost: number;
}

/** What keeping the line, with the lines containing it, changes; undefined if no run holds it. */
function keepStep(
  lines: readonly TreeLine[],
  kept: ReadonlySet<number>,
  runs: ReadonlyMap<number, Run[]>,
  index: number,
): KeepStep | undefined {
  const chain: number[] = [];
  let parent = index;
  while (parent >= 0 && !kept.has(parent)) {
    chain.unshift(parent);
    parent = lines[parent]?.parent ?? -1;
  }
  let run = runs.get(parent)?.find(({ first, last }) => first <= index && index <= last);
  if (run === undefined) return undefined;
  const replaced: [number, Run] = [parent, run];
  const added: [number, Run][] = [];
  let cost = -runCost(lines, parent, run);
  for (const line of chain) {
    const { text, end } = lines[line] ?? { text: "", end: line + 1 };
    cost += text.length + 1;
    for (const part of [
      { first: run.first, last: line - 1 },
      { first: end, last: run.last },
    ]) {
      if (part.first > part.last) continue;
      added.push([parent, part]);
      cost += runCost(lines, parent, part);
    }
    parent = line;
    run = { first: line + 1, last: end - 1 };
  }
  if (run.first <= run.last) {
    added.push([parent, run]);
    cost += runCost(lines, parent, run);
  }
  return { lines: chain, replaced, added, cost };
}

/** The placeholder's length with its newline. */
function runCost(lines: readonly TreeLine[], parent: number, run: Run): number {
  return placeholder(lines, parent, run).length + 1;
}

/** One level under the line the run is under: the level of the lines it stands for. */
function placeholder(lines: readonly TreeLine[], parent: number, run: Run): string {
  const level = parent < 0 ? 0 : (lines[parent]?.level ?? -1) + 1;
  const count = run.last - run.first + 1;
  const counted = count === 1 ? "1 line" : `${count.toLocaleString("en-US")} lines`;
  return `${" ".repeat(level)}… ${counted}`;
}

/** The line indexes in the order the cut tries them; a line can come more than once. */
function candidates(lines: readonly TreeLine[], focus: readonly string[]): number[] {
  const wanted = new Set(focus);
  const focused: number[] = [];
  const around = new Set<number>();
  const live: number[] = [];
  const outline: number[] = [];
  const controls: number[] = [];
  const links: number[] = [];
  let liveEnd = 0;
  for (const [index, { role, ref, end }] of lines.entries()) {
    if (ref !== undefined && wanted.has(ref)) {
      focused.push(index);
      const first = Math.max(0, index - FOCUS_CONTEXT_LINES);
      const last = Math.min(lines.length - 1, index + FOCUS_CONTEXT_LINES);
      for (let line = first; line <= last; line += 1) around.add(line);
    }
    if (index >= liveEnd && LIVE_ROLES.has(role)) liveEnd = end;
    if (index < liveEnd) live.push(index);
    if (role === "heading" || LANDMARK_ROLES.has(role)) outline.push(index);
    else if (role === "link") links.push(index);
    else if (INTERACTIVE_ROLES.has(role)) controls.push(index);
  }
  const rest = lines.map((_line, index) => index);
  return [
    ...focused,
    ...[...around].sort((a, b) => a - b),
    ...live,
    ...outline,
    ...controls,
    ...links,
    ...rest,
  ];
}

function render(
  lines: readonly TreeLine[],
  kept: ReadonlySet<number>,
  runs: ReadonlyMap<number, Run[]>,
): string {
  const starts = new Map<number, string>();
  for (const [parent, list] of runs) {
    for (const run of list) starts.set(run.first, placeholder(lines, parent, run));
  }
  const out: string[] = [];
  for (const [index, line] of lines.entries()) {
    if (kept.has(index)) out.push(line.text);
    else {
      const shown = starts.get(index);
      if (shown !== undefined) out.push(shown);
    }
  }
  return out.join("\n");
}

/**
 * The tree's lines with their level, role, ref and place. A line that does not parse is still a
 * line: its level from its spaces, its role its first word, no ref.
 */
function parseTree(tree: string): TreeLine[] {
  const lines: TreeLine[] = [];
  // The lines that contain the current one, innermost last.
  const open: number[] = [];
  for (const text of tree.split("\n")) {
    const index = lines.length;
    const { level, role, ref } = parseLine(text);
    while (open.length > 0 && (lines[open.at(-1) ?? -1]?.level ?? -1) >= level) {
      const closed = lines[open.pop() ?? -1];
      if (closed !== undefined) closed.end = index;
    }
    lines.push({ text, level, role, ref, parent: open.at(-1) ?? -1, end: index + 1 });
    open.push(index);
  }
  for (const index of open) {
    const line = lines[index];
    if (line !== undefined) line.end = lines.length;
  }
  return lines;
}

/**
 * A line as formatLine in page-tree.ts writes it: one space per level, the role, then a name as a
 * JSON string, then the ref in brackets. The name is skipped, never parsed whole.
 */
function parseLine(text: string): { level: number; role: string; ref: string | undefined } {
  const level = levelOf(text);
  const roleEnd = text.indexOf(" ", level);
  const role = text.slice(level, roleEnd === -1 ? text.length : roleEnd);
  if (roleEnd === -1) return { level, role, ref: undefined };
  let at = roleEnd + 1;
  if (text[at] === '"') {
    at = afterString(text, at) + 1;
  }
  if (text[at] !== "[") return { level, role, ref: undefined };
  const close = text.indexOf("]", at);
  return { level, role, ref: close === -1 ? undefined : text.slice(at + 1, close) };
}

function levelOf(text: string): number {
  let level = 0;
  while (text[level] === " ") level += 1;
  return level;
}

/** The index after the JSON string that starts at `start`, or the text's length when it does not end. */
function afterString(text: string, start: number): number {
  for (let at = start + 1; at < text.length; at += 1) {
    const char = text[at];
    if (char === "\\") at += 1;
    else if (char === '"') return at + 1;
  }
  return text.length;
}

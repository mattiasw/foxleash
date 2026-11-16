import { NODE_REQUIREMENT, SETUP_COMMAND } from "@foxleash/protocol";
import type { BrowserApi, Timers } from "./browser-api.ts";
import { warn } from "./log.ts";

export interface ProgramElements {
  /** The live region (role="status" aria-live="polite"), holding the checking sentence at load. */
  status: Pick<HTMLElement, "textContent">;
  /** What the user needs to install the program; shown only while it is missing. */
  setup: Pick<HTMLElement, "hidden">;
  command: Pick<HTMLElement, "textContent">;
  requirement: Pick<HTMLElement, "textContent">;
}

/** The page's `document`, as far as the polling reads it. */
export interface ProgramPage {
  readonly visibilityState: string;
  addEventListener(type: "visibilitychange", listener: () => void): void;
}

export interface ProgramDeps<Handle> {
  elements: ProgramElements;
  browser: { runtime: Pick<BrowserApi["runtime"], "sendMessage"> };
  page: ProgramPage;
  timers: Timers<Handle>;
}

type ShownState = "connected" | "missing";

export const POLL_MS = 1000;

export const SENTENCES: Record<ShownState, string> = {
  connected: "The Foxleash program is connected.",
  missing:
    "The Foxleash program is not found on this computer yet. This page updates by itself once it is connected.",
};

/**
 * Shows whether the Foxleash program is connected, asking the background every second while the
 * page is visible, and at once when it becomes visible again.
 */
export function watchProgram<Handle>({
  elements,
  browser,
  page,
  timers,
}: ProgramDeps<Handle>): void {
  let timer: Handle | undefined;
  // Requests sent, and the latest one whose reply was applied.
  let sent = 0;
  let applied = 0;
  let shown: ShownState | undefined;

  elements.command.textContent = SETUP_COMMAND;
  elements.requirement.textContent = NODE_REQUIREMENT;
  page.addEventListener("visibilitychange", () => {
    if (page.visibilityState === "visible") ask();
  });
  ask();

  function ask(): void {
    if (timer !== undefined) timers.clearTimeout(timer);
    // Scheduled before the reply, so a request that never settles does not stop the polling.
    timer = page.visibilityState === "visible" ? timers.setTimeout(ask, POLL_MS) : undefined;
    sent += 1;
    const current = sent;
    browser.runtime.sendMessage({ type: "program_state" }).then(
      (reply) => replied(current, reply),
      (error: unknown) => warn({ event: "program_state_failed", error: String(error) }),
    );
  }

  function replied(current: number, reply: unknown): void {
    if (current < applied) return;
    applied = current;
    // Not page-ui.ts's fieldsOf: this module stays free of DOM code, so its tests load none.
    const state =
      typeof reply === "object" && reply !== null && "state" in reply ? reply.state : undefined;
    if (state !== "checking" && state !== "connected" && state !== "missing") {
      warn({ event: "program_state_unreadable" });
      return;
    }
    // A restarted background answers "checking" until it knows; the page keeps what it showed.
    if (state === "checking" || state === shown) return;
    shown = state;
    elements.status.textContent = SENTENCES[state];
    elements.setup.hidden = state === "connected";
  }
}

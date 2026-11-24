import { ALL_WEBSITES_ACCESS_STEPS } from "@foxleash/protocol";
import type { BrowserApi } from "./browser-api.ts";
import { warn } from "./log.ts";

export interface WebsiteAccessElements {
  /** The explanation, the button and the steps; hidden while Firefox gives the access. */
  warning: Pick<HTMLElement, "hidden">;
  button: { addEventListener(type: "click", listener: () => void): void };
  steps: Pick<HTMLElement, "textContent">;
}

export interface WebsiteAccessDeps {
  elements: WebsiteAccessElements;
  browser: {
    permissions: Pick<BrowserApi["permissions"], "contains" | "request" | "onAdded" | "onRemoved">;
  };
  /** Writes to the page's live region for the access, which is always rendered. */
  announce(text: string): void;
  /**
   * Runs once, in the same task, before each change the module makes to the page: the warning
   * showing or hiding with its announcement, or an announcement alone. hiding is true when the
   * warning is about to hide, so the page can move focus out of it first.
   */
  beforeChange?(hiding: boolean): void;
  /**
   * Runs with true in the click's task once Firefox has been asked for the access, and with false
   * when its answer arrives, before anything that answer changes. Firefox 153 opens its prompt
   * without taking focus, so keys meant for the prompt still reach the page meanwhile.
   */
  onRequest?(pending: boolean): void;
}

type Shown = "withheld" | "granted";

export const SENTENCES = {
  withheld: "Firefox is not giving Foxleash access to all websites.",
  granted: "Firefox now gives Foxleash access to all websites.",
  refused: "Firefox did not give Foxleash access to all websites.",
  failed: `Firefox could not ask you for the access. You can ${ALL_WEBSITES_ACCESS_STEPS}.`,
} as const;

/**
 * Shows the warning while Firefox withholds Foxleash's access to all websites, follows the access
 * as it changes, and asks Firefox for it when the user clicks the button.
 */
export function watchWebsiteAccess({
  elements,
  browser,
  announce,
  beforeChange,
  onRequest,
}: WebsiteAccessDeps): void {
  // Checks sent, and the latest one whose answer was applied.
  let sent = 0;
  let applied = 0;
  let shown: Shown | undefined;
  let requesting = false;

  elements.steps.textContent = ALL_WEBSITES_ACCESS_STEPS;
  // Also fired for a single site, so each event asks again instead of reading the event.
  browser.permissions.onAdded.addListener(check);
  browser.permissions.onRemoved.addListener(check);
  elements.button.addEventListener("click", ask);
  check();

  function check(): void {
    sent += 1;
    const current = sent;
    browser.permissions.contains({ origins: ["<all_urls>"] }).then(
      (granted) => answered(current, granted),
      (error: unknown) => warn({ event: "website_access_check_failed", error: String(error) }),
    );
  }

  function answered(current: number, granted: boolean): void {
    if (current < applied) return;
    applied = current;
    const before = shown;
    shown = granted ? "granted" : "withheld";
    // The markup starts hidden, so a first answer of granted has nothing to change.
    if (shown === before || (before === undefined && granted)) return;
    beforeChange?.(granted);
    elements.warning.hidden = granted;
    announce(granted ? SENTENCES.granted : SENTENCES.withheld);
  }

  function ask(): void {
    if (requesting) return;
    let request: Promise<boolean>;
    try {
      // Firefox allows this only while it handles the user's input: nothing may be awaited first.
      request = browser.permissions.request({ origins: ["<all_urls>"] });
    } catch (error: unknown) {
      failed(error);
      return;
    }
    requesting = true;
    onRequest?.(true);
    request.then(
      (granted) => {
        requesting = false;
        onRequest?.(false);
        if (granted) check();
        else outcome(SENTENCES.refused);
      },
      (error: unknown) => {
        requesting = false;
        onRequest?.(false);
        failed(error);
      },
    );
  }

  function failed(error: unknown): void {
    warn({ event: "website_access_request_failed", error: String(error) });
    outcome(SENTENCES.failed);
  }

  function outcome(text: string): void {
    // The access may have been given another way while Firefox's prompt was open.
    if (shown === "granted") return;
    beforeChange?.(false);
    announce(text);
  }
}

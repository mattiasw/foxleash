import { MAX_RECIPES, type RecipeFields, type Result } from "@foxhand/protocol";
import type { BrowserApi, Port, RuntimePort, Tab } from "./browser-api.ts";
import { ToolError } from "./handlers.ts";
import { checkRecipe, lookOf, readRecipes, saveRecipe } from "./recipes.ts";
import type { SessionGroups } from "./session-groups.ts";
import { isRecord } from "./settings.ts";
import { approvalPending, fieldsOf, portShowsPage, post, type SiteAccess } from "./site-access.ts";

/** The extension page that shows a proposed recipe, which only the user's click saves. */
export const PROPOSE_PAGE = "propose.html";

const PORT_NAME = "recipe";
// Recipe pages discarded or closed without an answer that a session may have before Foxhand
// stops opening them.
const RECIPE_PROMPT_BUDGET = 3;
const READ_FAILED = "Firefox could not read the stored recipes. Reload the page to try again.";

export interface RecipePromptsDeps {
  browser: Pick<BrowserApi, "runtime" | "tabs" | "windows" | "storage">;
  groups: Pick<SessionGroups, "groupOf" | "ensureGroup" | "closeTab">;
  access: Pick<SiteAccess, "openPrompt">;
}

export interface RecipePrompts {
  /** Opens the propose page in the session's group, selected; resolves with its tab once recorded. */
  propose(session: string, recipe: RecipeFields): Promise<Result<"recipe_propose">>;
  /** The session's open recipe page. */
  openPrompt(session: string): { tabId: number } | undefined;
  /** Detaches the session's propose page, which can still save, and forgets the session's budget. */
  endSession(session: string): void;
  /** Whether a tab showing `url` may close with a session's group: a propose page no open prompt shows. */
  isBlankPage(url: string): boolean;
}

interface ProposePrompt {
  session: string;
  /** The proposal, normalized by checkRecipe. */
  recipe: RecipeFields;
  tabId: number;
  pageUrl: string;
  /** The tab has shown the page, so leaving it closes the prompt. */
  committed: boolean;
  /** The connected page; messages count only from this port. */
  port: Port | undefined;
  /** A page ever connected, so the user could have seen the proposal. */
  seen: boolean;
  /** A save is being handled. */
  answering: boolean;
  /** Its session ended; it counts toward no budget. */
  detached: boolean;
}

interface Shown {
  name: string;
  savedAt: string | null;
}

export function createRecipePrompts({ browser, groups, access }: RecipePromptsDeps): RecipePrompts {
  // Maps throughout: session ids and recipe names may be "__proto__".
  const open = new Map<string, ProposePrompt>();
  // By page URL: pages whose session ended.
  const detached = new Map<string, ProposePrompt>();
  // By session: pages discarded or closed without an answer.
  const budget = new Map<string, number>();

  browser.runtime.onConnect.addListener(connect);
  browser.tabs.onRemoved.addListener((tabId) => {
    for (const prompt of promptsIn(tabId)) drop(prompt);
  });
  browser.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
    for (const prompt of promptsIn(tabId)) {
      if (changeInfo.url !== undefined && changeInfo.url !== prompt.pageUrl) {
        // Before the page commits, a URL can be a late event of the page it replaces.
        if (prompt.committed) drop(prompt);
      } else if (
        changeInfo.url === prompt.pageUrl ||
        (changeInfo.status === "complete" && tab.url === prompt.pageUrl)
      ) {
        prompt.committed = true;
      }
    }
  });

  return { propose, openPrompt, endSession, isBlankPage };

  async function propose(session: string, recipe: RecipeFields): Promise<Result<"recipe_propose">> {
    refuseOpening(session);
    const group = await groups.groupOf(session);
    const pageUrl = `${browser.runtime.getURL(PROPOSE_PAGE)}?id=${crypto.randomUUID()}`;
    // Unloaded, the page cannot connect before its prompt is recorded.
    const tab = await browser.tabs.create(
      group === undefined
        ? { url: pageUrl, active: false, discarded: true }
        : { url: pageUrl, active: false, discarded: true, windowId: group.windowId },
    );
    // No await from here until the prompt is recorded, so parallel requests see one prompt.
    try {
      refuseOpening(session);
    } catch (error) {
      await closeNewTab(tab.id);
      throw error;
    }
    const prompt: ProposePrompt = {
      session,
      recipe,
      tabId: tab.id,
      pageUrl,
      committed: false,
      port: undefined,
      seen: false,
      answering: false,
      detached: false,
    };
    open.set(session, prompt);
    let shown: Tab;
    try {
      await groups.ensureGroup(session, tab);
      // A page the user selected early may have been answered or left meanwhile; what the
      // tab shows now is the user's.
      if (!isLive(prompt)) return { tabId: tab.id };
      // Loaded rather than only selected: a page the user selected before the prompt was
      // recorded loads again and connects.
      shown = await browser.tabs.update(tab.id, { url: pageUrl, active: true, loadReplace: true });
    } catch (error) {
      if (isLive(prompt)) {
        abandon(prompt);
        await closeNewTab(tab.id);
      }
      throw error;
    }
    try {
      await browser.windows.update(shown.windowId, { drawAttention: true });
    } catch {}
    return { tabId: tab.id };
  }

  function refuseOpening(session: string): void {
    const site = access.openPrompt(session);
    if (site !== undefined) throw approvalPending(site.tabId, `whether to allow ${site.site}`);
    const page = open.get(session);
    if (page !== undefined) {
      throw new ToolError(
        "recipe_prompt_open",
        `Foxhand is still showing the user a recipe page in tab ${page.tabId}. Try again after the user has answered there.`,
      );
    }
    if ((budget.get(session) ?? 0) >= RECIPE_PROMPT_BUDGET) {
      throw new ToolError(
        "recipe_prompt_refused",
        "Foxhand shows no more recipe pages in this session after three that were discarded or closed without an answer. Start a new session to be asked again.",
      );
    }
  }

  /** Never rejects; leaves a window's last tab. */
  async function closeNewTab(tabId: number): Promise<void> {
    const closed = await groups.closeTab(tabId, () => {}).catch(() => undefined);
    if (closed) await closed.removed.catch(() => {});
  }

  /** Forgets a live prompt that failed to open, without charging the budget. */
  function abandon(prompt: ProposePrompt): void {
    forget(prompt);
    postTo(prompt, { type: "ended" });
  }

  function openPrompt(session: string): { tabId: number } | undefined {
    const prompt = open.get(session);
    return prompt === undefined ? undefined : { tabId: prompt.tabId };
  }

  function endSession(session: string): void {
    budget.delete(session);
    const prompt = open.get(session);
    if (prompt === undefined) return;
    open.delete(session);
    prompt.detached = true;
    detached.set(prompt.pageUrl, prompt);
  }

  function isBlankPage(url: string): boolean {
    return (
      url.startsWith(browser.runtime.getURL(PROPOSE_PAGE)) &&
      !prompts().some((prompt) => prompt.pageUrl === url)
    );
  }

  function connect(port: RuntimePort): void {
    if (port.name !== PORT_NAME) return;
    const prompt = prompts().find((candidate) =>
      portShowsPage(port, browser.runtime.id, PORT_NAME, candidate.pageUrl, candidate.tabId),
    );
    if (prompt === undefined) {
      post(port, { type: "ended" });
      try {
        port.disconnect();
      } catch {}
      return;
    }
    prompt.port = port;
    prompt.seen = true;
    prompt.committed = true;
    port.onMessage.addListener((message) => receive(prompt, port, message));
    port.onDisconnect.addListener(() => {
      if (prompt.port === port) prompt.port = undefined;
    });
  }

  function receive(prompt: ProposePrompt, port: Port, message: unknown): void {
    if (prompt.port !== port || !isLive(prompt)) return;
    const fields = fieldsOf(message);
    if (fields?.type === "ready") {
      void showProposal(prompt, port);
    } else if (fields?.type === "answer" && fields.answer === "save") {
      const given = fieldsOf(fields.fields);
      const shown = shownOf(fields.shown);
      // The page only ever echoes the name it was sent.
      if (given !== undefined && shown?.name === prompt.recipe.name) {
        void save(prompt, given, shown);
      }
    } else if (fields?.type === "answer" && fields.answer === "discard") {
      discard(prompt);
    }
  }

  async function showProposal(prompt: ProposePrompt, port: Port): Promise<void> {
    const recipes = await readRecipes(browser).catch(() => undefined);
    if (!isLive(prompt) || prompt.port !== port) return;
    if (recipes === undefined) {
      // Without the stored version, an update would show as a new recipe.
      post(port, { type: "problems", problems: [{ text: READ_FAILED }] });
      return;
    }
    const look = lookOf(prompt.recipe.name);
    const current =
      recipes.find(({ name }) => name === prompt.recipe.name) ??
      recipes.find(({ name }) => lookOf(name) === look);
    // A stored name that looks the same is the recipe this proposal updates: saving under the
    // proposed name would be refused as taken.
    if (current !== undefined) prompt.recipe = { ...prompt.recipe, name: current.name };
    post(
      port,
      current === undefined
        ? { type: "propose", fields: prompt.recipe }
        : { type: "propose", fields: prompt.recipe, current },
    );
  }

  async function save(
    prompt: ProposePrompt,
    given: Record<string, unknown>,
    shown: Shown,
  ): Promise<void> {
    if (prompt.answering) return;
    prompt.answering = true;
    const checked = checkRecipe({
      name: given.name,
      description: given.description,
      sites: given.sites,
      steps: given.steps,
    });
    if (!checked.ok) {
      prompt.answering = false;
      postTo(prompt, { type: "problems", problems: checked.problems });
      return;
    }
    let result: Awaited<ReturnType<typeof saveRecipe>>;
    try {
      // Never replaceShown: a renamed proposal is a new recipe, and the shown one stays.
      result = await saveRecipe(browser, checked.recipe, { shown });
    } catch {
      prompt.answering = false;
      if (isLive(prompt)) {
        postTo(prompt, {
          type: "problems",
          problems: [{ text: "Firefox could not save the recipe. Try again." }],
        });
      }
      return;
    }
    // Dropped while saving: what was stored stays, as it was the user's click.
    if (!isLive(prompt)) return;
    if (result.ok) {
      forget(prompt);
      postTo(prompt, { type: "done", answer: "saved" });
      return;
    }
    prompt.answering = false;
    if (result.reason === "exists") {
      const taken = result.current?.name ?? checked.recipe.name;
      postTo(prompt, {
        type: "problems",
        problems: [{ field: "name", text: `A recipe named ${taken} exists.` }],
      });
    } else if (result.reason === "changed") {
      postTo(
        prompt,
        result.current === undefined
          ? { type: "changed" }
          : { type: "changed", current: result.current },
      );
    } else {
      postTo(prompt, {
        type: "problems",
        problems: [
          {
            text: `Foxhand keeps at most ${MAX_RECIPES} recipes. Delete one in Foxhand's settings first.`,
          },
        ],
      });
    }
  }

  function discard(prompt: ProposePrompt): void {
    if (prompt.answering) return;
    forget(prompt);
    charge(prompt);
    postTo(prompt, { type: "done", answer: "discarded" });
  }

  /** Closes a page left without an answer; it counts once the user could have seen it. */
  function drop(prompt: ProposePrompt): void {
    if (!isLive(prompt)) return;
    forget(prompt);
    if (prompt.seen && !prompt.answering) charge(prompt);
    postTo(prompt, { type: "ended" });
  }

  function postTo(prompt: ProposePrompt, message: unknown): void {
    if (prompt.port !== undefined) post(prompt.port, message);
  }

  function prompts(): ProposePrompt[] {
    return [...open.values(), ...detached.values()];
  }

  function promptsIn(tabId: number): ProposePrompt[] {
    return prompts().filter((prompt) => prompt.tabId === tabId);
  }

  function isLive(prompt: ProposePrompt): boolean {
    return prompt.detached
      ? detached.get(prompt.pageUrl) === prompt
      : open.get(prompt.session) === prompt;
  }

  function forget(prompt: ProposePrompt): void {
    if (prompt.detached) detached.delete(prompt.pageUrl);
    else open.delete(prompt.session);
  }

  function charge(prompt: ProposePrompt): void {
    if (prompt.detached) return;
    budget.set(prompt.session, (budget.get(prompt.session) ?? 0) + 1);
  }
}

/** The token a page echoes: the name it was sent and the savedAt of the version it shows. */
function shownOf(value: unknown): Shown | undefined {
  if (!isRecord(value)) return undefined;
  const { name, savedAt } = value;
  if (typeof name !== "string" || (savedAt !== null && typeof savedAt !== "string")) {
    return undefined;
  }
  return { name, savedAt };
}

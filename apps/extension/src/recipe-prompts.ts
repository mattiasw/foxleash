import { MAX_RECIPES, type RecipeFields, type Result } from "@foxleash/protocol";
import type { BrowserApi, Port, RuntimePort, Tab, Timers } from "./browser-api.ts";
import { recipeNotFound, ToolError } from "./handlers.ts";
import { checkRecipe, findRecipe, lookOf, readRecipes, saveRecipe } from "./recipes.ts";
import type { SessionGroups } from "./session-groups.ts";
import { isRecord } from "./settings.ts";
import {
  APPROVAL_WAIT_MS,
  approvalPending,
  fieldsOf,
  portShowsPage,
  post,
  type SiteAccess,
  type SiteState,
} from "./site-access.ts";

/** The extension page that shows a proposed recipe, which only the user's click saves. */
export const PROPOSE_PAGE = "propose.html";
/** The extension page where only the user's click allows a saved recipe's sites for the session. */
export const RUN_PAGE = "run.html";

const PORT_NAME = "recipe";
// Recipe pages discarded, refused or closed without an answer that a session may have before
// Foxleash stops opening them.
const RECIPE_PROMPT_BUDGET = 3;
const READ_FAILED = "Firefox could not read the stored recipes. Reload the page to try again.";

export interface RecipePromptsDeps<Handle> {
  browser: Pick<BrowserApi, "runtime" | "tabs" | "windows" | "storage">;
  groups: Pick<SessionGroups, "createTab" | "ensureGroup" | "closeTab">;
  access: Pick<
    SiteAccess,
    "openPrompt" | "siteStates" | "allowForSession" | "refuseIfStoppedAsking"
  >;
  timers: Timers<Handle>;
}

export interface RecipePrompts {
  /** Opens the propose page in the session's group, selected; resolves with its tab once recorded. */
  propose(session: string, recipe: RecipeFields): Promise<Result<"recipe_propose">>;
  /**
   * Asks the user on the run page to allow the saved recipe's askable sites for the session, or
   * joins the session's run page for the same recipe; resolves at once, without a page, when no
   * site is askable.
   */
  run(session: string, name: string): Promise<Result<"recipe_run">>;
  /** The session's open recipe page, and what it asks. */
  openPrompt(session: string): { tabId: number; question: string } | undefined;
  /**
   * Detaches the session's propose page, which can still save, ends its run page, and forgets the
   * session's budget.
   */
  endSession(session: string): void;
  /** Whether a tab showing `url` may close with a session's group: a recipe page no live prompt shows. */
  isBlankPage(url: string): boolean;
}

type RecipePage<Handle> = ProposePrompt | RunPrompt<Handle>;

interface ProposePrompt extends PageState {
  kind: "propose";
  /** The proposal, normalized by checkRecipe. */
  recipe: RecipeFields;
}

interface RunPrompt<Handle> extends PageState {
  kind: "run";
  /** The stored recipe's name, description and sites, as found when the page opened. */
  name: string;
  description: string;
  sites: string[];
  /** Each site's state when the page opened, in the recipe's order; what the page shows. */
  states: { site: string; state: SiteState }[];
  /** The sites the page shows as allowed by its Allow button. */
  askable: string[];
  /** The start_recipe calls waiting for the answer, each with its own clock. */
  waiters: RunWaiter<Handle>[];
}

interface RunWaiter<Handle> {
  resolve(result: Result<"recipe_run">): void;
  reject(error: ToolError): void;
  timer: Handle;
}

interface PageState {
  session: string;
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
  /** Its session ended; it counts toward no budget. Only a propose page detaches. */
  detached: boolean;
}

interface Shown {
  name: string;
  savedAt: string | null;
}

export function createRecipePrompts<Handle>({
  browser,
  groups,
  access,
  timers,
}: RecipePromptsDeps<Handle>): RecipePrompts {
  // Maps throughout: session ids and recipe names may be "__proto__".
  const open = new Map<string, RecipePage<Handle>>();
  // By page URL: propose pages whose session ended.
  const detached = new Map<string, ProposePrompt>();
  // By session: pages discarded, refused or closed without an answer.
  const budget = new Map<string, number>();
  // By session: how often it ended, so an opening that awaited across an end records no page.
  const generations = new Map<string, number>();

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

  return { propose, run, openPrompt, endSession, isBlankPage };

  async function propose(session: string, recipe: RecipeFields): Promise<Result<"recipe_propose">> {
    const generation = generationOf(session);
    refuseOpening(session);
    const pageUrl = `${browser.runtime.getURL(PROPOSE_PAGE)}?id=${crypto.randomUUID()}`;
    // Unloaded, the page cannot connect before its prompt is recorded.
    const tab = await groups.createTab(session, { url: pageUrl, active: false, discarded: true });
    // No await from here until the prompt is recorded, so parallel requests see one prompt.
    try {
      refuseIfEnded(session, generation);
      refuseOpening(session);
    } catch (error) {
      await closeNewTab(tab.id);
      throw error;
    }
    const prompt: ProposePrompt = {
      kind: "propose",
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

  async function run(session: string, name: string): Promise<Result<"recipe_run">> {
    const generation = generationOf(session);
    const recipe = await findRecipe(browser, name);
    if (recipe === undefined) throw recipeNotFound(name);
    const states = await access.siteStates(session, recipe.sites);
    const askable = recipe.sites.filter((site) => states.get(site) === "askable");
    if (askable.length === 0) return resultOf(states, false);
    const joined = pageToJoin(session, recipe.name);
    if (joined !== undefined) return join(joined);
    const pageUrl = `${browser.runtime.getURL(RUN_PAGE)}?id=${crypto.randomUUID()}`;
    // Unloaded, the page cannot connect before its prompt is recorded.
    const tab = await groups.createTab(session, { url: pageUrl, active: false, discarded: true });
    // No await from here until the prompt is recorded or joined, so parallel requests of one
    // recipe end with one page.
    let again: RunPrompt<Handle> | undefined;
    try {
      refuseIfEnded(session, generation);
      again = pageToJoin(session, recipe.name);
    } catch (error) {
      await closeNewTab(tab.id);
      throw error;
    }
    if (again !== undefined) {
      const answer = join(again);
      // The page can be answered while the tab closes; the caller gets the rejection after.
      answer.catch(() => {});
      await closeNewTab(tab.id);
      return answer;
    }
    const prompt: RunPrompt<Handle> = {
      kind: "run",
      session,
      name: recipe.name,
      description: recipe.description,
      sites: recipe.sites,
      states: [...states].map(([site, state]) => ({ site, state })),
      askable,
      waiters: [],
      tabId: tab.id,
      pageUrl,
      committed: false,
      port: undefined,
      seen: false,
      answering: false,
      detached: false,
    };
    open.set(session, prompt);
    const answer = wait(prompt);
    let shown: Tab;
    try {
      await groups.ensureGroup(session, tab);
      // Answered, closed or ended meanwhile: the waiters, this one too, are settled.
      if (!isLive(prompt)) return answer;
      shown = await browser.tabs.update(tab.id, { url: pageUrl, active: true, loadReplace: true });
    } catch (error) {
      if (!isLive(prompt)) return answer;
      abandon(prompt);
      await closeNewTab(tab.id);
      throw error;
    }
    try {
      await browser.windows.update(shown.windowId, { drawAttention: true });
    } catch {}
    return answer;
  }

  function generationOf(session: string): number {
    return generations.get(session) ?? 0;
  }

  function refuseIfEnded(session: string, generation: number): void {
    if (generationOf(session) !== generation) {
      throw new ToolError(
        "recipe_prompt_closed",
        "The session ended before the recipe page opened.",
      );
    }
  }

  function refuseOpening(session: string): void {
    refuseBesideSitePrompt(session);
    const page = open.get(session);
    if (page !== undefined) throw recipePromptOpen(page.tabId);
    refuseOverBudget(session);
  }

  /** The session's run page for the recipe named `name`, or undefined when a new one may open. */
  function pageToJoin(session: string, name: string): RunPrompt<Handle> | undefined {
    refuseBesideSitePrompt(session);
    const page = open.get(session);
    if (page !== undefined) {
      if (page.kind === "run" && page.name === name) return page;
      throw recipePromptOpen(page.tabId);
    }
    refuseOverBudget(session);
    // It asks about sites, so it opens no more once the session's site prompts stopped asking.
    access.refuseIfStoppedAsking(session);
    return undefined;
  }

  function refuseBesideSitePrompt(session: string): void {
    const site = access.openPrompt(session);
    if (site !== undefined) throw approvalPending(site.tabId, `whether to allow ${site.site}`);
  }

  function refuseOverBudget(session: string): void {
    if ((budget.get(session) ?? 0) >= RECIPE_PROMPT_BUDGET) {
      throw new ToolError(
        "recipe_prompt_refused",
        "Foxleash shows no more recipe pages in this session after three that were discarded, refused or closed without an answer. Start a new session to be asked again.",
      );
    }
  }

  /** Waits on an open run page, drawing attention to its window. */
  async function join(prompt: RunPrompt<Handle>): Promise<Result<"recipe_run">> {
    const answer = wait(prompt);
    // Only attention: activating the tab would move the page's buttons under the cursor.
    try {
      const tab = await browser.tabs.get(prompt.tabId);
      await browser.windows.update(tab.windowId, { drawAttention: true });
    } catch {}
    return answer;
  }

  function wait(prompt: RunPrompt<Handle>): Promise<Result<"recipe_run">> {
    const { promise, resolve, reject } = Promise.withResolvers<Result<"recipe_run">>();
    // A caller that stopped listening must not leave an unhandled rejection behind.
    promise.catch(() => {});
    const waiter: RunWaiter<Handle> = {
      resolve,
      reject,
      timer: timers.setTimeout(() => timeOut(prompt, waiter), APPROVAL_WAIT_MS),
    };
    prompt.waiters.push(waiter);
    return promise;
  }

  function timeOut(prompt: RunPrompt<Handle>, waiter: RunWaiter<Handle>): void {
    const index = prompt.waiters.indexOf(waiter);
    if (index === -1) return;
    // The page never showed, perhaps because the user left the tab before it loaded.
    if (!prompt.seen) {
      forget(prompt);
      rejectWaiters(prompt, recipePageClosed(prompt));
    } else {
      prompt.waiters.splice(index, 1);
      waiter.reject(
        new ToolError(
          "approval_timeout",
          `Foxleash is still asking the user in tab ${prompt.tabId} to allow the recipe's sites. Tell the user to answer there, then call start_recipe with the same name again.`,
        ),
      );
    }
  }

  /** Takes every waiter off the prompt, stops its clock and settles it. */
  function settleWaiters(
    prompt: RunPrompt<Handle>,
    settle: (waiter: RunWaiter<Handle>) => void,
  ): void {
    for (const waiter of prompt.waiters.splice(0)) {
      timers.clearTimeout(waiter.timer);
      settle(waiter);
    }
  }

  function rejectWaiters(prompt: RunPrompt<Handle>, error: ToolError): void {
    settleWaiters(prompt, (waiter) => waiter.reject(error));
  }

  /** Never rejects; leaves a window's last tab. */
  async function closeNewTab(tabId: number): Promise<void> {
    const closed = await groups.closeTab(tabId, () => {}).catch(() => undefined);
    if (closed) await closed.removed.catch(() => {});
  }

  /** Forgets a live prompt that failed to open, without charging the budget. */
  function abandon(prompt: RecipePage<Handle>): void {
    forget(prompt);
    if (prompt.kind === "run") rejectWaiters(prompt, recipePageClosed(prompt));
    postTo(prompt, { type: "ended" });
  }

  function openPrompt(session: string): { tabId: number; question: string } | undefined {
    const prompt = open.get(session);
    if (prompt === undefined) return undefined;
    return {
      tabId: prompt.tabId,
      question:
        prompt.kind === "run" ? "whether to allow the recipe's sites" : "whether to save a recipe",
    };
  }

  function endSession(session: string): void {
    generations.set(session, generationOf(session) + 1);
    budget.delete(session);
    const prompt = open.get(session);
    if (prompt === undefined) return;
    open.delete(session);
    if (prompt.kind === "run") {
      rejectWaiters(prompt, recipePageClosed(prompt));
      postTo(prompt, { type: "ended" });
      return;
    }
    prompt.detached = true;
    detached.set(prompt.pageUrl, prompt);
  }

  function isBlankPage(url: string): boolean {
    return (
      (url.startsWith(browser.runtime.getURL(PROPOSE_PAGE)) ||
        url.startsWith(browser.runtime.getURL(RUN_PAGE))) &&
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

  function receive(prompt: RecipePage<Handle>, port: Port, message: unknown): void {
    if (prompt.port !== port || !isLive(prompt)) return;
    const fields = fieldsOf(message);
    if (prompt.kind === "run") {
      if (fields?.type === "ready") {
        post(port, {
          type: "run",
          name: prompt.name,
          description: prompt.description,
          sites: prompt.states,
        });
      } else if (fields?.type === "answer" && fields.answer === "allow") {
        void allow(prompt);
      } else if (fields?.type === "answer" && fields.answer === "no") {
        refuse(prompt);
      }
    } else if (fields?.type === "ready") {
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
            text: `Foxleash keeps at most ${MAX_RECIPES} recipes. Delete one in Foxleash's settings first.`,
          },
        ],
      });
    }
  }

  async function allow(prompt: RunPrompt<Handle>): Promise<void> {
    if (prompt.answering) return;
    prompt.answering = true;
    // The answer is in time even when reading the settings is slow.
    for (const waiter of prompt.waiters) timers.clearTimeout(waiter.timer);
    let before: Map<string, SiteState>;
    let granted: string[];
    try {
      // Every read comes before the grant, so a grant is never followed by a failure report.
      before = await access.siteStates(prompt.session, prompt.sites);
      granted = await access.allowForSession(prompt.session, prompt.askable, () => isLive(prompt));
    } catch {
      if (!isLive(prompt)) return;
      // Not charged: the user did answer.
      forget(prompt);
      rejectWaiters(
        prompt,
        new ToolError(
          "recipe_prompt_closed",
          "Firefox could not read Foxleash's settings, so the recipe's sites were not allowed. Call start_recipe with the same name again.",
        ),
      );
      postTo(prompt, { type: "ended" });
      return;
    }
    // Closed or ended meanwhile: its waiters are settled, and a grant made stays, as it was the
    // user's click.
    if (!isLive(prompt)) return;
    forget(prompt);
    const late = prompt.waiters.length === 0;
    const states = new Map(before);
    for (const site of granted) states.set(site, "allowed");
    const result = resultOf(states, true);
    settleWaiters(prompt, (waiter) => waiter.resolve(result));
    postTo(prompt, { type: "done", answer: "allow", late });
  }

  /** The sites are not refused in the session: each still asks on its own later. */
  function refuse(prompt: RunPrompt<Handle>): void {
    if (prompt.answering) return;
    forget(prompt);
    charge(prompt);
    const late = prompt.waiters.length === 0;
    rejectWaiters(
      prompt,
      new ToolError("recipe_refused", "The user did not allow the recipe's sites in this session."),
    );
    postTo(prompt, { type: "done", answer: "no", late });
  }

  function discard(prompt: ProposePrompt): void {
    if (prompt.answering) return;
    forget(prompt);
    charge(prompt);
    postTo(prompt, { type: "done", answer: "discarded" });
  }

  /** Closes a page left without an answer; it counts once the user could have seen it. */
  function drop(prompt: RecipePage<Handle>): void {
    if (!isLive(prompt)) return;
    forget(prompt);
    if (prompt.seen && !prompt.answering) charge(prompt);
    if (prompt.kind === "run") rejectWaiters(prompt, recipePageClosed(prompt));
    postTo(prompt, { type: "ended" });
  }

  function postTo(prompt: RecipePage<Handle>, message: unknown): void {
    if (prompt.port !== undefined) post(prompt.port, message);
  }

  function prompts(): RecipePage<Handle>[] {
    return [...open.values(), ...detached.values()];
  }

  function promptsIn(tabId: number): RecipePage<Handle>[] {
    return prompts().filter((prompt) => prompt.tabId === tabId);
  }

  function isLive(prompt: RecipePage<Handle>): boolean {
    return prompt.detached
      ? detached.get(prompt.pageUrl) === prompt
      : open.get(prompt.session) === prompt;
  }

  function forget(prompt: RecipePage<Handle>): void {
    if (prompt.detached) detached.delete(prompt.pageUrl);
    else open.delete(prompt.session);
  }

  function charge(prompt: RecipePage<Handle>): void {
    if (prompt.detached) return;
    budget.set(prompt.session, (budget.get(prompt.session) ?? 0) + 1);
  }
}

function recipePromptOpen(tabId: number): ToolError {
  return new ToolError(
    "recipe_prompt_open",
    `Foxleash is still showing the user a recipe page in tab ${tabId}. Try again after the user has answered there.`,
  );
}

function recipePageClosed(prompt: { tabId: number }): ToolError {
  return new ToolError(
    "recipe_prompt_closed",
    `The recipe page in tab ${prompt.tabId} closed without an answer.`,
  );
}

/** start_recipe's result: the sites of each state but askable, in the recipe's order. */
function resultOf(states: Map<string, SiteState>, asked: boolean): Result<"recipe_run"> {
  const result: Result<"recipe_run"> = { asked, allowed: [], blocked: [], refused: [] };
  for (const [site, state] of states) {
    if (state !== "askable") result[state].push(site);
  }
  return result;
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

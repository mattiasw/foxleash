/** The title approve.html and propose.html carry until the page shows its question. */
export const PROMPT_PAGE_TITLE = "Foxleash";

/** The site question's title and heading (approve.html). */
export function siteQuestionTitle(site: string): string {
  return `Allow Foxleash on ${site}?`;
}

/** The propose page's title and heading for a recipe the user does not have. */
export const SAVE_RECIPE_TITLE = "Save this recipe?";

/** The propose page's title and heading for a proposal that updates the stored recipe `name`. */
export function updateRecipeTitle(name: string): string {
  return `Update the recipe ${name}?`;
}

/** A recipe's name or description as Foxleash stores and shows it. */
export function recipeLine(text: string): string {
  return text
    .normalize("NFC")
    .replace(/\p{Zs}+/gu, " ")
    .trim();
}

/** run.html's title and heading, which the page carries as static text. */
export const RUN_PAGE_TITLE = "Allow Foxleash on these sites for this session?";

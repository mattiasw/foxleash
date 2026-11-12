# 0035: Recipes are saved and run only by a user click

**Status:** Accepted, 2026-10-30.

## Context

A recipe is text the user keeps in Foxleash: a name, a one-line description, the sites it uses
(sites as [0007](0007-per-site-approval-and-tab-redaction.md) defines them) and steps, which an
agent follows with the normal tools in a later session. Element refs belong to one document
([0009](0009-content-scripts-injected-per-tab.md)), so a recipe cannot be a recorded macro that
replays clicks; it is instructions.

Instructions that persist are a target. An agent fooled by a page it read could write a recipe
whose steps steer every later session that follows it: a prompt injection that outlives the
page and the session, known as memory poisoning. [0002](0002-safeguards-live-in-foxleash-not-the-mcp-client.md)
already puts every safeguard in Foxleash and lets only a user click grant anything, because the
MCP client's prompts can be switched off. Recipes need the same rule for writing text that a
later session treats as the user's own, and for the sites a recipe lists.

Text the user reads on a page can differ from the text a model receives: invisible characters
(soft hyphens, zero width spaces, bidi controls, the tag characters U+E0000 to U+E007F, which
map one to one onto ASCII) carry instructions that the page does not draw. Measured on the
character rule first proposed: one emoji followed by 50 variation selectors from U+E0100 to
U+E012F, a published way to hide bytes, passed it, as did runs of zero width joiners.

## Decision

- A recipe is text: `RecipeFields` and `Recipe` in `packages/protocol/src/methods.ts`, with the
  limits `MAX_RECIPE_NAME` (100), `MAX_RECIPE_DESCRIPTION` (200), `MAX_RECIPE_SITES` (20),
  `MAX_RECIPE_STEPS` (20,000) and `MAX_RECIPES` (100), lengths in code points.
- Each recipe is one `storage.local` key, `recipe:<name>`, holding exactly name, description,
  sites, steps and `savedAt`. `apps/extension/src/recipes.ts` reads and writes them;
  `readSettings` skips them, so a recipe never grants a site; a change of recipe keys alone
  rechecks no live document, since it cannot narrow access.
- A recipe is written only by a trusted click on an extension page: the settings page's Save
  and Undo, and the page on which the user saves a recipe an agent proposed. Nothing arriving
  over MCP or native messaging writes one. The propose tool returns at once and never learns
  whether the user saved, edited or discarded the proposal.
- Running a recipe grants its sites for that session only, by one click on an extension page.
  There is no "always" option for a recipe's sites; the blocklist and the session's earlier
  refusals still win.
- An agent gets a recipe as the user's own text, outside the frame that marks page content as
  untrusted, with a reminder that what it reads on pages while following it stays untrusted.
- `checkRecipe` refuses, in every field, controls, format characters (`\p{Cf}`), line and
  paragraph separators, bidi controls, default-ignorable code points, and three characters that
  fonts draw blank: U+2800 (braille pattern blank), U+16FE4 (Khitan small script filler) and
  U+1D159 (musical symbol null notehead); tabs and line feeds only in the steps. Joiners and
  variation selectors stay only where text needs them: U+FE0E and U+FE0F directly after an
  emoji, the other selectors directly after an ideograph, and U+200C and U+200D between
  letters, marks or emoji (Unicode counts the digits, `#` and `*` as emoji). Each problem names
  the character, its code point and where it is.
- Names and descriptions fold every run of spaces to one space; the steps lose invisible
  spacing (other spaces than U+0020 and the full-width U+3000 become U+0020, and trailing tabs
  and spaces go). A new name that differs from a stored one only by joiners or selectors is
  taken. A site entry with a tab, a line break, a user name before the host, or a wildcard in
  the host is refused, and a site's host is at most 253 characters, the most a DNS name has.
- A save checks that the stored recipe's `savedAt` is still the one the editor opened, instead
  of a lock: a recipe changed or deleted meanwhile is refused with a message. The save itself
  runs `checkRecipe` and stores its result, so no caller can write a recipe the rules refuse.
- No `data_collection_permissions` category is added: recipes are the user's own notes, which
  the user writes or approves for the user's own local program; the extension collects nothing
  on its own, and the listing's data section describes them.

## Alternatives rejected

- **A tool that saves a recipe directly.** The agent, or a page that fooled it, would approve
  its own instructions for every later session. This is the decision's main point.
- **Recorded macros that replay clicks.** Refs belong to one document, and a page that changed
  would turn a replay into clicks on the wrong elements.
- **An "always" option when running a recipe.** One click on a recipe an agent proposed would
  widen the stored grants for every later session.
- **Recipes as files the MCP server keeps.** No click in the browser can guard a file write,
  and a client with a shell could edit them anyway.
- **Recipes returned as untrusted content.** The agent would be told not to follow what the user
  asked it to follow.
- **One storage key for all recipes.** Every save would rewrite every recipe, and two pages
  saving at once would lose one of the writes.

## Consequences

- A user who saves a proposed recipe without reading it has approved whatever the agent, or a
  page that fooled it, wrote. The page that proposes it shows the whole text, and the listing
  says to read it first. This is the same trust decision as approving a site.
- The character rule still lets some bytes through, which nothing maps to letters: a selector
  after each ideograph (240 choices, about a byte per ideograph, so a long text in Chinese or
  Japanese can carry thousands of hidden bytes), U+FE0E or U+FE0F after an emoji or a digit,
  one joiner in a gap between letters or digits, tabs against spaces and runs of spaces in the
  steps. Following such bytes needs a decoder spelled out in the visible text. English
  subdivision flags, which are written with tag characters, are refused with them. Names that
  look alike through letters from other scripts are not detected.
- The `savedAt` check reads and then writes, so a write elsewhere in the milliseconds between
  the two is overwritten; the last write wins, as for site grants. For the same reason, two
  pages saving new recipes at the same moment can store one more than `MAX_RECIPES`.
- `readSettings` reads every key on each call, and most tool calls call it through
  `SiteAccess.view`, so at the limits each read loads up to 2,000,000 characters of recipes.
  The cost was not measured and is accepted; if it shows, revisit the one-key-per-recipe layout
  or keep recipes in another storage area.
- A client with a shell can edit the Firefox profile, recipes included, as 0002 notes for every
  setting.

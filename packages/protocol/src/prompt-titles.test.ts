import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  PROMPT_PAGE_TITLE,
  RUN_PAGE_TITLE,
  recipeLine,
  SAVE_RECIPE_TITLE,
  siteQuestionTitle,
  updateRecipeTitle,
} from "./index.ts";

describe("prompt titles", () => {
  it("names the site a site question asks about", () => {
    assert.equal(siteQuestionTitle("https://a.example"), "Allow Foxleash on https://a.example?");
  });

  it("names the stored recipe an update asks about", () => {
    assert.equal(updateRecipeTitle("Trip"), "Update the recipe Trip?");
  });

  it("writes a recipe line as it is stored: composed, single spaces, trimmed", () => {
    assert.equal(recipeLine(" Cafe\u0301 \u00a0\u2003 trip  "), "Caf\u00e9 trip");
  });

  it("keeps the static titles the pages carry", () => {
    assert.equal(PROMPT_PAGE_TITLE, "Foxleash");
    assert.equal(SAVE_RECIPE_TITLE, "Save this recipe?");
    assert.equal(RUN_PAGE_TITLE, "Allow Foxleash on these sites for this session?");
  });
});

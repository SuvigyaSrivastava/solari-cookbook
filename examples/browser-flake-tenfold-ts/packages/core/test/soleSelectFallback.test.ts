import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser, type Page } from "playwright-core";
import { resolveTarget } from "../src/execute/resolveTarget.js";
import type { Step } from "../src/types.js";

// Confirmed live against saucedemo.com's real sort control: 10/10 real runs
// failed with ELEMENT_NOT_FOUND ("sort dropdown") — even with the LLM
// resolver enabled — because a native <select>'s accessible name is ALWAYS
// its currently-selected option's text, never a description of the
// element's own purpose. compilePlan reasonably compiled "Select 'Price
// (low to high)' from the sort dropdown" to target: "sort dropdown" (the
// single concrete element being acted on, per its own system prompt), but
// no candidate (getByLabel/getByRole-by-name) and no keyword scan can ever
// match a target whose words ("sort", "dropdown") don't and structurally
// can't appear anywhere in the element's own accessible name or its
// options' text. This is a real, generalizable resolver gap, not an
// MDN/Amazon-shaped one-off — the exact HTML shape below mirrors
// saucedemo's real markup: a bare <select> with no <label>, no aria-label,
// and options named only by sort-order text.
const SOLE_SELECT_HTML = `<!DOCTYPE html><html><body>
  <div class="product_sort_container">
    <select data-test="product-sort-container" class="product_sort_container">
      <option value="az" selected>Name (A to Z)</option>
      <option value="za">Name (Z to A)</option>
      <option value="lohi">Price (low to high)</option>
      <option value="hilo">Price (high to low)</option>
    </select>
  </div>
</body></html>`;

let browser: Browser;
let page: Page;

beforeAll(async () => {
  browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH ?? "/opt/pw-browsers/chromium" });
  page = await browser.newPage();
});

afterAll(async () => {
  await browser.close();
});

describe("resolveTarget — the sole combobox on the page, when its name can't possibly match the target phrase", () => {
  it('resolves a "select" step targeting "sort dropdown" even though no accessible name anywhere says "sort" or "dropdown"', async () => {
    await page.setContent(SOLE_SELECT_HTML);

    const step: Step = {
      index: 0,
      text: 'Select "Price (low to high)" from the sort dropdown',
      intent: "select",
      target: "sort dropdown",
      value: "Price (low to high)",
      expect: 'the option "Price (low to high)" is selected',
    };

    const result = await resolveTarget(page, step);
    expect(result.spec.kind).toBe("role");
    // Must actually be selectable — the whole point of the bug.
    await expect(result.locator.selectOption({ label: "Price (low to high)" })).resolves.toBeTruthy();
    await expect(page.locator("select").inputValue()).resolves.toBe("lohi");
  });

  it("persists the element's OWN current selection as the spec name, not the mismatched target phrase, and not every option concatenated", async () => {
    await page.setContent(SOLE_SELECT_HTML);

    const step: Step = {
      index: 0,
      text: 'Select "Price (low to high)" from the sort dropdown',
      intent: "select",
      target: "sort dropdown",
      value: "Price (low to high)",
      expect: 'the option "Price (low to high)" is selected',
    };

    const result = await resolveTarget(page, step);
    if (result.spec.kind !== "role") throw new Error("expected a role spec");
    // Must be the real selected-option text ("Name (A to Z)") — NOT the
    // mismatched needle ("sort dropdown"), and NOT a raw innerText() dump of
    // every option concatenated (confirmed live this is what a naive
    // innerText()-based accessible-name helper would wrongly produce for a
    // bare <select>, unlike buttons/links where innerText IS the label).
    expect(result.spec.name).toBe("Name (A to Z)");
    expect(result.spec.name).not.toContain("sort");
    expect(result.spec.name).not.toContain("Price (low to high)\nPrice");
  });

  it("does NOT guess when there are multiple selects on the page — falls through instead of picking wrong", async () => {
    await page.setContent(`<!DOCTYPE html><html><body>
      <select data-test="product-sort-container">
        <option selected>Name (A to Z)</option>
        <option>Price (low to high)</option>
      </select>
      <select data-test="page-size">
        <option selected>25 per page</option>
        <option>50 per page</option>
      </select>
    </body></html>`);

    const step: Step = {
      index: 0,
      text: 'Select "Price (low to high)" from the sort dropdown',
      intent: "select",
      target: "sort dropdown",
      value: "Price (low to high)",
      expect: 'the option "Price (low to high)" is selected',
    };

    // Neither candidate/keyword-scan/sole-element path can resolve this
    // (two comboboxes, neither named "sort dropdown", no GROQ_API_KEY in
    // this test env so the LLM fallback is a no-op) — must fail loudly
    // rather than silently picking one of the two and getting it wrong.
    await expect(resolveTarget(page, step)).rejects.toThrow();
  });
});

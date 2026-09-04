import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser, type Page } from "playwright-core";
import { verifyExpect } from "../src/execute/verifyExpect.js";

// THE actual root cause of the MDN "array methods" ASSERTION_FAILED, found
// after two other real (but ultimately unrelated) bugs were already fixed
// this session — the "press" intent not existing, and the LLM compiler
// silently misclassifying it. Even with both of those fixed, the run kept
// failing identically, and the web UI's own report table renders
// `firstFailureStep + 1` (1-indexed) — so the reported "step 3" is actually
// internal index 2, the "type" step, not "press" (index 3) or "assert"
// (index 4) as it looks at a glance.
//
// compilePlan's system prompt convention for a non-"assert" step's expect
// is to describe only the mechanical action succeeding — for a "type" step,
// that means quoting the typed value right back: `the value "array methods"
// is accepted by the search input`. verifyExpect's quoted-phrase check has
// no way to tell that apart from a genuine page-content claim, so it went
// looking for "array methods" as visible text on the page immediately after
// `.fill()` — before the dropdown had (or even could have) rendered it, since
// a typed value lives in the input's `.value` property and never appears in
// innerText() at all. The action had already succeeded (no exception), but
// verifyExpect failed it anyway, one full step before the "press Enter" step
// (and its keypress) was ever reached.
let browser: Browser;
let page: Page;

beforeAll(async () => {
  browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH ?? "/opt/pw-browsers/chromium" });
  page = await browser.newPage();
});

afterAll(async () => {
  await browser.close();
});

describe("verifyExpect — a non-assert step's expect echoing back its own value is not a page-content claim", () => {
  it('passes a "type" step whose expect quotes the just-typed value, even when the page does not yet show it anywhere', async () => {
    // Reproduces the exact race window: search modal barely rendered, no
    // dropdown/suggestion text yet, nothing resembling "array methods"
    // anywhere in the DOM — the real live failure state.
    await page.setContent(`<!DOCTYPE html><html><body>
      <div class="search-modal"><input type="text" /></div>
    </body></html>`);

    const result = await verifyExpect(
      page,
      'the value "array methods" is accepted by the search input',
      "type",
      "array methods",
    );
    expect(result.passed).toBe(true);
  });

  it('passes a "select" step whose expect quotes the just-selected option, even when that text is not rendered', async () => {
    await page.setContent(`<!DOCTYPE html><html><body><p>Loading...</p></body></html>`);

    const result = await verifyExpect(page, 'the option "Blue Hoodie" is selected', "select", "Blue Hoodie");
    expect(result.passed).toBe(true);
  });

  it("is case/whitespace-insensitive when matching the echoed value (compilePlan may re-quote with different casing)", async () => {
    await page.setContent(`<!DOCTYPE html><html><body><p></p></body></html>`);

    const result = await verifyExpect(
      page,
      'the value "Array Methods" is accepted by the search input',
      "type",
      "  array methods  ",
    );
    expect(result.passed).toBe(true);
  });

  it('still fails a "type" step whose quoted expect is a genuine content claim, not an echo of its own value', async () => {
    // The quoted phrase differs from what was typed — e.g. compilePlan wrote
    // a real assertion about page content into a type step's expect. This
    // must NOT be treated as a self-referential echo, and the existing
    // decisive quoted-phrase check must still run and correctly fail it.
    await page.setContent(`<!DOCTYPE html><html><body><p>No results found.</p></body></html>`);

    const result = await verifyExpect(
      page,
      'the search results contain "totally different phrase"',
      "type",
      "array methods",
    );
    expect(result.passed).toBe(false);
  });

  it('does NOT skip the quoted-phrase check for "assert" steps, even if the quoted text happens to equal stepValue', async () => {
    // Assert steps exist specifically to check page content — this guard is
    // intent-gated to non-assert steps only, matching the LLM-skip's own
    // gating (step 5 in the doc comment) for the same underlying reason.
    await page.setContent(`<!DOCTYPE html><html><body><p>No results found.</p></body></html>`);

    const result = await verifyExpect(page, 'the page shows "array methods"', "assert", "array methods");
    expect(result.passed).toBe(false);
  });

  it("still requires the real decisive check when no stepValue is passed at all (back-compat for existing callers)", async () => {
    await page.setContent(`<!DOCTYPE html><html><body><p>No results found.</p></body></html>`);

    const result = await verifyExpect(page, 'the value "array methods" is accepted by the search input', "type");
    expect(result.passed).toBe(false);
  });
});

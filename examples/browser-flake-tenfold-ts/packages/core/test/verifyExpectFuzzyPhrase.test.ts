import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser, type Page } from "playwright-core";
import { verifyExpect } from "../src/execute/verifyExpect.js";

// The actual live bug: a real, successful MDN search for "array methods"
// failed verification on every one of 10 runs. compilePlan reasonably wrote
// the "type" step's expect as `the search results contain "array methods"`
// (quoting the user's own typed value back) — but MDN's real results page
// shows content ABOUT array methods (real headings reference specific
// methods, not the literal three-word phrase) without ever containing that
// exact phrase verbatim. The old strict substring check made this a false
// ASSERTION_FAILED on a search that was, in substance, working correctly.
let browser: Browser;
let page: Page;

beforeAll(async () => {
  browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH ?? "/opt/pw-browsers/chromium" });
  page = await browser.newPage();
});

afterAll(async () => {
  await browser.close();
});

describe("verifyExpect — quoted phrase not found verbatim, but its words are all present", () => {
  it("passes when every significant word of the quoted phrase appears on the page, even out of order/non-contiguous", async () => {
    // Reconstructs MDN's real results shape: no literal "array methods"
    // anywhere, but genuinely relevant results about array methods.
    await page.setContent(`<!DOCTYPE html><html><body>
      <main>
        <h2>Search results for "array"</h2>
        <ul>
          <li><a href="#">Array.prototype.map()</a> - JavaScript | MDN</li>
          <li><a href="#">Array.prototype.filter()</a> - methods for arrays</li>
        </ul>
      </main>
    </body></html>`);

    const result = await verifyExpect(page, 'the search results contain "array methods"', "type");
    expect(result.passed).toBe(true);
    expect(result.reason).toContain("array");
    expect(result.reason).toContain("methods");
  });

  it("still fails when the words genuinely are not all present (no false positive)", async () => {
    await page.setContent(`<!DOCTYPE html><html><body>
      <main><p>No results found for your search.</p></main>
    </body></html>`);

    const result = await verifyExpect(page, 'the search results contain "array methods"', "type");
    expect(result.passed).toBe(false);
  });

  it("still requires the FULL exact phrase when it genuinely is present (no behavior change for the common case)", async () => {
    await page.setContent(`<!DOCTYPE html><html><body>
      <main><p>Showing results for array methods</p></main>
    </body></html>`);

    const result = await verifyExpect(page, 'the page shows "array methods"', "assert");
    expect(result.passed).toBe(true);
    expect(result.reason).toBe('Page contains "array methods"');
  });

  it("does not treat a coincidental one-word overlap as a pass for a multi-word expectation missing its other words", async () => {
    // Only "SAVE10" appears; "applied" does not — this must still fail,
    // since it's a real, substantive gap, not a phrasing mismatch.
    await page.setContent(`<!DOCTYPE html><html><body>
      <main><p>Enter your coupon code: SAVE10</p></main>
    </body></html>`);

    const result = await verifyExpect(page, 'the page shows "SAVE10 applied"', "assert");
    expect(result.passed).toBe(false);
  });
});

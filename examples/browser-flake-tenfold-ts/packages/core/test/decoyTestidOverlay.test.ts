import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser, type Page } from "playwright-core";
import { resolveTarget } from "../src/execute/resolveTarget.js";
import type { Step } from "../src/types.js";

// The actual live bug: github.com's real search dialog ships a purely
// decorative `<div aria-hidden="true" data-testid="quick-search-input-overlay">`
// layered over the real input for visual/animation purposes. Tenfold's
// generic `[data-testid*="search-input"]` fallback (slugify("search input")
// -> "search-input", which IS a substring of "quick-search-input-overlay")
// matched this inert div — and did so on every single run, because that
// fallback used to be tried in the very first candidate pass, before the
// role-based keyword scan and search-reveal logic ever got a chance to find
// the real, fillable <input role="combobox"> a few DOM nodes away. Confirmed
// live via a decoded Solari replay reconstructing this exact markup.
const DECOY_OVERLAY_HTML = `<!DOCTYPE html><html><body>
  <button type="button" aria-label="Search or jump to, type / to search" id="trigger">
    <svg></svg>
  </button>
  <div id="dialog" style="display:none">
    <div aria-hidden="true" data-testid="quick-search-input-overlay" class="inputOverlay"></div>
    <input type="text" role="combobox" placeholder="Search or jump to..." aria-label="Search or jump to" />
  </div>
  <script>
    document.getElementById('trigger').addEventListener('click', () => {
      document.getElementById('dialog').style.display = 'block';
    });
  </script>
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

describe("resolveTarget — generic testid fallback vs. a decorative decoy element", () => {
  it("resolves the real fillable input, not the aria-hidden overlay div that also matches the testid substring", async () => {
    await page.setContent(DECOY_OVERLAY_HTML);
    await page.click("#trigger"); // reveal the dialog, same as step 1 of the real plan

    const step: Step = {
      index: 1,
      text: 'Type "playwright" into the search input',
      intent: "type",
      target: "search input",
      value: "playwright",
      expect: 'the search input contains "playwright"',
    };

    const result = await resolveTarget(page, step);
    // The decoy resolves to `kind: "css"` with the testid selector; the real
    // element should win via a role-based spec instead.
    expect(result.spec.kind).not.toBe("css");
    await expect(result.locator.getAttribute("aria-hidden")).resolves.not.toBe("true");
    // And it must actually be fillable — the whole point of the bug.
    await expect(result.locator.fill("playwright")).resolves.toBeUndefined();
  });
});

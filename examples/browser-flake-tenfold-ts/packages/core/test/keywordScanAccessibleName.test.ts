import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser, type Page } from "playwright-core";
import { resolveTarget } from "../src/execute/resolveTarget.js";
import type { Step } from "../src/types.js";

// This is the actual bug from a live GitHub run, reproduced exactly: the
// real search trigger on github.com's logged-out homepage (confirmed via a
// decoded Solari session replay) is an icon-only button with NO visible text
// content — its only name comes from aria-label. keywordScan used to read
// only `el.innerText()` to approximate the accessible name, which is "" for
// a button like this, so it silently skipped the one element that should
// have matched and fell through to the (slow, and in the live case,
// timed-out) LLM resolver. `resolveTarget` is exercised directly (not just
// the internal keywordScan helper, which isn't exported) so this test fails
// the same way the real run did if the fix ever regresses.
const GITHUB_SEARCH_BUTTON_HTML = `<!DOCTYPE html><html><body>
  <nav>
    <button type="button" aria-label="Search or jump to, type / to search" class="HeaderSearch-module__trigger">
      <svg aria-hidden="true"><path d="M0 0"/></svg>
    </button>
  </nav>
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

describe("resolveTarget — icon-only buttons named only via aria-label", () => {
  it("resolves a click target via keyword-scan against aria-label, not just visible text", async () => {
    await page.setContent(GITHUB_SEARCH_BUTTON_HTML);
    const step: Step = {
      index: 0,
      text: "Click the search button",
      intent: "click",
      target: "search button",
      expect: "search button is clickable",
    };

    const result = await resolveTarget(page, step);
    expect(result.spec).toMatchObject({ kind: "role", role: "button" });
    expect(await result.locator.count()).toBe(1);
  });

  it("still resolves normally for a button with real visible text (no regression)", async () => {
    await page.setContent(
      `<!DOCTYPE html><html><body><button type="button">Search</button></body></html>`,
    );
    const step: Step = {
      index: 0,
      text: "Click the search button",
      intent: "click",
      target: "search button",
      expect: "search button is clickable",
    };

    const result = await resolveTarget(page, step);
    expect(await result.locator.count()).toBe(1);
  });
});

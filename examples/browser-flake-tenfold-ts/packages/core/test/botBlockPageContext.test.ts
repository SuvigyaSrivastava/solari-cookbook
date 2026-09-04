import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser, type Page } from "playwright-core";
import { resolveTarget, ElementNotFoundError } from "../src/execute/resolveTarget.js";
import type { Step } from "../src/types.js";

// Confirmed live against Amazon with no proxy set: every run failed with a
// bare "No element found matching \"search input\"" — technically accurate,
// but useless for understanding WHY, because Amazon's block page renders a
// plain HTTP 200 (so executeRun's own navigate-step 401/403 bot-block
// message never fires — that check only looks at the HTTP status) with
// wording that doesn't match detectCaptcha's narrow "captcha"/"verify you
// are human" scan either. A user reading a report full of ELEMENT_NOT_FOUND
// has no way to tell "the site is blocking me" from "my test plan named the
// wrong element" — this is a real product-quality gap distinct from (and
// found while investigating) the ELEMENT_NOT_FOUND itself.
let browser: Browser;
let page: Page;

beforeAll(async () => {
  browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH ?? "/opt/pw-browsers/chromium" });
  page = await browser.newPage();
});

afterAll(async () => {
  await browser.close();
});

describe("resolveTarget — ElementNotFoundError names an anti-bot block page when one is showing", () => {
  it("enriches the error with bot-block context when the page shows known block-page wording", async () => {
    await page.setContent(`<!DOCTYPE html><html><body>
      <h4>Sorry, we just need to make sure you're not a robot.</h4>
      <p>To discuss automated access to Amazon data please contact our team.</p>
      <p>Enter the characters you see below</p>
    </body></html>`);

    const step: Step = {
      index: 1,
      text: 'Type "wireless mouse" into the search input',
      intent: "type",
      target: "search input",
      value: "wireless mouse",
      expect: "the search term is entered",
    };

    await expect(resolveTarget(page, step)).rejects.toThrow(ElementNotFoundError);
    try {
      await resolveTarget(page, step);
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(ElementNotFoundError);
      const message = (err as Error).message.toLowerCase();
      expect(message).toContain("search input");
      expect(message).toContain("anti-automation");
      expect(message).toContain("proxy");
    }
  });

  it("still throws the plain, unenriched error on an ordinary page with genuinely no matching element", async () => {
    await page.setContent(`<!DOCTYPE html><html><body>
      <main><h1>Welcome to our site</h1><p>Nothing resembling a search box here.</p></main>
    </body></html>`);

    const step: Step = {
      index: 1,
      text: 'Type "wireless mouse" into the search input',
      intent: "type",
      target: "search input",
      value: "wireless mouse",
      expect: "the search term is entered",
    };

    try {
      await resolveTarget(page, step);
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(ElementNotFoundError);
      const message = (err as Error).message.toLowerCase();
      expect(message).toContain("search input");
      expect(message).not.toContain("anti-automation");
    }
  });
});

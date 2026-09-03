import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { chromium, type Browser, type Page } from "playwright-core";
import type { Step } from "../src/types.js";

// chatJson is mocked to hang forever — this is the exact live failure mode:
// a stuck/slow Groq call used to be able to eat the ENTIRE remaining step
// budget (chatJson has no timeout of its own), and once the outer per-step
// timeout fired and closed the browser out from under it, every subsequent
// Playwright call in this function's own error-diagnostic paths threw
// "Target page, context or browser has been closed" — a confusing secondary
// error that buried the real cause. resolveTarget must now give up on the
// LLM call on its own, well within a single step's budget, and fall through
// to its normal ElementNotFoundError instead.
vi.mock("../src/llm/groq.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/llm/groq.js")>();
  return {
    ...actual,
    getGroqClient: () => ({}) as any, // truthy — resolveTarget only checks this is non-null
    chatJson: () => new Promise(() => {}), // never resolves
  };
});

let browser: Browser;
let page: Page;
const ORIGINAL_TIMEOUT_MS = process.env.RESOLVE_LLM_TIMEOUT_MS;

beforeAll(async () => {
  browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH ?? "/opt/pw-browsers/chromium" });
  page = await browser.newPage();
});

afterAll(async () => {
  await browser.close();
});

beforeEach(() => {
  process.env.RESOLVE_LLM_TIMEOUT_MS = "200"; // keep the test fast
});

afterEach(() => {
  if (ORIGINAL_TIMEOUT_MS === undefined) delete process.env.RESOLVE_LLM_TIMEOUT_MS;
  else process.env.RESOLVE_LLM_TIMEOUT_MS = ORIGINAL_TIMEOUT_MS;
});

describe("resolveTarget — bounded LLM resolver timeout", () => {
  it("gives up on a hung LLM call and throws the normal ElementNotFoundError, not a page-closed crash", async () => {
    const { resolveTarget, ElementNotFoundError } = await import("../src/execute/resolveTarget.js");
    // No matching element on the page at all, and no deterministic
    // heuristic (role/text/testid/keyword-scan) can find one — this is
    // exactly what forces the fall-through into the (mocked, hanging) LLM
    // path in the first place.
    await page.setContent(`<!DOCTYPE html><html><body><div>nothing clickable here</div></body></html>`);
    const step: Step = {
      index: 0,
      text: "Click the totally absent button",
      intent: "click",
      target: "totally absent button",
      expect: "it is clickable",
    };

    const start = Date.now();
    await expect(resolveTarget(page, step)).rejects.toThrow(ElementNotFoundError);
    const elapsed = Date.now() - start;
    // Bounded by RESOLVE_LLM_TIMEOUT_MS (200ms here), not by the mock's
    // infinite hang — this is the assertion that actually matters.
    expect(elapsed).toBeLessThan(2000);
  });
});

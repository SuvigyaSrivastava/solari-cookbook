import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright-core";
import { executeRun } from "../src/execute/executeRun.js";
import type { SolariClient, SolariSession } from "../src/solari/types.js";
import type { TestPlan } from "../src/types.js";

// End-to-end reproduction of the real, live MDN bug: a plan whose steps are
// (implicit navigate) -> click search trigger -> type "array methods" ->
// press Enter -> assert the results page shows content about array methods.
// A real replay of this exact flow showed the input received the typed text
// correctly, but the recording ended right there — no navigation, no
// keyboard event, nothing — because "Press Enter" used to compile as intent
// "click" with target "Enter" (there is no such element), so the key was
// never actually sent. This fixture reconstructs that shape locally (a
// search box that only submits on a real Enter keypress, exactly like a
// real <input> inside a <form> with no visible submit button) so the test
// fails against the pre-fix "press -> click" behavior and passes once
// "press" is its own intent that calls page.keyboard.press.
const SEARCH_PAGE = `<!DOCTYPE html><html><body>
  <button id="trigger" onclick="document.getElementById('box').style.display='block'; document.getElementById('box').focus();">Search</button>
  <input id="box" type="text" style="display:none" />
  <script>
    document.getElementById('box').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        const q = encodeURIComponent(e.target.value);
        window.location.href = '/results?q=' + q;
      }
    });
  </script>
</body></html>`;

function resultsPageFor(query: string): string {
  return `<!DOCTYPE html><html><body>
    <main>
      <h2>Search results for "${query}"</h2>
      <ul>
        <li><a href="#">Array.prototype.map()</a> - JavaScript | MDN</li>
        <li><a href="#">Array.prototype.filter()</a> - methods for arrays</li>
      </ul>
    </main>
  </body></html>`;
}

let browser: Browser;
let context: BrowserContext;
let page: Page;
const BASE_URL = "https://tenfold-test.local";

beforeAll(async () => {
  browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH ?? "/opt/pw-browsers/chromium" });
});

afterAll(async () => {
  await browser.close();
});

afterEach(async () => {
  await context?.close();
});

class FakeSession implements SolariSession {
  page: Page;
  sessionId: string | null = null;
  mode: "live" | "mock" = "mock";
  recordingEnabled = false;
  constructor(p: Page) {
    this.page = p;
  }
  async release() {
    return { replayUrl: null, replayStatus: "disabled" as const };
  }
}

async function makeMockClient(): Promise<SolariClient> {
  context = await browser.newContext();
  await context.route(`${BASE_URL}/**`, async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === "/results") {
      const q = url.searchParams.get("q") ?? "";
      await route.fulfill({ contentType: "text/html", body: resultsPageFor(decodeURIComponent(q)) });
      return;
    }
    await route.fulfill({ contentType: "text/html", body: SEARCH_PAGE });
  });
  page = await context.newPage();
  return {
    mode: "mock",
    async launch() {
      return new FakeSession(page);
    },
  };
}

function buildPlan(pressIntent: "press" | "click"): TestPlan {
  return {
    targetUrl: `${BASE_URL}/`,
    runs: 1,
    hardDeadlineMs: 30_000,
    options: { stealth: false, captcha: false },
    steps: [
      { index: 0, text: "(implicit) Go to the page", intent: "navigate", value: `${BASE_URL}/`, target: "the page", expect: "the page loads" },
      { index: 1, text: "Click the search button", intent: "click", target: "Search", expect: "the search box appears" },
      { index: 2, text: 'Type "array methods" into the search input', intent: "type", target: "search input", value: "array methods", expect: "the value is entered" },
      pressIntent === "press"
        ? { index: 3, text: "Press Enter", intent: "press", value: "Enter", expect: "pressing Enter submits with no visible error" }
        : { index: 3, text: "Press Enter", intent: "click", target: "Enter", expect: "pressing Enter submits with no visible error" },
      { index: 4, text: "Confirm the results mention array methods", intent: "assert", expect: 'the search results contain "array methods"' },
    ],
  };
}

describe("press intent — Enter actually submits the search", () => {
  it('runs the full navigate -> click -> type -> press -> assert flow and passes, reaching the real results page', async () => {
    const client = await makeMockClient();
    const result = await executeRun(buildPlan("press"), client, 0);

    expect(result.steps.map((s) => s.status)).toEqual(["passed", "passed", "passed", "passed", "passed"]);
    expect(result.cause).toBeNull();
    // Proves the fix did more than avoid throwing — Enter genuinely
    // navigated to the results page inside the mocked app, not just that
    // verifyExpect's fuzzy fallback happened to be lenient.
    expect(page.url()).toContain("/results?q=array");
  });

  it("reproduces the original bug when Press Enter is (mis)compiled as a click on a nonexistent element", async () => {
    // This is the pre-fix behavior frozen in place as a regression guard:
    // clicking a target literally named "Enter" (which does not exist on
    // this page) throws ELEMENT_NOT_FOUND, and the run never reaches the
    // results page at all — exactly what the real MDN replay showed.
    const client = await makeMockClient();
    const result = await executeRun(buildPlan("click"), client, 0);

    expect(result.steps[3]!.status).toBe("failed");
    expect(result.cause).toBe("ELEMENT_NOT_FOUND");
    expect(page.url()).not.toContain("/results");
  });
});

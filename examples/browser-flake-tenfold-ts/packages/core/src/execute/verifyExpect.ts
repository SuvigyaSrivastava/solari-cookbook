import type { Page } from "playwright-core";
import { chatText, getGroqClient } from "../llm/groq.js";

export interface VerifyResult {
  passed: boolean;
  reason: string;
}

const ERROR_INDICATORS = [
  "internal server error",
  "something went wrong",
  "404",
  "not found",
  "application error",
  "undefined is not",
  "cannot read propert",
  "unhandled exception",
];

/**
 * Verifies a step's `expect` condition against the current page state.
 *
 * Order of checks, cheapest/most-certain first (§4.3 step 4: "Deterministic
 * checks first where possible"):
 *   1. URL contains a named fragment
 *   2. A specific quoted phrase must (or must not) be visible
 *   3. A specific number/percentage must (or must not) be visible
 *   4. An order/confirmation-number-shaped pattern must be visible
 *   5. LLM judgement, if GROQ_API_KEY is set
 *   6. No-LLM fallback: pass unless the page shows a clear error indicator
 *
 * Steps 2-4 are DECISIVE in both directions — if the plan specifically
 * expects "a 10% discount" and the page shows no such thing, that's a real
 * ASSERTION_FAILED, not something a generic heuristic should paper over.
 * Step 6 only fires when the expectation has no such checkable literal in
 * it, which is exactly when a human would also shrug and say "looks fine."
 */
export async function verifyExpect(page: Page, expect: string): Promise<VerifyResult> {
  const url = page.url();
  const quoted = firstQuoted(expect);

  if (/\burl\b/i.test(expect) && quoted && url.includes(quoted)) {
    return { passed: true, reason: `URL contains "${quoted}"` };
  }

  let bodyText = "";
  try {
    bodyText = (await page.locator("body").innerText()).toLowerCase();
  } catch {
    /* page may have navigated away mid-check */
  }

  if (quoted) {
    const found = bodyText.includes(quoted.toLowerCase());
    return {
      passed: found,
      reason: found ? `Page contains "${quoted}"` : `Page does not contain "${quoted}"`,
    };
  }

  const percent = expect.match(/(\d+)\s*%/);
  if (percent) {
    const found = bodyText.includes(`${percent[1]}%`);
    return {
      passed: found,
      reason: found ? `Page shows "${percent[1]}%"` : `Page does not show "${percent[1]}%" anywhere`,
    };
  }

  if (/(order|confirmation)\s*(number|id|#)?/i.test(expect) && /order|confirmation/i.test(expect)) {
    const found = /order\s*#?\s*[a-z0-9-]{3,}/i.test(bodyText);
    return {
      passed: found,
      reason: found ? "Page shows an order/confirmation number" : "No order/confirmation number found on page",
    };
  }

  if (getGroqClient()) {
    const llmResult = await verifyWithLlm(bodyText, expect);
    if (llmResult) return llmResult;
  }

  const hasErrorIndicator = ERROR_INDICATORS.some((e) => bodyText.includes(e));
  return {
    passed: !hasErrorIndicator,
    reason: hasErrorIndicator
      ? "Page shows an error indicator and no LLM is configured to judge further"
      : "No specific literal to check and no error indicator found (no GROQ_API_KEY — set one for stricter verification)",
  };
}

async function verifyWithLlm(bodyText: string, expect: string): Promise<VerifyResult | null> {
  const model = process.env.RESOLVE_MODEL ?? "openai/gpt-oss-20b";
  try {
    const raw = await chatText({
      model,
      system:
        'Answer with exactly one word, "PASS" or "FAIL", followed by a colon and a one-line reason. ' +
        "Does the page text satisfy the expectation?",
      user: `Expectation: ${expect}\n\nPage text (truncated):\n${bodyText.slice(0, 3000)}`,
      maxTokens: 60,
    });
    const passed = /^pass/i.test(raw.trim());
    const reason = raw.split(":").slice(1).join(":").trim() || raw.trim();
    return { passed, reason };
  } catch {
    return null;
  }
}

function firstQuoted(text: string): string | undefined {
  const m = text.match(/"([^"]+)"|'([^']+)'/);
  return m?.[1] ?? m?.[2];
}

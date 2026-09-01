import type { Page } from "playwright-core";
import type { StepIntent } from "../types.js";
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
 *   5. LLM judgement, if GROQ_API_KEY is set AND the intent is one where
 *      the page's rendered text can actually answer the question
 *   6. No-LLM fallback: pass unless the page shows a clear error indicator
 *
 * Steps 2-4 are DECISIVE in both directions — if the plan specifically
 * expects "a 10% discount" and the page shows no such thing, that's a real
 * ASSERTION_FAILED, not something a generic heuristic should paper over.
 *
 * Step 5 is intent-gated to "assert" steps only, for a reason found the
 * hard way against a real model and a real page: for every OTHER intent
 * (navigate/click/type/select/wait), compilePlan's prompt asks the LLM to
 * phrase "expect" as mechanical-action-succeeded ("the Add to Cart button
 * is clickable", "the value is entered"). But verifyExpect runs AFTER the
 * action already happened — so asking an LLM "does the page text satisfy
 * <pre-action button description>?" against the POST-click/type page is a
 * false-failure generator with ~100% reproducibility: the button's exact
 * wording is often gone by then (page navigated, cart count updated, the
 * label itself changed), even though the click/type/select unambiguously
 * succeeded. The clearest case is "type"/"select": a typed value lives in
 * an <input>'s `.value` property, which never appears in `innerText()` at
 * all. But the same failure mode hits "click" just as hard whenever the
 * click changes the DOM it was found in.
 *
 * The actual signal for "did this mechanical action succeed" is whether
 * runStep() threw — resolveTarget already failed loudly (ELEMENT_NOT_FOUND)
 * if the element couldn't be found, and Playwright's own .click()/.fill()/
 * .selectOption() throw if the action itself didn't apply. So for every
 * non-"assert" intent, verifyExpect trusts that "no exception" already
 * proved the mechanical step succeeded, and skips the LLM literal-text
 * judgement entirely — while steps 1-4's DETERMINISTIC checks (a quoted
 * phrase, a percentage, an order-number pattern) still run regardless of
 * intent, since those are unambiguous either way. Only "assert" steps —
 * the ones whose entire purpose is "check what the page now shows" — pay
 * for the full LLM judgement call.
 */
export async function verifyExpect(page: Page, expect: string, intent: StepIntent = "assert"): Promise<VerifyResult> {
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

  const isAssert = intent === "assert";

  if (getGroqClient() && isAssert) {
    const llmResult = await verifyWithLlm(bodyText, expect);
    if (llmResult) return llmResult;
  }

  const hasErrorIndicator = ERROR_INDICATORS.some((e) => bodyText.includes(e));
  return {
    passed: !hasErrorIndicator,
    reason: hasErrorIndicator
      ? "Page shows an error indicator"
      : isAssert
        ? "No specific literal to check and no error indicator found (no GROQ_API_KEY — set one for stricter verification)"
        : `No specific literal to check in this ${intent} step's expect — trusting that the mechanical action not ` +
          "throwing means it succeeded; the page's post-action text is not a reliable check for pre-action phrasing " +
          "like this, and any real downstream effect belongs to a later \"assert\" step that reads visible text.",
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

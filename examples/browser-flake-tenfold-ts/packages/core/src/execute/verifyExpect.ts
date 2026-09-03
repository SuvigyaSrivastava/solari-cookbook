import type { Page } from "playwright-core";
import type { StepIntent } from "../types.js";
import { chatText, getGroqClient } from "../llm/groq.js";

export interface VerifyResult {
  passed: boolean;
  reason: string;
}

// A bare "404" or "not found" is too naive to trust on a real page: Wikipedia
// alone false-positived on this — its own citation footnote numbering
// ("...claimed [404] according to...", the article's 404th reference) tripped
// the old bare "404" check, on a page that loaded and rendered correctly.
// Every phrase here is specific enough that real prose is very unlikely to
// contain it incidentally, unlike a bare number or two common words.
const ERROR_INDICATORS = [
  "internal server error",
  "something went wrong",
  "application error",
  "undefined is not",
  "cannot read propert",
  "unhandled exception",
];

// "404" and "not found"/"error" within a few words of each other (either
// order — "404 Not Found", "Error 404: Not Found", "404 - page not found")
// is a reliable real-error signal; either phrase ALONE is not, since
// ordinary prose says "not found" constantly and a numbered citation can
// just as easily read "[404]" as a footnote index, not an HTTP status.
// Verified against the real Wikipedia page text that caused the original
// false positive (230K+ chars, contains "[404]" as a citation number) —
// this pattern correctly does not match it, while still matching real
// 404-page phrasings including ones with a word ("page") between the
// anchors, which a plain [^a-z0-9]-gap version would miss.
const NOT_FOUND_PATTERN =
  /\b404\b(?:\W+\w+){0,3}?\W+(not found|error)|\b(not found|error)(?:\W+\w+){0,3}?\W+\b404\b/i;

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
    const exact = bodyText.includes(quoted.toLowerCase());
    if (exact) {
      return { passed: true, reason: `Page contains "${quoted}"` };
    }
    // The exact phrase not appearing verbatim is NOT automatically a real
    // failure — confirmed live against a genuinely working search flow:
    // compilePlan quite reasonably wrote the "type" step's expect as
    // `the search results contain "array methods"` (quoting the user's own
    // typed value back), but a real results page for that query shows
    // content ABOUT array methods (headings like "Array.prototype.map()",
    // "Array.prototype.filter()") without ever containing that literal
    // three-word phrase verbatim — a strict substring check turned a
    // correctly-working search into a false ASSERTION_FAILED on every run.
    // Fall back to a keyword-overlap check (same idea as resolveTarget's
    // own keywordScan): every SIGNIFICANT word in the quoted phrase must
    // still appear somewhere on the page, just not necessarily contiguous
    // or in that exact order. This deliberately requires ALL words, not
    // just some — a plan that expects "SAVE10 applied" and only finds
    // "SAVE10" without "applied" anywhere should still fail, since that's
    // a real, substantive difference, not a phrasing mismatch.
    const words = significantWords(quoted);
    if (words.length > 1) {
      const allWordsPresent = words.every((w) => bodyText.includes(w));
      if (allWordsPresent) {
        return { passed: true, reason: `Page contains all of: ${words.join(", ")} (not as the exact phrase "${quoted}", but every significant word is present)` };
      }
    }
    return { passed: false, reason: `Page does not contain "${quoted}"` };
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
    const llmResult = await verifyWithLlm(page, bodyText, expect);
    if (llmResult) return llmResult;
  }

  const hasErrorIndicator =
    ERROR_INDICATORS.some((e) => bodyText.includes(e)) || NOT_FOUND_PATTERN.test(bodyText);
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

/**
 * Selectors tried in order for the LLM verify sample, most-specific first.
 * Confirmed live against Wikipedia why this matters: `<body>`'s first 3000
 * characters there are entirely nav menu, table of contents, and a wall of
 * ~180 language-switcher link names — the actual article title and content
 * don't appear until well past that cutoff. A plain body-text slice biases
 * against any page with substantial chrome before its main content, which
 * describes most real sites with a nav bar or sidebar, not just Wikipedia.
 */
const MAIN_CONTENT_SELECTORS = ["main", "[role=main]", "article", "#content", "#mw-content-text"];

/**
 * Best-effort extraction of the page's actual content text for the LLM
 * verifier, trying progressively less-specific selectors and falling back
 * to the full body text (already computed by the caller) only if none of
 * them exist or all come back empty. This intentionally does NOT replace
 * the deterministic quoted-phrase/percent/order-number checks above, which
 * still scan the full untruncated bodyText — those are cheap enough that
 * "might be buried past a content selector's boundary" isn't a real risk;
 * this only matters for the token-budget-limited slice sent to the LLM.
 */
async function extractVerifyText(page: Page, bodyTextFallback: string): Promise<string> {
  for (const selector of MAIN_CONTENT_SELECTORS) {
    try {
      const loc = page.locator(selector).first();
      if ((await loc.count()) === 0) continue;
      const text = await loc.innerText();
      if (text && text.trim().length > 40) return text.toLowerCase();
    } catch {
      // selector not present or not readable on this page — try the next one
    }
  }
  return bodyTextFallback;
}

async function verifyWithLlm(page: Page, bodyText: string, expect: string): Promise<VerifyResult | null> {
  const model = process.env.RESOLVE_MODEL ?? "openai/gpt-oss-20b";
  try {
    const sampleText = await extractVerifyText(page, bodyText);
    const raw = await chatText({
      model,
      system:
        'Answer with exactly one word, "PASS" or "FAIL", followed by a colon and a one-line reason. ' +
        "Does the page text satisfy the expectation?",
      user: `Expectation: ${expect}\n\nPage text (truncated):\n${sampleText.slice(0, 3000)}`,
      maxTokens: 60,
    });
    const passed = /^pass/i.test(raw.trim());
    const reason = raw.split(":").slice(1).join(":").trim() || raw.trim();
    return { passed, reason };
  } catch (err) {
    // Previously silent — a failed LLM verify call fell straight through to
    // the crude ERROR_INDICATORS substring scan with zero visibility into
    // WHY the LLM path didn't run. That's exactly what made a real Wikipedia
    // false-positive ("[404]", a citation footnote number, not an HTTP
    // error) look like a mysterious page-content problem instead of what it
    // actually was: this call throwing on every single attempt.
    console.error(`[tenfold-core] LLM verify call failed for expectation "${expect}":`, err);
    return null;
  }
}

function firstQuoted(text: string): string | undefined {
  const m = text.match(/"([^"]+)"|'([^']+)'/);
  return m?.[1] ?? m?.[2];
}

// A small, deliberately generic stopword list for verification text — this
// is quoted EXPECTATION phrases ("array methods", "SAVE10 applied"), not UI
// element descriptions, so it doesn't need (and shouldn't share) resolveTarget's
// own STOPWORDS list, which is tuned for words like "button"/"input"/"click".
const VERIFY_STOPWORDS = new Set([
  "a", "an", "the", "to", "for", "on", "in", "of", "and", "or", "is", "are",
  "with", "this", "that", "it", "its",
]);

function significantWords(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 1 && !VERIFY_STOPWORDS.has(w));
}

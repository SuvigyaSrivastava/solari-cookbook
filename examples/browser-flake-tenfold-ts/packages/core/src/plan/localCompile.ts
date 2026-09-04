import type { CompiledStep } from "../types.js";

/**
 * Deterministic English -> Step compiler, used when GROQ_API_KEY is unset.
 * It's a heuristic, not a language model, so it won't handle arbitrary
 * phrasing as gracefully — but it's what makes Tenfold runnable with zero
 * API keys, and it's tuned to read the Flakemart demo plan (§7 of the brief)
 * correctly, plus reasonable guesses for other simple imperative test steps.
 */
export function localCompile(englishLines: string[], targetUrl: string): CompiledStep[] {
  return englishLines.map((raw, i) => compileLine(raw.trim(), i, targetUrl));
}

/**
 * Detects "Go to X and apply/enter/type coupon CODE" — the one compound
 * shape that turned out to trip up even the LLM compiler inconsistently
 * (it would occasionally drop the "type SAVE10" half entirely and turn the
 * whole line into a plain "click the cart" step). Exported so compilePlan.ts
 * can apply it as a deterministic override on top of the LLM path for this
 * one well-known tricky pattern specifically, rather than trusting sampling
 * variance on every single run of what's likely to be Tenfold's most-run
 * demo plan.
 */
export function detectApplyCouponLine(text: string): CompiledStep | null {
  const lower = text.toLowerCase();
  const quoted = firstQuoted(text);
  const applyMatch = lower.match(/^go to (?:the )?(\w+)\s+and\s+(?:apply|enter|type)\s+(?:coupon\s+)?/);
  if (!applyMatch) return null;
  const code = extractCode(text) ?? quoted;
  return {
    text,
    intent: "type",
    target: "coupon code",
    value: code ?? "",
    expect: "the coupon code is entered and submitted",
  };
}

/** "Click X and confirm/verify/check that Y" — see detectApplyCouponLine's comment. */
export function detectClickAndConfirmLine(text: string): CompiledStep | null {
  const clickAndConfirm = text.match(/^click\s+(?:on\s+)?(.+?)\s+and\s+(?:confirm|verify|check that)\s+(.+)$/i);
  if (!clickAndConfirm) return null;
  return {
    text,
    intent: "click",
    target: clickAndConfirm[1]!.replace(/^["']|["']$/g, ""),
    expect: clickAndConfirm[2]!,
  };
}

/**
 * Detects a standalone "Press/Hit Enter|Tab|Escape" line. Exported for the
 * same reason as the two detectors above — and this one turned out to need
 * it MORE than either: confirmed live against a real Groq-backed run (the
 * LLM compiler path, which is what actually runs whenever GROQ_API_KEY is
 * set, i.e. Tenfold's normal/default configuration) that the LLM kept
 * classifying "Press Enter" as something other than the new "press" intent
 * despite the system prompt explicitly describing it — sampling variance on
 * a brand-new intent it has no few-shot example for, the same class of
 * problem the coupon/confirm detectors below already exist to route around.
 * A misclassification here is exactly as silent and exactly as costly as
 * the original bug: whatever intent the LLM picks instead, nothing actually
 * sends the Enter key to the page, so the search/form is never submitted
 * and every later assert fails against the pre-submit page state. This
 * detector is deterministic and wins outright over the LLM's guess,
 * regardless of what the LLM said.
 */
export function detectPressLine(text: string): CompiledStep | null {
  const lower = text.toLowerCase();
  // Anchored on "press"/"hit" appearing anywhere in the line (not just as
  // the very first word) followed, within a few words, by the key name —
  // "the ... key" in between ("Press the Enter key") and a leading clause
  // ("Then press enter to search") are both realistic real-world phrasings
  // that a stricter line-start-only match would miss, silently falling
  // back to whatever the LLM (or the click-default heuristic below) guessed
  // instead — exactly the failure mode this detector exists to prevent.
  const pressMatch = lower.match(/\b(?:press|hit)\b(?:\s+\w+){0,3}?\s+(enter|tab|escape|esc)\b/);
  if (!pressMatch) return null;
  const key = normalizeKeyName(pressMatch[1]!);
  return {
    text,
    intent: "press",
    value: key,
    expect: `pressing ${key} submits/advances with no visible error`,
  };
}

function compileLine(text: string, i: number, targetUrl: string): CompiledStep {
  const lower = text.toLowerCase();
  const quoted = firstQuoted(text);

  const applyCoupon = detectApplyCouponLine(text);
  if (applyCoupon) return applyCoupon;

  const clickAndConfirm = detectClickAndConfirmLine(text);
  if (clickAndConfirm) return clickAndConfirm;

  // MUST be checked before "assert"/"confirm" too — none of those regexes
  // happen to match "Press Enter", but keeping every deterministic-override
  // detector grouped at the very top (before any of the heuristic branches
  // below) is what makes it obvious at a glance that none of them can ever
  // shadow each other by accident.
  const press = detectPressLine(text);
  if (press) return press;

  // --- assert / confirm ----------------------------------------------------
  if (/^(confirm|verify|check that|assert|make sure)/.test(lower) || lower.includes("should show") || lower.includes("should see")) {
    return {
      text,
      intent: "assert",
      expect: stripLeadingVerb(text, ["confirm", "verify", "check that", "assert that", "assert", "make sure"]),
    };
  }

  // --- navigate --------------------------------------------------------------
  if (/^(open|navigate to|go to|visit)\b/.test(lower) && i === 0) {
    const url = extractUrl(text) ?? targetUrl;
    return {
      text,
      intent: "navigate",
      value: url,
      target: "the page",
      expect: `the page at ${url} loads successfully`,
    };
  }
  if (/^(go to|navigate to|open)\b/.test(lower)) {
    return {
      text,
      intent: "navigate",
      target: quoted ?? stripLeadingVerb(text, ["go to", "navigate to", "open"]),
      expect: `the ${quoted ?? "target"} page is shown`,
    };
  }

  // --- type / apply / fill ----------------------------------------------------
  if (/\b(type|enter|apply|fill in|fill)\b/.test(lower)) {
    const code = extractCode(text) ?? quoted;
    const targetGuess = guessInputTarget(lower);
    return {
      text,
      intent: "type",
      target: targetGuess,
      value: code ?? "",
      expect: `the value${code ? ` "${code}"` : ""} is accepted by the ${targetGuess}`,
    };
  }

  // --- select / choose ---------------------------------------------------------
  if (/\b(select|choose)\b/.test(lower)) {
    return {
      text,
      intent: "select",
      target: stripLeadingVerb(text, ["select", "choose"]),
      value: quoted ?? undefined,
      expect: `the option${quoted ? ` "${quoted}"` : ""} is selected`,
    };
  }

  // --- wait ---------------------------------------------------------------------
  if (/^wait\b/.test(lower)) {
    return {
      text,
      intent: "wait",
      expect: "the page has finished loading",
    };
  }

  // --- default: click ------------------------------------------------------------
  const clickTarget = quoted ?? stripLeadingVerb(text, ["click on", "click", "press", "add", "go to"]);
  return {
    text,
    intent: "click",
    target: clickTarget,
    expect: `clicking "${clickTarget}" succeeds with no visible error`,
  };
}

/** Maps the informal key names a user might type to Playwright's expected key names. */
function normalizeKeyName(name: string): string {
  const map: Record<string, string> = { enter: "Enter", tab: "Tab", escape: "Escape", esc: "Escape" };
  return map[name.toLowerCase()] ?? name;
}

function firstQuoted(text: string): string | undefined {
  const m = text.match(/"([^"]+)"|'([^']+)'/);
  return m?.[1] ?? m?.[2];
}

function extractUrl(text: string): string | undefined {
  const m = text.match(/https?:\/\/\S+/);
  return m?.[0];
}

/** Coupon-style codes: SAVE10, WELCOME20, etc. — all-caps alnum, 3+ chars. */
function extractCode(text: string): string | undefined {
  const m = text.match(/\b[A-Z][A-Z0-9]{2,}\b/);
  return m?.[0];
}

function guessInputTarget(lower: string): string {
  if (lower.includes("coupon") || lower.includes("promo") || lower.includes("discount code")) {
    return "coupon code";
  }
  if (lower.includes("email")) return "email input";
  if (lower.includes("password")) return "password input";
  if (lower.includes("search")) return "search input";
  return "input field";
}

function stripLeadingVerb(text: string, verbs: string[]): string {
  let out = text;
  for (const v of verbs) {
    const re = new RegExp(`^${v}\\s+`, "i");
    if (re.test(out)) {
      out = out.replace(re, "");
      break;
    }
  }
  return out.replace(/^["']|["']$/g, "").trim() || text;
}

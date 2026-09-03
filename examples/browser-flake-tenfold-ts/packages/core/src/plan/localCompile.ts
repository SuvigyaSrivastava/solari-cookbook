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

function compileLine(text: string, i: number, targetUrl: string): CompiledStep {
  const lower = text.toLowerCase();
  const quoted = firstQuoted(text);

  const applyCoupon = detectApplyCouponLine(text);
  if (applyCoupon) return applyCoupon;

  const clickAndConfirm = detectClickAndConfirmLine(text);
  if (clickAndConfirm) return clickAndConfirm;

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

  // --- press (keyboard key, not an element) --------------------------------------
  // Confirmed live as a real, silent bug: "Press Enter" used to fall all the
  // way through to the "default: click" branch below, because
  // stripLeadingVerb already knew "press" as a strippable verb — producing
  // intent "click", target "Enter". resolveTarget then went looking for a
  // clickable element literally named "Enter", which doesn't exist on a
  // real search box (the key that submits a form has no DOM element of its
  // own). Confirmed via a live MDN replay: the search input received the
  // typed text correctly, but the recording shows no navigation and no
  // keyboard event after it at all — the click intent either silently
  // no-op'd or matched something unrelated via the generic text fallback,
  // and the search was simply never submitted, so every later "assert" step
  // failed against the page's still-open autocomplete dropdown. Detecting
  // this phrasing explicitly and giving it its own "press" intent (handled
  // in executeRun.ts via page.keyboard.press) means Enter is actually sent
  // to the currently-focused field, exactly like a real user pressing it
  // right after typing. MUST run before the "type" check just below —
  // "Press Enter" contains the bare word "enter", which that check's own
  // regex also matches, so ordering alone previously guaranteed this branch
  // could never be reached even after it existed.
  const pressMatch = lower.match(/^(?:press|hit)\s+(enter|tab|escape|esc)\b/);
  if (pressMatch) {
    const key = normalizeKeyName(pressMatch[1]!);
    return {
      text,
      intent: "press",
      value: key,
      expect: `pressing ${key} submits/advances with no visible error`,
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

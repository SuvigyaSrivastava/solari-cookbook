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

function compileLine(text: string, i: number, targetUrl: string): CompiledStep {
  const lower = text.toLowerCase();
  const quoted = firstQuoted(text);

  // --- compound: "Go to the cart and apply coupon SAVE10" -------------------
  // §7 Flakemart's demo plan writes navigation and the flaky action as one
  // English line. `runStep` (executeRun.ts) handles the implied navigation
  // for any intent by scanning the full step text, so here we only need to
  // produce the *primary* (type) action — with an expect that doesn't bake
  // in the literal code, since a typed value never shows up in body innerText
  // regardless of whether the type action itself succeeded.
  const applyMatch = lower.match(/^go to (?:the )?(\w+)\s+and\s+(?:apply|enter|type)\s+(?:coupon\s+)?/);
  if (applyMatch) {
    const code = extractCode(text) ?? quoted;
    return {
      text,
      intent: "type",
      target: "coupon code",
      value: code ?? "",
      expect: "the coupon code is entered and submitted",
    };
  }

  // --- compound: "Click Checkout and confirm an order number appears" -------
  const clickAndConfirm = text.match(/^click\s+(?:on\s+)?(.+?)\s+and\s+(?:confirm|verify|check that)\s+(.+)$/i);
  if (clickAndConfirm) {
    return {
      text,
      intent: "click",
      target: clickAndConfirm[1]!.replace(/^["']|["']$/g, ""),
      expect: clickAndConfirm[2]!,
    };
  }

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

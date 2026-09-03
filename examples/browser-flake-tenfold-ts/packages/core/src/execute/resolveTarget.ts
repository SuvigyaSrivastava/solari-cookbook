import type { Locator, Page } from "playwright-core";
import type { Step } from "../types.js";
import type { LocatorSpec } from "../memory/types.js";
import { chatJson, stripFences, getGroqClient } from "../llm/groq.js";

export class ElementNotFoundError extends Error {
  constructor(target: string) {
    super(`No element found matching "${target}"`);
    this.name = "ElementNotFoundError";
  }
}

export interface ResolvedTarget {
  locator: Locator;
  /** How this was found — persisted to Workflow Memory (§11) on success. */
  spec: LocatorSpec;
}

/**
 * Resolves a step's natural-language `target` to a concrete Playwright
 * Locator, AND to the portable `LocatorSpec` that found it — the spec is
 * what Workflow Memory (§11) writes to `step_memory` so a later run against
 * the same page can skip straight to `resolveFromSpec` instead of paying
 * for this whole function (including its LLM fallback) again.
 *
 * Deterministic role/text/testid heuristics run first — they're fast, free,
 * and cover the overwhelming majority of well-built pages (including our
 * own Flakemart). The LLM resolver only kicks in when those all come up
 * empty AND GROQ_API_KEY is set, exactly per §4.3 of the brief ("prefer
 * getByRole/getByText; CSS is last resort").
 *
 * Resolutions are cached per (step index, snapshot hash) within a run by the
 * caller (executeRun.ts) — this function itself is stateless.
 */
export async function resolveTarget(page: Page, step: Step): Promise<ResolvedTarget> {
  if (!step.target) {
    throw new ElementNotFoundError("(no target specified)");
  }
  const target = step.target;
  const quoted = firstQuoted(target) ?? firstQuoted(step.value ?? "");
  const needle = quoted ?? target;

  const candidates: Array<{ make: () => Locator; spec: LocatorSpec }> = [];

  if (step.intent === "click") {
    candidates.push({
      make: () => page.getByRole("button", { name: needle, exact: false }),
      spec: { kind: "role", role: "button", name: needle },
    });
    candidates.push({
      make: () => page.getByRole("link", { name: needle, exact: false }),
      spec: { kind: "role", role: "link", name: needle },
    });
  }
  if (step.intent === "type") {
    candidates.push({
      make: () => page.getByPlaceholder(needle, { exact: false }),
      spec: { kind: "role", role: "textbox", name: needle },
    });
    candidates.push({
      make: () => page.getByLabel(needle, { exact: false }),
      spec: { kind: "role", role: "textbox", name: needle },
    });
    candidates.push({
      make: () => page.getByRole("textbox", { name: needle, exact: false }),
      spec: { kind: "role", role: "textbox", name: needle },
    });
  }
  if (step.intent === "select") {
    candidates.push({
      make: () => page.getByLabel(needle, { exact: false }),
      spec: { kind: "role", role: "combobox", name: needle },
    });
    candidates.push({
      make: () => page.getByRole("combobox", { name: needle, exact: false }),
      spec: { kind: "role", role: "combobox", name: needle },
    });
  }
  // Generic fallbacks that apply regardless of intent.
  candidates.push({ make: () => page.getByText(needle, { exact: false }), spec: { kind: "text", text: needle } });
  const testidCss = `[data-testid="${slugify(needle)}"]`;
  const testidCssContains = `[data-testid*="${slugify(needle)}"]`;
  candidates.push({ make: () => page.locator(testidCss), spec: { kind: "css", css: testidCss } });
  candidates.push({ make: () => page.locator(testidCssContains), spec: { kind: "css", css: testidCssContains } });

  for (const { make, spec } of candidates) {
    try {
      const loc = make().first();
      if ((await loc.count()) > 0) return { locator: loc, spec };
    } catch {
      // invalid selector shape for this candidate type — try the next one
    }
  }

  // An LLM-written target often describes an element in different word
  // order than its actual accessible name ("Blue Hoodie add to cart button"
  // vs. the real "Add Blue Hoodie to Cart") — a direct substring match in
  // either direction fails even though a human would call it an obvious
  // match. Before paying for an LLM resolver call, try a keyword-overlap
  // scan: does every "significant" word in the target appear somewhere in
  // this candidate's accessible name, in any order?
  if (step.intent === "click" || step.intent === "type" || step.intent === "select") {
    const roles = step.intent === "click" ? (["button", "link"] as const) : (["textbox", "combobox"] as const);
    for (const r of roles) {
      const found = await keywordScan(page, r, needle);
      if (found) return { locator: found.locator, spec: { kind: "role", role: r, name: found.name } };
    }
  }

  if (getGroqClient()) {
    const llmResult = await resolveWithLlm(page, step);
    if (llmResult) return llmResult;
  }

  throw new ElementNotFoundError(target);
}

/**
 * The reuse half of Workflow Memory (§11.2 step 2): given a spec that
 * worked on a previous run, try to rebuild it and confirm it STILL matches
 * exactly one element. Deliberately stricter than resolveTarget's own
 * candidates (which take the first match of several strategies) — a
 * remembered locator that now matches zero or more-than-one elements is
 * exactly the "page drifted" signal that should trigger a re-learn instead
 * of silently clicking the wrong thing.
 */
export async function resolveFromSpec(page: Page, spec: LocatorSpec): Promise<Locator | null> {
  try {
    const loc = locatorForSpec(page, spec);
    const count = await loc.count();
    return count === 1 ? loc.first() : null;
  } catch {
    return null;
  }
}

function locatorForSpec(page: Page, spec: LocatorSpec): Locator {
  if (spec.kind === "role") {
    return page.getByRole(spec.role as Parameters<Page["getByRole"]>[0], { name: spec.name, exact: false });
  }
  if (spec.kind === "text") {
    return page.getByText(spec.text, { exact: false });
  }
  return page.locator(spec.css);
}

async function resolveWithLlm(page: Page, step: Step): Promise<ResolvedTarget | null> {
  let snapshot: string;
  try {
    // Playwright >= 1.49 ARIA snapshot, trimmed per §4.3 step 1.
    snapshot = await (page.locator("body") as any).ariaSnapshot();
    if (snapshot.length > 6000) snapshot = snapshot.slice(0, 6000);
  } catch {
    snapshot = await page.title().catch(() => "");
  }

  const model = process.env.RESOLVE_MODEL ?? "openai/gpt-oss-20b";
  try {
    const raw = await chatJson({
      model,
      system:
        'Given an ARIA snapshot of a web page and a natural-language target description, ' +
        'return ONLY JSON: {"role":string,"name":string} OR {"text":string} OR {"css":string}. ' +
        "Prefer role+name. Use css only as a last resort.",
      user: `Target: ${step.target}\n\nARIA snapshot:\n${snapshot}`,
    });
    const rawSpec = JSON.parse(stripFences(raw));
    const spec: LocatorSpec | null =
      rawSpec.role && rawSpec.name
        ? { kind: "role", role: rawSpec.role, name: rawSpec.name }
        : rawSpec.text
          ? { kind: "text", text: rawSpec.text }
          : rawSpec.css
            ? { kind: "css", css: rawSpec.css }
            : null;
    if (!spec) return null;

    const loc = locatorForSpec(page, spec);
    if ((await loc.first().count()) > 0) return { locator: loc.first(), spec };
    // The LLM answered, but its answer doesn't resolve to anything on the
    // real page — worth knowing about when this is the reason a step
    // reports ELEMENT_NOT_FOUND instead of assuming Groq was never reached.
    console.error(`[tenfold-core] LLM resolver returned a spec that matched 0 elements for target "${step.target}":`, spec);
    return null;
  } catch (err) {
    // Swallowed by design (falls through to ElementNotFoundError, which is
    // the correct user-facing failure either way) but silent otherwise —
    // an auth/network/parse failure here looked identical to "the deterministic
    // heuristics just couldn't find it" until this was added, which made a
    // real live-mode ELEMENT_NOT_FOUND much harder to diagnose than it
    // needed to be.
    console.error(`[tenfold-core] LLM resolver call failed for target "${step.target}":`, err);
    return null;
  }
}

const STOPWORDS = new Set([
  "a", "an", "the", "to", "for", "on", "in", "of", "and", "or", "button",
  "field", "input", "box", "click", "add", "go", "open", "page", "type",
  "enter", "select", "with", "this", "that",
]);

function significantWords(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 1 && !STOPWORDS.has(w));
}

/**
 * Scans every element with the given ARIA role for one whose accessible
 * name contains all of the target's significant words, regardless of order
 * — a cheap, deterministic middle ground between a strict substring match
 * and a full LLM resolver call. Bounded to the first 30 matches on the page
 * so a pathological page can't make this scan expensive.
 */
async function keywordScan(page: Page, role: string, needle: string): Promise<{ locator: Locator; name: string } | null> {
  const words = significantWords(needle);
  if (words.length === 0) return null;
  const locator = page.getByRole(role as Parameters<Page["getByRole"]>[0]);
  const count = Math.min(await locator.count().catch(() => 0), 30);
  for (let i = 0; i < count; i++) {
    const el = locator.nth(i);
    const name = (await el.innerText().catch(() => "")).toLowerCase();
    if (words.every((w) => name.includes(w))) return { locator: el, name };
  }
  return null;
}

function firstQuoted(text: string): string | undefined {
  const m = text.match(/"([^"]+)"|'([^']+)'/);
  return m?.[1] ?? m?.[2];
}

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

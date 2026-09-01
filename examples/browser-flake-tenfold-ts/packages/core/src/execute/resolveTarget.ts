import type { Locator, Page } from "playwright-core";
import type { Step } from "../types.js";
import { chatJson, stripFences, getGroqClient } from "../llm/groq.js";

export class ElementNotFoundError extends Error {
  constructor(target: string) {
    super(`No element found matching "${target}"`);
    this.name = "ElementNotFoundError";
  }
}

/**
 * Resolves a step's natural-language `target` to a concrete Playwright
 * Locator. Deterministic role/text/testid heuristics run first — they're
 * fast, free, and cover the overwhelming majority of well-built pages
 * (including our own Flakemart). The LLM resolver only kicks in when those
 * all come up empty AND GROQ_API_KEY is set, exactly per §4.3 of the brief
 * ("prefer getByRole/getByText; CSS is last resort").
 *
 * Resolutions are cached per (step index, snapshot hash) within a run by the
 * caller (executeRun.ts) — this function itself is stateless.
 */
export async function resolveTarget(page: Page, step: Step): Promise<Locator> {
  if (!step.target) {
    throw new ElementNotFoundError("(no target specified)");
  }
  const target = step.target;
  const quoted = firstQuoted(target) ?? firstQuoted(step.value ?? "");
  const needle = quoted ?? target;

  const candidates: Array<() => Locator> = [];

  if (step.intent === "click") {
    candidates.push(() => page.getByRole("button", { name: needle, exact: false }));
    candidates.push(() => page.getByRole("link", { name: needle, exact: false }));
  }
  if (step.intent === "type") {
    candidates.push(() => page.getByPlaceholder(needle, { exact: false }));
    candidates.push(() => page.getByLabel(needle, { exact: false }));
    candidates.push(() => page.getByRole("textbox", { name: needle, exact: false }));
  }
  if (step.intent === "select") {
    candidates.push(() => page.getByLabel(needle, { exact: false }));
    candidates.push(() => page.getByRole("combobox", { name: needle, exact: false }));
  }
  // Generic fallbacks that apply regardless of intent.
  candidates.push(() => page.getByText(needle, { exact: false }));
  candidates.push(() => page.locator(`[data-testid="${slugify(needle)}"]`));
  candidates.push(() => page.locator(`[data-testid*="${slugify(needle)}"]`));

  for (const make of candidates) {
    try {
      const loc = make().first();
      if ((await loc.count()) > 0) return loc;
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
    const role = step.intent === "click" ? (["button", "link"] as const) : (["textbox", "combobox"] as const);
    for (const r of role) {
      const loc = await keywordScan(page, r, needle);
      if (loc) return loc;
    }
  }

  if (getGroqClient()) {
    const llmLocator = await resolveWithLlm(page, step);
    if (llmLocator) return llmLocator;
  }

  throw new ElementNotFoundError(target);
}

async function resolveWithLlm(page: Page, step: Step): Promise<Locator | null> {
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
    const spec = JSON.parse(stripFences(raw));
    let loc: Locator | null = null;
    if (spec.role && spec.name) {
      loc = page.getByRole(spec.role, { name: spec.name, exact: false });
    } else if (spec.text) {
      loc = page.getByText(spec.text, { exact: false });
    } else if (spec.css) {
      loc = page.locator(spec.css);
    }
    if (loc && (await loc.first().count()) > 0) return loc.first();
    return null;
  } catch {
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
async function keywordScan(page: Page, role: string, needle: string): Promise<Locator | null> {
  const words = significantWords(needle);
  if (words.length === 0) return null;
  const locator = page.getByRole(role as Parameters<Page["getByRole"]>[0]);
  const count = Math.min(await locator.count().catch(() => 0), 30);
  for (let i = 0; i < count; i++) {
    const el = locator.nth(i);
    const name = (await el.innerText().catch(() => "")).toLowerCase();
    if (words.every((w) => name.includes(w))) return el;
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

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

import {
  CompiledPlanSchema,
  TestPlanSchema,
  type CompiledStep,
  type TestPlan,
  type TestPlanOptions,
} from "../types.js";
import { chatJson, stripFences, getGroqClient } from "../llm/groq.js";
import { localCompile, detectApplyCouponLine, detectClickAndConfirmLine } from "./localCompile.js";

const SYSTEM_PROMPT = `You convert a numbered list of plain-English browser test steps into JSON.

Return ONLY a JSON object of the shape:
{"steps":[{"text":string,"intent":"navigate"|"click"|"type"|"select"|"wait"|"assert","target"?:string,"value"?:string,"expect":string}]}

Rules:
- One input line becomes exactly one step, in order. Never merge or split lines.
- "text" is the original line, verbatim.
- "intent" is your best classification of the PRIMARY action.
- "target" MUST name exactly ONE concrete element — a single button, link, or
  input. Never a compound phrase like "the coupon input and apply button" —
  pick the single element the intent's action applies to.
- "value" is the literal text to type, option to choose, or URL to navigate to (omit if not applicable).
- "expect" is REQUIRED on every step: a short, specific, checkable description
  of what the page should show if this step succeeded (a literal word/number/
  percentage that would actually appear is far better than a vague summary).
  Infer it even if the input line doesn't state it explicitly.
- IMPORTANT for non-"assert" intents (navigate/click/type/select/wait):
  "expect" describes only that the immediate mechanical action worked (the
  button was clickable, the field accepted the value, the page navigated) —
  never a downstream business outcome that a LATER step already checks. For
  example, after typing a coupon code, expect "the coupon code is entered
  and submitted", NOT "the discount is applied" — that claim belongs
  entirely to whichever later "assert" step actually asks about the
  discount. Getting this wrong makes a flaky page's failure show up on the
  wrong step, which defeats the entire point of a first-failure histogram.
- No markdown fences, no commentary, no keys other than "steps".

Two compound-sentence conventions — a single English line often does two
things at once; follow these exactly rather than inventing a compound target:

1. "Enter/type/apply <value> ... " where the value is also submitted in the
   same sentence (e.g. "apply coupon SAVE10", "enter promo code X and apply
   it"): classify as intent "type", target = ONLY the input field (e.g.
   "coupon code input"), value = the literal code/text. Do NOT also target
   the submit button and do NOT add a separate step for the click — the
   executor automatically clicks the nearest button matching "apply" or
   "submit" right after filling the field whenever the original line
   contains that word, so your job is just to get intent/target/value right
   for the fill.
2. "<Action> and confirm/verify/check that <condition>" (e.g. "Click
   Checkout and confirm an order number appears"): classify by the ACTION's
   intent (here "click"), target = ONLY the thing being acted on (here
   "Checkout"), and expect = the confirmation clause verbatim (here "an
   order number appears") — not a paraphrase combining both halves.`;

export interface CompilePlanOptions {
  runs?: number;
  hardDeadlineMs?: number;
  options?: Partial<TestPlanOptions>;
  model?: string;
}

export async function compilePlan(
  englishLines: string[],
  targetUrl: string,
  opts: CompilePlanOptions = {},
): Promise<TestPlan> {
  const lines = englishLines.map((l) => l.trim()).filter(Boolean);
  if (lines.length === 0) throw new Error("compilePlan: at least one step is required");
  if (lines.length > 12) throw new Error("compilePlan: at most 12 steps are allowed");

  const compiledSteps = getGroqClient()
    ? (await compileWithLlm(lines, targetUrl, opts.model ?? process.env.PLAN_MODEL ?? "openai/gpt-oss-120b")).map(
        (s, i) => {
          const line = lines[i]!;
          // A handful of compound-sentence shapes are common enough (and
          // tricky enough) that we don't trust LLM sampling variance with
          // them even at temperature 0 — see the two detectors' own
          // comments. When the raw line matches one, the deterministic
          // result wins outright; otherwise the LLM's step is used as-is.
          const override = detectApplyCouponLine(line) ?? detectClickAndConfirmLine(line);
          return override ?? { ...s, text: s.text.trim() === line ? s.text : line };
        },
      )
    : localCompile(lines, targetUrl);

  // Belt-and-suspenders, regardless of compiler: a navigate step with no
  // explicit URL in its own line means "go to the site under test." The LLM
  // is told this in the prompt below, but a model that ignores it (e.g.
  // hallucinating https://example.com for "Open the homepage") would
  // otherwise silently point every run at the wrong site — worth guarding
  // in code, not just in the prompt.
  const withRealTargetUrl = compiledSteps.map((s) => {
    if (s.intent !== "navigate") return s;
    const hasExplicitUrl = /https?:\/\//.test(s.text) || /https?:\/\//.test(s.value ?? "");
    return hasExplicitUrl ? s : { ...s, value: targetUrl };
  });

  const steps = withRealTargetUrl.map((s, index) => ({ ...s, index }));

  return TestPlanSchema.parse({
    targetUrl,
    steps,
    runs: opts.runs ?? Number(process.env.DEFAULT_N ?? 10),
    hardDeadlineMs: opts.hardDeadlineMs ?? Number(process.env.HARD_DEADLINE_MS ?? 120_000),
    options: {
      stealth: true,
      captcha: false,
      ...opts.options,
    },
  });
}

async function compileWithLlm(lines: string[], targetUrl: string, model: string): Promise<CompiledStep[]> {
  const userPrompt =
    `The site under test is: ${targetUrl}\n` +
    `If a step just says to open/visit the site or "the homepage" with no other URL mentioned, ` +
    `use exactly that URL as its "value" — never invent a different one.\n\n` +
    lines.map((l, i) => `${i + 1}. ${l}`).join("\n");

  const attempt = async (extra?: string): Promise<CompiledStep[]> => {
    const raw = await chatJson({
      model,
      system: SYSTEM_PROMPT,
      user: extra ? `${userPrompt}\n\n${extra}` : userPrompt,
    });
    const json = JSON.parse(stripFences(raw));
    const parsed = CompiledPlanSchema.parse(json);
    if (parsed.steps.length !== lines.length) {
      throw new Error(
        `Expected exactly ${lines.length} steps (one per input line), got ${parsed.steps.length}`,
      );
    }
    return parsed.steps;
  };

  try {
    return await attempt();
  } catch (err) {
    // Retry once with the validation error appended, per §4.2 of the brief.
    const message = err instanceof Error ? err.message : String(err);
    try {
      return await attempt(
        `Your previous response was invalid: ${message}\nReturn corrected JSON only, matching the schema exactly.`,
      );
    } catch {
      // Two LLM failures in a row — degrade gracefully rather than fail the
      // whole run. This is exactly the class of thing that later gets
      // tagged RESOLVER_ERROR ("Tenfold's own miss") if it causes a step to
      // misbehave downstream.
      return localCompile(lines, "");
    }
  }
}

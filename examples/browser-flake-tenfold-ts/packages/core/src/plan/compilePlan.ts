import {
  CompiledPlanSchema,
  TestPlanSchema,
  type CompiledStep,
  type TestPlan,
  type TestPlanOptions,
} from "../types.js";
import { chatJson, stripFences, getGroqClient } from "../llm/groq.js";
import { localCompile } from "./localCompile.js";

const SYSTEM_PROMPT = `You convert a numbered list of plain-English browser test steps into JSON.

Return ONLY a JSON object of the shape:
{"steps":[{"text":string,"intent":"navigate"|"click"|"type"|"select"|"wait"|"assert","target"?:string,"value"?:string,"expect":string}]}

Rules:
- One input line becomes exactly one step, in order. Never merge or split lines.
- "text" is the original line, verbatim.
- "intent" is your best classification of the action.
- "target" is a short natural-language description of the element acted on (omit for "wait").
- "value" is the literal text to type, option to choose, or URL to navigate to (omit if not applicable).
- "expect" is REQUIRED on every step: a short natural-language description of what the page should show if this step succeeded. Infer it even if the input line doesn't state it explicitly.
- No markdown fences, no commentary, no keys other than "steps".`;

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
    ? await compileWithLlm(lines, opts.model ?? process.env.PLAN_MODEL ?? "llama-3.3-70b-versatile")
    : localCompile(lines, targetUrl);

  const steps = compiledSteps.map((s, index) => ({ ...s, index }));

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

async function compileWithLlm(lines: string[], model: string): Promise<CompiledStep[]> {
  const userPrompt = lines.map((l, i) => `${i + 1}. ${l}`).join("\n");

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

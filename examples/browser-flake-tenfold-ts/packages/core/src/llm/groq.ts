import Groq from "groq-sdk";

/**
 * Thin Groq wrapper. Groq's SDK is OpenAI-chat-completions-shaped, so this
 * is intentionally the *only* LLM-specific file — plan.ts and execute/*.ts
 * call `chatJson`/`chatText` and never touch the Groq client directly. That
 * makes swapping providers later (or adding a second one) a one-file change.
 *
 * When GROQ_API_KEY is unset, `getGroqClient()` returns null and every
 * caller in this codebase falls back to a deterministic local heuristic —
 * see plan/localCompile.ts, execute/resolveTarget.ts, execute/verifyExpect.ts.
 */

let client: Groq | null | undefined;

export function getGroqClient(): Groq | null {
  if (client !== undefined) return client;
  const apiKey = process.env.GROQ_API_KEY;
  client = apiKey ? new Groq({ apiKey }) : null;
  return client;
}

/**
 * Groq's `openai/gpt-oss-*` models (our defaults, see index.ts) are
 * reasoning models: they spend tokens on a hidden chain-of-thought (surfaced
 * as `message.reasoning`, not `message.content`) before writing the actual
 * answer. Caught the hard way: a low `max_tokens` (60, for a one-word
 * PASS/FAIL classification) let the model burn its whole budget on
 * reasoning and return `content: ""` with `finish_reason: "length"` —
 * silently, no error. Fixed with `reasoning_effort: "low"` (keeps it fast
 * and cheap, appropriate for these small classification calls) plus enough
 * headroom in max_tokens for reasoning AND the final answer, and a fallback
 * that reads `reasoning` if `content` still comes back empty rather than
 * returning "" without explanation.
 */
const MIN_MAX_TOKENS = 300;

export async function chatJson(opts: {
  model: string;
  system: string;
  user: string;
}): Promise<string> {
  const groq = getGroqClient();
  if (!groq) throw new Error("GROQ_API_KEY not set");
  const completion = await groq.chat.completions.create({
    model: opts.model,
    messages: [
      { role: "system", content: opts.system },
      { role: "user", content: opts.user },
    ],
    temperature: 0,
    response_format: { type: "json_object" },
    max_tokens: 1500,
    // @ts-expect-error — reasoning_effort is supported by Groq's gpt-oss
    // models but not yet in this SDK version's request types.
    reasoning_effort: "low",
  });
  const message = completion.choices[0]?.message as { content?: string; reasoning?: string } | undefined;
  return message?.content || message?.reasoning || "";
}

export async function chatText(opts: {
  model: string;
  system: string;
  user: string;
  maxTokens?: number;
}): Promise<string> {
  const groq = getGroqClient();
  if (!groq) throw new Error("GROQ_API_KEY not set");
  const completion = await groq.chat.completions.create({
    model: opts.model,
    messages: [
      { role: "system", content: opts.system },
      { role: "user", content: opts.user },
    ],
    temperature: 0,
    max_tokens: Math.max(opts.maxTokens ?? 100, MIN_MAX_TOKENS),
    // @ts-expect-error — see chatJson above.
    reasoning_effort: "low",
  });
  const message = completion.choices[0]?.message as { content?: string; reasoning?: string } | undefined;
  return message?.content || message?.reasoning || "";
}

/** Strips ```json fences models sometimes add despite instructions not to. */
export function stripFences(text: string): string {
  const trimmed = text.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return fenced ? fenced[1]! : trimmed;
}

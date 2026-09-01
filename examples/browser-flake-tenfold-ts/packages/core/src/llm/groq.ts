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
  });
  return completion.choices[0]?.message?.content ?? "";
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
    max_tokens: opts.maxTokens ?? 100,
  });
  return completion.choices[0]?.message?.content ?? "";
}

/** Strips ```json fences models sometimes add despite instructions not to. */
export function stripFences(text: string): string {
  const trimmed = text.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return fenced ? fenced[1]! : trimmed;
}

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Confirmed live: with GROQ_API_KEY set (Tenfold's normal/default
// configuration — the LLM compiler path, not localCompile), "Press Enter"
// kept getting misclassified even after compilePlan.ts's system prompt was
// updated to explicitly document the new "press" intent. This is exactly
// the class of problem detectApplyCouponLine/detectClickAndConfirmLine
// already exist to guard against: a brand-new intent with no few-shot
// example in the prompt is easy for an LLM to silently ignore under
// sampling variance, even at temperature 0. This test mocks chatJson to
// return exactly the WRONG classification that reproduced the live bug
// (intent "click", target "Enter" — there is no such element) and confirms
// detectPressLine's deterministic override in compilePlan.ts still wins
// outright over it, regardless of what the LLM said.
vi.mock("../src/llm/groq.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/llm/groq.js")>();
  return {
    ...actual,
    getGroqClient: () => ({}) as any, // truthy — compilePlan only checks this is non-null
    chatJson: async ({ user }: { user: string }) => {
      // Build one step per input line, deliberately misclassifying any
      // "Press Enter"-shaped line as a click on a literal "Enter" target —
      // the exact wrong output confirmed live, reproduced here on purpose.
      const lines = user
        .split("\n")
        .filter((l) => /^\d+\.\s/.test(l))
        .map((l) => l.replace(/^\d+\.\s/, ""));
      const steps = lines.map((line) => {
        if (/^press enter$/i.test(line.trim())) {
          return { text: line, intent: "click", target: "Enter", expect: "Enter is clicked" };
        }
        if (/^click/i.test(line)) {
          return { text: line, intent: "click", target: line.replace(/^click\s+/i, ""), expect: "click succeeds" };
        }
        if (/^type/i.test(line)) {
          const m = line.match(/"([^"]+)"/);
          return { text: line, intent: "type", target: "input", value: m?.[1] ?? "", expect: "value accepted" };
        }
        return { text: line, intent: "assert", expect: "condition holds" };
      });
      return JSON.stringify({ steps });
    },
  };
});

const ORIGINAL_KEY = process.env.GROQ_API_KEY;
beforeEach(() => {
  process.env.GROQ_API_KEY = "test-key-for-mocked-llm-path";
});
afterEach(() => {
  if (ORIGINAL_KEY === undefined) delete process.env.GROQ_API_KEY;
  else process.env.GROQ_API_KEY = ORIGINAL_KEY;
});

describe("compilePlan — deterministic press override rescues a misclassifying LLM", () => {
  it('overrides the LLM\'s wrong "click Enter" classification with the correct "press" intent', async () => {
    const { compilePlan } = await import("../src/plan/compilePlan.js");
    const plan = await compilePlan(
      ["Click the search button", 'Type "array methods" into the search input', "Press Enter"],
      "https://developer.mozilla.org/en-US/",
    );

    const pressStep = plan.steps.find((s) => s.text === "Press Enter");
    expect(pressStep).toMatchObject({ intent: "press", value: "Enter" });
    // Confirms the override actually replaced the LLM's step object, not
    // just patched one field onto it — no stray "Enter" click target left
    // over from the mocked wrong classification.
    expect(pressStep!.target).toBeUndefined();
  });
});

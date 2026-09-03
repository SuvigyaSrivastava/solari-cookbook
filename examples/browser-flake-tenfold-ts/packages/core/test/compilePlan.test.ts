import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { compilePlan } from "../src/plan/compilePlan.js";

// GROQ_API_KEY must be unset for these tests so compilePlan deterministically
// falls back to localCompile — that's what actually lets this test exercise
// the exact reported bug without mocking an LLM: the failure was never about
// what the LLM chooses to classify a line as, it was that NEITHER compiler
// path guarantees a navigate step exists at all.
const ORIGINAL_KEY = process.env.GROQ_API_KEY;
beforeEach(() => {
  delete process.env.GROQ_API_KEY;
});
afterEach(() => {
  if (ORIGINAL_KEY !== undefined) process.env.GROQ_API_KEY = ORIGINAL_KEY;
});

describe("compilePlan — implicit navigate guarantee", () => {
  it("prepends a navigate step when no line in the plan asks to go anywhere", async () => {
    // The exact plan that triggered this live: three click/type/type lines,
    // none matching "open/navigate to/go to/visit" — confirmed via replay
    // that the browser sat at about:blank for the whole run and step 0
    // failed with ELEMENT_NOT_FOUND because there was nothing on the page.
    const plan = await compilePlan(
      ["Click the search button", 'Type "playwright" into the search input', "Press Enter"],
      "https://github.com",
    );

    expect(plan.steps[0]).toMatchObject({ intent: "navigate", value: "https://github.com", index: 0 });
    expect(plan.steps).toHaveLength(4); // 1 implicit navigate + the original 3 lines
    expect(plan.steps[1]!.text).toBe("Click the search button");
    // "Press Enter" must compile as a "press" intent (a real key sent via
    // page.keyboard.press), not a click on a nonexistent "Enter" element —
    // the latter was confirmed live to silently never submit the search at
    // all, since resolveTarget has no element literally named "Enter" to
    // find.
    expect(plan.steps[3]).toMatchObject({ intent: "press", value: "Enter" });
    // Every step's `index` must match its array position after the prepend —
    // a stale index would misattribute the first-failure histogram.
    plan.steps.forEach((s, i) => expect(s.index).toBe(i));
  });

  it("does not add a second navigate step when the plan already opens with one", async () => {
    const plan = await compilePlan(
      ["Open the homepage", "Click Sign in", "Confirm the dashboard is visible"],
      "https://example.com",
    );
    expect(plan.steps).toHaveLength(3);
    expect(plan.steps[0]).toMatchObject({ intent: "navigate" });
    expect(plan.steps.filter((s) => s.intent === "navigate")).toHaveLength(1);
  });

  it("still prepends navigate when the only navigate-shaped line isn't first", async () => {
    // localCompile's own navigate detection only fires unconditionally for
    // i === 0; a later "go to X" line without a leading verb match at index
    // 0 is exactly the gap this guarantee needs to cover regardless of cause.
    const plan = await compilePlan(
      ["Click Sign in", "Type foo@bar.com into the email field", "Go to the cart"],
      "https://example.com",
    );
    expect(plan.steps[0]).toMatchObject({ intent: "navigate", value: "https://example.com" });
  });

  it("accepts a full 12-line plan with no navigate line without exceeding the schema's step cap", async () => {
    // TestPlanSchema.steps caps at 13 specifically so a maximal 12-line user
    // plan plus one implicit navigate step still validates — this is the
    // boundary case that cap exists for.
    const lines = Array.from({ length: 12 }, (_, i) => `Click button ${i}`);
    const plan = await compilePlan(lines, "https://example.com");
    expect(plan.steps).toHaveLength(13);
    expect(plan.steps[0]!.intent).toBe("navigate");
  });
});

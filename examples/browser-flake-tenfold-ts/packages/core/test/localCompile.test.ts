import { describe, expect, it } from "vitest";
import { localCompile } from "../src/plan/localCompile.js";

describe("localCompile", () => {
  it("compiles the canonical Flakemart demo plan into 5 steps with the right intents", () => {
    const lines = [
      "Open the homepage",
      `Add "Blue Hoodie" to the cart`,
      "Go to the cart and apply coupon SAVE10",
      "Confirm the total shows a 10% discount",
      "Click Checkout and confirm an order number appears",
    ];
    const steps = localCompile(lines, "https://flakemart.example.com");

    expect(steps).toHaveLength(5);
    expect(steps[0]).toMatchObject({ intent: "navigate", value: "https://flakemart.example.com" });
    expect(steps[1]).toMatchObject({ intent: "click", target: "Blue Hoodie" });
    expect(steps[2]).toMatchObject({ intent: "type", value: "SAVE10" });
    expect(steps[3]).toMatchObject({ intent: "assert" });
    expect(steps[3]!.expect).toContain("10%");
    expect(steps[4]).toMatchObject({ intent: "click", target: "Checkout" });
    expect(steps[4]!.expect.toLowerCase()).toContain("order number");
  });

  it("always produces a non-empty expect for every step", () => {
    const lines = ["Open the site", "Click Sign in", "Type foo@bar.com", "Wait", "Confirm dashboard is visible"];
    const steps = localCompile(lines, "https://example.com");
    for (const step of steps) {
      expect(step.expect.length).toBeGreaterThan(0);
    }
  });

  it("preserves the original English text verbatim on every step", () => {
    const lines = ['Click "Sign in"', "Confirm the welcome banner is shown"];
    const steps = localCompile(lines, "https://example.com");
    expect(steps[0]!.text).toBe('Click "Sign in"');
    expect(steps[1]!.text).toBe("Confirm the welcome banner is shown");
  });

  // Confirmed live as a real, silent bug: "Press Enter" used to fall through
  // to the default "click" branch (target "Enter", since stripLeadingVerb
  // already knew "press" as a strippable verb) — there is no element named
  // "Enter" to click, so the key was never actually sent to the page. A real
  // MDN replay showed the search input received "array methods" correctly,
  // but no navigation and no keyboard event ever followed — the search was
  // simply never submitted, and every later assert failed against the
  // still-open autocomplete dropdown.
  it('compiles "Press Enter" as a "press" intent, not a click on a nonexistent "Enter" element', () => {
    const steps = localCompile(["Press Enter"], "https://example.com");
    expect(steps[0]).toMatchObject({ intent: "press", value: "Enter" });
    expect(steps[0]!.target).toBeUndefined();
  });

  it('also recognizes "Hit Tab" and "Press Escape" as press steps with the right key name', () => {
    const [tabStep] = localCompile(["Hit Tab"], "https://example.com");
    expect(tabStep).toMatchObject({ intent: "press", value: "Tab" });

    const [escStep] = localCompile(["Press Escape"], "https://example.com");
    expect(escStep).toMatchObject({ intent: "press", value: "Escape" });
  });

  it('does not misclassify a click line that happens to contain the word "enter" elsewhere', () => {
    // Guard against an overly greedy regex: "Enter your email" is a type-shaped
    // instruction, not a "press Enter" key-press, and must still compile as such.
    const [step] = localCompile(["Enter your email address"], "https://example.com");
    expect(step!.intent).toBe("type");
  });
});

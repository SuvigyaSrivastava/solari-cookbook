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
});

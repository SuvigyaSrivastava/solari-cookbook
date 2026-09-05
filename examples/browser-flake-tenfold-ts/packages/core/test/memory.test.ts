import { describe, expect, it } from "vitest";
import { simhash, hammingDistance } from "../src/memory/simhash.js";
import { InMemoryStepMemoryStore } from "../src/memory/store.js";
import { stepTextHash, hostOf } from "../src/memory/applyMemory.js";
import { analyze } from "../src/analyze/index.js";
import type { RunResult, TestPlan } from "../src/types.js";

describe("simhash", () => {
  it("gives identical text a Hamming distance of 0", () => {
    const a = simhash("button Add Blue Hoodie to Cart");
    const b = simhash("button Add Blue Hoodie to Cart");
    expect(hammingDistance(a, b)).toBe(0);
  });

  it("gives near-identical text (one word changed) a small Hamming distance", () => {
    const a = simhash("button Add Blue Hoodie to Cart, link Checkout, link Cart");
    const b = simhash("button Add Blue Hoodie to Bag, link Checkout, link Cart");
    // Not zero (the text did change) but nowhere near the 64-bit max —
    // this is the whole point of simhash over a cryptographic hash.
    expect(hammingDistance(a, b)).toBeGreaterThan(0);
    expect(hammingDistance(a, b)).toBeLessThan(20);
  });

  it("gives substantially different text a larger Hamming distance", () => {
    const a = simhash("a small aria snapshot with a few buttons and links");
    const b = simhash("completely restructured page content nothing shared here at all zzz qqq xyz");
    const nearIdentical = hammingDistance(simhash("same text"), simhash("same text"));
    expect(hammingDistance(a, b)).toBeGreaterThan(nearIdentical);
  });
});

describe("stepTextHash", () => {
  it("is stable across whitespace and case differences", () => {
    const a = stepTextHash("Click  the   Checkout button");
    const b = stepTextHash("click the checkout button");
    expect(a).toBe(b);
  });

  it("differs for different text", () => {
    expect(stepTextHash("Click Checkout")).not.toBe(stepTextHash("Click Cart"));
  });
});

describe("hostOf", () => {
  it("extracts just the hostname", () => {
    expect(hostOf("https://flakemart.example.com/cart?add=x")).toBe("flakemart.example.com");
  });

  it("falls back to the raw input for an unparsable URL", () => {
    expect(hostOf("not-a-url")).toBe("not-a-url");
  });
});

describe("InMemoryStepMemoryStore", () => {
  it("returns null for an unknown (host, step) pair", async () => {
    const store = new InMemoryStepMemoryStore();
    expect(await store.get("example.com", "deadbeef")).toBeNull();
  });

  it("records a hit and increments hits without touching misses", async () => {
    const store = new InMemoryStepMemoryStore();
    const base = {
      targetHost: "example.com",
      stepTextHash: "abc123",
      locator: { kind: "role" as const, role: "button", name: "Checkout" },
      fingerprint: "0".repeat(16),
    };
    await store.recordSuccess(base, false); // first time: a "learn", not a hit
    await store.recordSuccess(base, true); // second run: reused successfully
    const entry = await store.get("example.com", "abc123");
    expect(entry?.hits).toBe(1);
    expect(entry?.misses).toBe(1);
    expect(entry?.locator).toEqual(base.locator);
  });

  it("keeps memory separate per target host", async () => {
    const store = new InMemoryStepMemoryStore();
    const hash = stepTextHash("Click Checkout");
    await store.recordSuccess(
      { targetHost: "a.com", stepTextHash: hash, locator: { kind: "text", text: "Checkout" }, fingerprint: "0" },
      false,
    );
    expect(await store.get("b.com", hash)).toBeNull();
    expect(await store.get("a.com", hash)).not.toBeNull();
  });
});

describe("analyze — Workflow Memory summary", () => {
  const plan: TestPlan = {
    targetUrl: "https://example.com",
    steps: [],
    runs: 2,
    hardDeadlineMs: 120_000,
    options: { stealth: true, captcha: false },
  };

  function makeRun(memoryTags: Array<"reused" | "learned" | "relearned" | undefined>): RunResult {
    return {
      runIndex: 0,
      status: "passed",
      steps: memoryTags.map((memory, index) => ({
        index,
        text: `step ${index}`,
        status: "passed",
        durationMs: 100,
        memory,
      })),
      firstFailureStep: null,
      cause: null,
      sessionId: null,
      replayUrl: null,
      replayStatus: "disabled",
      startedAt: new Date().toISOString(),
      endedAt: new Date().toISOString(),
      durationMs: 500,
      browserHours: 0,
      captchaSolves: 0,
      degraded: false,
    };
  }

  it("omits the memory block entirely when memory was disabled", () => {
    const report = analyze("r1", plan, [makeRun(["learned", "reused"])], "mock", false);
    expect(report.memory).toBeUndefined();
  });

  it("counts reused vs learned/relearned and computes cost reduction", () => {
    // Run 1: two brand-new steps, both "learned" (first time). Run 2: same
    // two steps, both "reused" from what run 1 wrote — the exact shape a
    // real second Tenfold run produces.
    const report = analyze(
      "r2",
      plan,
      [makeRun(["learned", "learned"]), makeRun(["reused", "reused"])],
      "mock",
      true,
    );
    expect(report.memory).toBeDefined();
    expect(report.memory!.reused).toBe(2);
    expect(report.memory!.relearned).toBe(0);
    expect(report.memory!.resolverCallsMade).toBe(2); // the two "learned" steps
    expect(report.memory!.resolverCallsBaseline).toBe(4); // 2 steps x 2 runs
    expect(report.memory!.costReductionPct).toBe(50);
  });

  it("counts a re-learned step separately from a first-time learn", () => {
    const report = analyze("r3", plan, [makeRun(["reused", "relearned"])], "mock", true);
    expect(report.memory!.reused).toBe(1);
    expect(report.memory!.relearned).toBe(1);
    expect(report.memory!.resolverCallsMade).toBe(1);
  });
});

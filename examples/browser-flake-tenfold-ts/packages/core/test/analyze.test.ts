import { describe, expect, it } from "vitest";
import { analyze } from "../src/analyze/index.js";
import type { RunResult, TestPlan } from "../src/types.js";

function makeRun(overrides: Partial<RunResult>): RunResult {
  return {
    runIndex: 0,
    status: "passed",
    steps: [],
    firstFailureStep: null,
    cause: null,
    sessionId: null,
    replayUrl: null,
    replayStatus: "disabled",
    startedAt: new Date().toISOString(),
    endedAt: new Date().toISOString(),
    durationMs: 1000,
    browserHours: 1000 / 3_600_000,
    captchaSolves: 0,
    ...overrides,
  };
}

const plan: TestPlan = {
  targetUrl: "https://example.com",
  steps: [],
  runs: 10,
  hardDeadlineMs: 120_000,
  options: { stealth: true, captcha: false },
};

describe("analyze", () => {
  it("labels a run with zero failures STABLE", () => {
    const perRun = Array.from({ length: 10 }, () => makeRun({}));
    const report = analyze("r1", plan, perRun, "mock");
    expect(report.verdict).toBe("STABLE");
    expect(report.passRate).toBe(1);
  });

  it("labels a run with some but not all failures FLAKY, and buckets own-misses separately", () => {
    const perRun = [
      ...Array.from({ length: 8 }, () => makeRun({})),
      makeRun({ status: "failed", firstFailureStep: 3, cause: "ASSERTION_FAILED" }),
      makeRun({ status: "error", firstFailureStep: 0, cause: "RESOLVER_ERROR" }),
    ];
    const report = analyze("r2", plan, perRun, "mock");
    expect(report.verdict).toBe("FLAKY");
    expect(report.passed).toBe(8);
    expect(report.failed).toBe(2);
    expect(report.causeBreakdown.ASSERTION_FAILED).toBe(1);
    expect(report.causeBreakdown.RESOLVER_ERROR).toBe(1);
    // The resolver error is Tenfold's own miss — it must not be silently
    // folded into "the site is flaky" without the caveat (brief §4.4).
    expect(report.ownMisses).toBe(1);
    expect(report.firstFailureHistogram[3]).toBe(1);
  });

  it("labels a run with zero passes BROKEN", () => {
    const perRun = Array.from({ length: 5 }, () =>
      makeRun({ status: "failed", firstFailureStep: 1, cause: "TIMEOUT" }),
    );
    const report = analyze("r3", plan, perRun, "mock");
    expect(report.verdict).toBe("BROKEN");
    expect(report.passRate).toBe(0);
  });

  it("computes cost from browser-hours at $0.10/hr", () => {
    const oneHourRun = makeRun({ durationMs: 3_600_000, browserHours: 1 });
    const report = analyze("r4", plan, [oneHourRun], "live");
    expect(report.cost.usd).toBeCloseTo(0.1, 5);
  });
});

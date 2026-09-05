import { describe, expect, it } from "vitest";
import type { SolariClient, SolariSession } from "../src/solari/types.js";
import type { RunResult, TestPlan } from "../src/types.js";
import { executeRun } from "../src/execute/executeRun.js";
import { analyze } from "../src/analyze/index.js";

// Confirmed live against the real Render deploy: a free-tier Solari key
// asked for stealth+proxy (shouldDefaultProxy() defaulting `proxy: "us"` on
// for a real external target — see runJob.ts) gets `402 FeatureRequiresPlan`
// back, and live.ts's own documented fallback (see its comment) silently
// retries plain — `session.degraded` is already `true` at that point (see
// liveDegradedRetry.test.ts), but until this fix, executeRun only logged it
// with console.warn and threw it away rather than putting it on the
// RunResult it returns. The observable, misleading symptom: a report full
// of NAVIGATION_ERROR/403s against a real bot-protected target (confirmed
// live against https://www.scrapingcourse.com/antibot-challenge, 10/10
// runs) whose own suggested fix ("try enabling the residential proxy
// option") had ALREADY been tried and silently stripped — indistinguishable
// in the report from Solari's stealth mode simply not working. This test
// pins `degraded` all the way through executeRun's RunResult and analyze's
// aggregate TenfoldReport.degradedRuns, so that distinction is visible
// where a user actually reads it instead of only in a server-side log.
describe("executeRun / analyze — a degraded session launch is surfaced in the report", () => {
  function degradedClient(): SolariClient {
    const session: SolariSession = {
      page: {} as SolariSession["page"],
      sessionId: "degraded-session",
      mode: "live",
      recordingEnabled: true,
      degraded: true, // exactly what live.ts sets after its 402 fallback
      async release() {
        return { replayUrl: null, replayStatus: "disabled" as const };
      },
    };
    return {
      mode: "live",
      async launch() {
        return session;
      },
    };
  }

  const plan: TestPlan = {
    targetUrl: "https://example.com",
    steps: [
      {
        index: 0,
        text: "Confirm the page loaded",
        intent: "assert",
        value: undefined,
        target: undefined,
        expect: "the page loaded",
      },
    ],
    runs: 1,
    hardDeadlineMs: 5000,
    options: { stealth: true, captcha: false, proxy: "us" },
  };

  it("carries session.degraded through onto the returned RunResult", async () => {
    const result = await executeRun(plan, degradedClient(), 0);
    expect(result.degraded).toBe(true);
  });

  it("defaults to false for a clean, non-degraded session", async () => {
    const cleanSession: SolariSession = {
      page: {} as SolariSession["page"],
      sessionId: "clean-session",
      mode: "live",
      recordingEnabled: true,
      degraded: false,
      async release() {
        return { replayUrl: null, replayStatus: "disabled" as const };
      },
    };
    const client: SolariClient = { mode: "live", async launch() { return cleanSession; } };
    const result = await executeRun(plan, client, 0);
    expect(result.degraded).toBe(false);
  });

  it("rolls per-run degraded flags up into TenfoldReport.degradedRuns", () => {
    const base: RunResult = {
      runIndex: 0,
      status: "failed",
      steps: [],
      firstFailureStep: 0,
      cause: "NAVIGATION_ERROR",
      sessionId: null,
      replayUrl: null,
      replayStatus: "disabled",
      startedAt: new Date().toISOString(),
      endedAt: new Date().toISOString(),
      durationMs: 100,
      browserHours: 0,
      captchaSolves: 0,
      degraded: false,
    };
    const perRun: RunResult[] = [
      { ...base, runIndex: 0, degraded: true },
      { ...base, runIndex: 1, degraded: true },
      { ...base, runIndex: 2, degraded: false },
    ];
    const report = analyze("r1", plan, perRun, "live", false);
    expect(report.degradedRuns).toBe(2);
    expect(report.runs).toBe(3);
  });
});

import type { Cause, RunResult, TenfoldReport, TestPlan, Verdict } from "../types.js";
import { OWN_MISS_CAUSES } from "../types.js";
import { browserHoursToUsd, SOLARI_CAPTCHA_USD_PER_SOLVE } from "../solari/index.js";

const ALL_CAUSES: Cause[] = [
  "TIMEOUT",
  "ELEMENT_NOT_FOUND",
  "ASSERTION_FAILED",
  "NAVIGATION_ERROR",
  "CAPTCHA_BLOCKED",
  "RESOLVER_ERROR",
  "INFRA_ERROR",
];

const REPLAY_RETENTION_DAYS = 7;

/**
 * Turns raw per-browser RunResults into the report a human actually reads.
 * The one rule that matters most here (§4.4): RESOLVER_ERROR and
 * INFRA_ERROR are Tenfold's own misses, not the target site's flakiness —
 * they're counted separately (`ownMisses`) and must never be folded into
 * the headline pass rate's implied "cause" without that caveat.
 */
export function analyze(
  runId: string,
  plan: TestPlan,
  perRun: RunResult[],
  mode: "live" | "mock",
  memoryEnabled = false,
): TenfoldReport {
  const runs = perRun.length;
  const passed = perRun.filter((r) => r.status === "passed").length;
  const failed = runs - passed;
  const passRate = runs > 0 ? passed / runs : 0;

  const verdict: Verdict = failed === 0 ? "STABLE" : passed === 0 ? "BROKEN" : "FLAKY";

  const firstFailureHistogram: Record<number, number> = {};
  const causeBreakdown = Object.fromEntries(ALL_CAUSES.map((c) => [c, 0])) as Record<Cause, number>;

  for (const run of perRun) {
    if (run.firstFailureStep !== null) {
      firstFailureHistogram[run.firstFailureStep] = (firstFailureHistogram[run.firstFailureStep] ?? 0) + 1;
    }
    if (run.cause) causeBreakdown[run.cause] += 1;
  }

  const ownMisses = OWN_MISS_CAUSES.reduce((sum, c) => sum + causeBreakdown[c], 0);
  const degradedRuns = perRun.filter((r) => r.degraded).length;

  const browserHours = perRun.reduce((sum, r) => sum + r.browserHours, 0);
  const captchaSolves = perRun.reduce((sum, r) => sum + r.captchaSolves, 0);
  const usd = browserHoursToUsd(browserHours) + captchaSolves * SOLARI_CAPTCHA_USD_PER_SOLVE;

  const durations = perRun.map((r) => r.durationMs).sort((a, b) => a - b);
  const p50Ms = percentile(durations, 0.5);
  const p95Ms = percentile(durations, 0.95);

  const createdAt = new Date();
  const replaysExpireAt = new Date(createdAt.getTime() + REPLAY_RETENTION_DAYS * 24 * 60 * 60 * 1000);

  return {
    runId,
    plan,
    passed,
    failed,
    runs,
    passRate,
    verdict,
    firstFailureHistogram,
    causeBreakdown,
    ownMisses,
    degradedRuns,
    perRun,
    cost: { browserHours, usd, captchaSolves },
    timing: { p50Ms, p95Ms },
    createdAt: createdAt.toISOString(),
    replaysExpireAt: replaysExpireAt.toISOString(),
    mode,
    memory: memoryEnabled ? summarizeMemory(perRun) : undefined,
  };
}

/**
 * Workflow Memory (§11.3): "Reused 4/5 steps from memory · re-learned step
 * 3 (page structure changed) · LLM calls: 2 (was 10 on first run) ·
 * resolver cost down 80%". `resolverCallsMade` counts only "learned"/
 * "relearned" steps — a "reused" step is exactly the resolver call this
 * system exists to skip. `resolverCallsBaseline` is what every run would
 * have cost with memory off: one resolver call per (targeted step × run).
 */
function summarizeMemory(perRun: RunResult[]): NonNullable<TenfoldReport["memory"]> {
  let reused = 0;
  let relearned = 0;
  let resolverCallsMade = 0;
  let resolverCallsBaseline = 0;

  for (const run of perRun) {
    for (const step of run.steps) {
      if (!step.memory || step.memory === "resolved") continue;
      resolverCallsBaseline += 1;
      if (step.memory === "reused") {
        reused += 1;
      } else {
        // "learned" (first time) or "relearned" (memory existed but was
        // distrusted) both paid for a fresh resolve.
        resolverCallsMade += 1;
        if (step.memory === "relearned") relearned += 1;
      }
    }
  }

  const costReductionPct =
    resolverCallsBaseline > 0 ? Math.round((1 - resolverCallsMade / resolverCallsBaseline) * 100) : 0;

  return { reused, relearned, resolverCallsMade, resolverCallsBaseline, costReductionPct };
}

function percentile(sortedAsc: number[], p: number): number {
  if (sortedAsc.length === 0) return 0;
  const idx = Math.min(sortedAsc.length - 1, Math.floor(p * sortedAsc.length));
  return sortedAsc[idx]!;
}

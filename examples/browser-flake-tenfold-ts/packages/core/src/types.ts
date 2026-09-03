import { z } from "zod";

// ---------------------------------------------------------------------------
// Step / TestPlan
// ---------------------------------------------------------------------------

export const StepIntent = z.enum([
  "navigate",
  "click",
  "type",
  "select",
  "wait",
  "assert",
]);
export type StepIntent = z.infer<typeof StepIntent>;

export const StepSchema = z.object({
  index: z.number().int().min(0),
  text: z.string().min(1), // original English line, always preserved
  intent: StepIntent,
  target: z.string().optional(), // natural-language description of the element
  value: z.string().optional(), // text to type / option to choose / URL
  expect: z.string().min(1), // natural-language success condition
});
export type Step = z.infer<typeof StepSchema>;

export const TestPlanOptionsSchema = z.object({
  stealth: z.boolean().default(true),
  captcha: z.boolean().default(false),
  proxy: z.enum(["us"]).optional(),
  profileId: z.string().optional(), // P1 — reuse logged-in session across runs
});
export type TestPlanOptions = z.infer<typeof TestPlanOptionsSchema>;

export const TestPlanSchema = z.object({
  targetUrl: z.string().url(),
  steps: z.array(StepSchema).min(1).max(12),
  runs: z.number().int().min(1).max(15).default(10),
  hardDeadlineMs: z.number().int().positive().default(120_000),
  options: TestPlanOptionsSchema.default({ stealth: true, captcha: false }),
});
export type TestPlan = z.infer<typeof TestPlanSchema>;

// The shape the LLM is asked to return — same as Step but without `index`,
// which we assign deterministically from array position after validation.
export const CompiledStepSchema = StepSchema.omit({ index: true });
export type CompiledStep = z.infer<typeof CompiledStepSchema>;

export const CompiledPlanSchema = z.object({
  steps: z.array(CompiledStepSchema).min(1).max(12),
});

// ---------------------------------------------------------------------------
// Failure taxonomy
// ---------------------------------------------------------------------------

export const Cause = z.enum([
  "TIMEOUT",
  "ELEMENT_NOT_FOUND",
  "ASSERTION_FAILED",
  "NAVIGATION_ERROR",
  "CAPTCHA_BLOCKED",
  "RESOLVER_ERROR", // Tenfold's own miss
  "INFRA_ERROR", // Tenfold's own miss
  "NEEDS_HUMAN", // Workflow Memory (§11.2 step 4): reuse AND a fresh re-learn both failed
]);
export type Cause = z.infer<typeof Cause>;

export const OWN_MISS_CAUSES: readonly Cause[] = [
  "RESOLVER_ERROR",
  "INFRA_ERROR",
];

// ---------------------------------------------------------------------------
// Execution results
// ---------------------------------------------------------------------------

export type StepStatus = "passed" | "failed" | "skipped";

/**
 * Workflow Memory (§11) provenance for one step's target resolution:
 * "reused" skipped the resolver entirely using a remembered locator;
 * "learned" is the first time this (site, step) has ever been seen, so it
 * paid for a fresh resolve and will write a brand-new memory row;
 * "relearned" HAD a memory row but distrusted it (fingerprint drift, or the
 * remembered locator no longer matches exactly one element) and paid for a
 * fresh resolve to overwrite it; "resolved" means no memory store was wired
 * in for this run at all (memory disabled) — not counted in report stats.
 */
export type MemorySource = "reused" | "learned" | "relearned" | "resolved";

export interface StepResult {
  index: number;
  text: string;
  status: StepStatus;
  durationMs: number;
  cause?: Cause;
  reason?: string;
  screenshotPath?: string;
  /** Workflow Memory (§11): how this step's target was resolved, if it had one. */
  memory?: MemorySource;
  relearnReason?: string;
}

export type RunStatus = "passed" | "failed" | "error";
export type ReplayStatus = "disabled" | "pending" | "ready" | "failed" | "expired";

export interface RunResult {
  runIndex: number;
  status: RunStatus;
  steps: StepResult[];
  firstFailureStep: number | null;
  cause: Cause | null;
  sessionId: string | null;
  replayUrl: string | null;
  replayStatus: ReplayStatus;
  startedAt: string;
  endedAt: string;
  durationMs: number;
  browserHours: number;
  captchaSolves: number;
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

export type Verdict = "STABLE" | "FLAKY" | "BROKEN";

export interface TenfoldReport {
  runId: string;
  plan: TestPlan;
  passed: number;
  failed: number;
  runs: number;
  passRate: number; // 0..1
  verdict: Verdict;
  firstFailureHistogram: Record<number, number>; // step index -> count
  causeBreakdown: Record<Cause, number>;
  ownMisses: number;
  perRun: RunResult[];
  cost: {
    browserHours: number;
    usd: number;
    captchaSolves: number;
  };
  timing: {
    p50Ms: number;
    p95Ms: number;
  };
  createdAt: string;
  replaysExpireAt: string;
  mode: "live" | "mock";
  /**
   * Workflow Memory (§11.3): "Reused 4/5 steps from memory · re-learned
   * step 3 · LLM calls: 2 (was 10 on first run) · resolver cost ↓ 80%".
   * Omitted entirely when no memory store was wired in for this run (e.g.
   * navigate/wait/assert-only plans, or memory explicitly disabled).
   */
  memory?: {
    reused: number;
    relearned: number;
    resolverCallsMade: number;
    resolverCallsBaseline: number; // what it would have been with memory off
    costReductionPct: number; // 0..100, relative to resolverCallsBaseline
  };
}

// ---------------------------------------------------------------------------
// Progress events (SSE)
// ---------------------------------------------------------------------------

export type TenfoldEvent =
  | { type: "run.started"; runId: string; runIndex: number; at: string }
  | {
      type: "step.started";
      runId: string;
      runIndex: number;
      stepIndex: number;
      text: string;
      at: string;
    }
  | {
      type: "step.completed";
      runId: string;
      runIndex: number;
      step: StepResult;
      at: string;
    }
  | {
      type: "run.finished";
      runId: string;
      runIndex: number;
      result: RunResult;
      at: string;
    }
  | {
      type: "replay.ready";
      runId: string;
      runIndex: number;
      replayUrl: string;
      at: string;
    }
  | {
      type: "step.relearned";
      runId: string;
      runIndex: number;
      stepIndex: number;
      reason: string;
      at: string;
    }
  | { type: "report.ready"; runId: string; report: TenfoldReport; at: string };

// ---------------------------------------------------------------------------
// Solari launch options (thin, only what we use)
// ---------------------------------------------------------------------------

export interface SolariLaunchOptions {
  stealth?: boolean;
  recording?: boolean;
  proxy?: "us";
  captcha?: boolean;
  profileId?: string;
}

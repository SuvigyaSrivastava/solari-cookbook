import { randomUUID } from "node:crypto";
import type { RunResult, TenfoldEvent, TenfoldReport, TestPlan } from "../types.js";
import type { SolariClient } from "../solari/types.js";
import type { MemoryContext } from "../memory/applyMemory.js";
import { executeRun } from "../execute/executeRun.js";
import { analyze } from "../analyze/index.js";

export interface RunTenfoldOptions {
  runId?: string;
  screenshotDir?: string;
  staggerMs?: number;
  onEvent?: (event: TenfoldEvent) => void;
  mode: "live" | "mock";
  /** Workflow Memory (§11) — omit entirely to run with memory disabled. */
  memory?: MemoryContext;
  /**
   * Caps how many browser sessions are open at once across this one
   * Tenfold run. `staggerMs` alone only delays *launches* — with a typical
   * multi-second session duration, staggered launches still overlap well
   * past a low concurrency cap. This matters specifically for live mode:
   * Solari's Free plan caps concurrent sessions at 3 (confirmed live via
   * `429 ConcurrencyLimitExceeded`), so firing all `plan.runs` launches at
   * once against a free-tier key fails most of them outright rather than
   * queuing. Mock mode has no such external limit, so this defaults to
   * `Infinity` (no queuing) unless a caller opts in.
   */
  maxConcurrency?: number;
}

/** Minimal counting semaphore — see apps/runner/src/concurrency.ts, which
 * this mirrors, for the demo/BYOK run-level version of the same idea. This
 * one bounds concurrent *browser sessions within* a single Tenfold run. */
function createSemaphore(limit: number) {
  let active = 0;
  const queue: Array<() => void> = [];

  async function acquire(): Promise<() => void> {
    if (active >= limit) {
      await new Promise<void>((resolve) => queue.push(resolve));
    }
    active++;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      active--;
      const next = queue.shift();
      if (next) next();
    };
  }

  return { acquire };
}

/**
 * Fans a compiled TestPlan out across N independent Solari sessions.
 * `Promise.allSettled` + a per-run try/catch inside `executeRun` means one
 * browser throwing never cancels the others (§4.5). Launches are staggered
 * by `staggerMs` (default 250ms per §4.5) to avoid a thundering herd against
 * both Solari's launch endpoint and the target site.
 */
export async function runTenfold(plan: TestPlan, opts: RunTenfoldOptions, client: SolariClient): Promise<TenfoldReport> {
  const runId = opts.runId ?? randomUUID();
  const staggerMs = opts.staggerMs ?? 250;
  const emit = (event: TenfoldEvent) => opts.onEvent?.(event);
  const semaphore = createSemaphore(opts.maxConcurrency ?? Infinity);

  const launches = Array.from({ length: plan.runs }, (_, runIndex) =>
    delay(runIndex * staggerMs).then(async () => {
      const release = await semaphore.acquire();
      let result: RunResult;
      try {
        emit({ type: "run.started", runId, runIndex, at: new Date().toISOString() });
        result = await executeRun(plan, client, runIndex, {
          screenshotDir: opts.screenshotDir,
          memory: opts.memory,
          onStepCompleted: (step) => {
            emit({ type: "step.completed", runId, runIndex, step, at: new Date().toISOString() });
            if (step.memory === "relearned" && step.relearnReason) {
              emit({
                type: "step.relearned",
                runId,
                runIndex,
                stepIndex: step.index,
                reason: step.relearnReason,
                at: new Date().toISOString(),
              });
            }
          },
        });
      } finally {
        // Release the concurrency slot as soon as this run's browser
        // session is done (executeRun's own try/finally already closed
        // it) — reporting the result below doesn't need the slot held.
        release();
      }
      emit({ type: "run.finished", runId, runIndex, result, at: new Date().toISOString() });
      if (result.replayUrl) {
        emit({
          type: "replay.ready",
          runId,
          runIndex,
          replayUrl: result.replayUrl,
          at: new Date().toISOString(),
        });
      }
      return result;
    }),
  );

  const settled = await Promise.allSettled(launches);

  // Every session this client launched has now been individually released
  // (executeRun's own try/finally guarantees that). Close the *client*
  // itself exactly once, here — see solari/live.ts for why this is a
  // separate call from any one session's close().
  await client.close?.().catch(() => undefined);

  const perRun: RunResult[] = settled.map((s, runIndex) =>
    s.status === "fulfilled"
      ? s.value
      : {
          runIndex,
          status: "error",
          steps: [],
          firstFailureStep: 0,
          cause: "INFRA_ERROR",
          sessionId: null,
          replayUrl: null,
          replayStatus: "disabled",
          startedAt: new Date().toISOString(),
          endedAt: new Date().toISOString(),
          durationMs: 0,
          browserHours: 0,
          captchaSolves: 0,
        },
  );

  const report = analyze(runId, plan, perRun, opts.mode, Boolean(opts.memory));
  emit({ type: "report.ready", runId, report, at: new Date().toISOString() });
  return report;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

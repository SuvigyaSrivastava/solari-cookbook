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

  const launches = Array.from({ length: plan.runs }, (_, runIndex) =>
    delay(runIndex * staggerMs).then(async () => {
      emit({ type: "run.started", runId, runIndex, at: new Date().toISOString() });
      const result = await executeRun(plan, client, runIndex, {
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

import { compilePlan, createSolariClient, runTenfold, hostOf, type StepMemoryStore, type TestPlanOptions } from "@tenfold/core";
import type { Store } from "./store.js";
import { publish } from "./pubsub.js";
import { createSemaphore } from "./concurrency.js";
import { join } from "node:path";

const demoSemaphore = createSemaphore(1);
const byokSemaphore = createSemaphore(3);

const SCREENSHOT_ROOT = process.env.SCREENSHOT_DIR ?? "/tmp/tenfold-screens";

export interface StartRunInput {
  runId: string;
  targetUrl: string;
  steps: string[];
  runs?: number;
  options?: Partial<TestPlanOptions>;
  mode: "demo" | "byok";
  solariApiKey?: string;
}

/**
 * Kicks off compilation + fan-out for one run and returns immediately —
 * the caller (server.ts) has already inserted the `queued` row and responds
 * to the HTTP request before this promise settles. Every event is both
 * persisted (so a late SSE subscriber can replay history) and published
 * live (so an already-connected one gets it in real time).
 */
export function startRun(store: Store, stepMemoryStore: StepMemoryStore, input: StartRunInput): void {
  const semaphore = input.mode === "byok" ? byokSemaphore : demoSemaphore;

  void (async () => {
    const release = await semaphore.acquire();
    try {
      await store.updateRun(input.runId, { status: "running" });

      const plan = await compilePlan(input.steps, input.targetUrl, {
        runs: input.runs,
        options: input.options,
      });
      await store.updateRun(input.runId, { plan });

      const client = createSolariClient(input.solariApiKey ?? null);
      const screenshotDir = join(SCREENSHOT_ROOT, input.runId);

      const report = await runTenfold(
        plan,
        {
          runId: input.runId,
          mode: client.mode,
          screenshotDir,
          memory: {
            store: stepMemoryStore,
            targetHost: hostOf(input.targetUrl),
            fingerprintThresholdBits: Number(process.env.MEMORY_FINGERPRINT_THRESHOLD_BITS ?? 12),
          },
          onEvent: (event) => {
            void store.appendEvent(input.runId, event);
            publish(input.runId, event);
          },
        },
        client,
      );

      await store.updateRun(input.runId, {
        status: "done",
        report,
        costUsd: report.cost.usd,
        finishedAt: new Date().toISOString(),
      });
      if (input.mode === "demo") {
        await store.addSpend(report.cost.usd);
      }
    } catch (err) {
      await store.updateRun(input.runId, {
        status: "error",
        error: err instanceof Error ? err.message : String(err),
        finishedAt: new Date().toISOString(),
      });
    } finally {
      release();
    }
  })();
}

export function screenshotPath(runId: string, runIndex: number, stepIndex: number): string {
  return join(SCREENSHOT_ROOT, runId, `run-${runIndex}-step-${stepIndex}.png`);
}

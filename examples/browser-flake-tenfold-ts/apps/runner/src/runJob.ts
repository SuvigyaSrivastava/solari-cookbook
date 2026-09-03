import {
  compilePlan,
  createSolariClient,
  runTenfold,
  hostOf,
  shouldDefaultProxy,
  type StepMemoryStore,
  type TestPlanOptions,
} from "@tenfold/core";
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

      // Real e-commerce and media sites (Amazon, eBay, IMDb, Stack
      // Overflow — all confirmed live) reject requests from datacenter IPs
      // outright with a bare HTTP 403, before any of Tenfold's own step
      // logic even runs. Every cloud browser, Solari included, launches
      // from exactly that kind of IP by default. A residential proxy is
      // the standard, well-known fix the whole browser-automation industry
      // uses for this — Solari already exposes it as `proxy: "us"` — but
      // it was previously opt-in only via "advanced options", so the
      // out-of-the-box experience against a real external site was a
      // silent, confusing 403 instead of a working test. Default it on for
      // any real external target (never for localhost/private targets,
      // where there's no bot wall to route around and the "us" proxy would
      // just be pointless extra latency); an explicit `options.proxy` from
      // the caller always wins.
      const options: Partial<TestPlanOptions> = {
        ...input.options,
        proxy: input.options?.proxy ?? (shouldDefaultProxy(input.targetUrl) ? "us" : undefined),
      };

      const plan = await compilePlan(input.steps, input.targetUrl, {
        runs: input.runs,
        options,
      });
      await store.updateRun(input.runId, { plan });

      const client = createSolariClient(input.solariApiKey ?? null);
      const screenshotDir = join(SCREENSHOT_ROOT, input.runId);

      // Solari's Free plan caps concurrent sessions at 3 (confirmed live
      // via 429 ConcurrencyLimitExceeded); a paid plan or a BYOK caller on
      // a higher tier can raise this via MAX_CONCURRENT_SESSIONS. Mock mode
      // has no such external limit.
      const maxConcurrency =
        client.mode === "live" ? Number(process.env.MAX_CONCURRENT_SESSIONS ?? 3) : undefined;

      const report = await runTenfold(
        plan,
        {
          runId: input.runId,
          mode: client.mode,
          screenshotDir,
          maxConcurrency,
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
      // This only catches a whole-run failure (e.g. compilePlan throwing) —
      // per-step/per-browser errors are caught inside executeRun.ts and
      // turned into a normal ASSERTION_FAILED/INFRA_ERROR/etc. step result,
      // never reaching here. Both levels are worth a console.error: a
      // silent catch here previously meant a genuine infra problem (e.g.
      // @solarisdk/browser not installed, before it became a real
      // dependency) produced zero output in the runner's own terminal,
      // making a real, loud, well-messaged thrown Error look for all the
      // world like the request never arrived.
      console.error(`[tenfold-runner] run ${input.runId} failed:`, err);
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

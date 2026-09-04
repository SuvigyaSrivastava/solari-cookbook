import {
  compilePlan,
  createSolariClient,
  runTenfold,
  hostOf,
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
      // logic even runs. A residential proxy is the standard, well-known
      // fix — Solari exposes it as `proxy: "us"` — but Tenfold has no way
      // to know AHEAD of time whether a given external target actually
      // needs one: shouldDefaultProxy's only signal is "not a local/private
      // hostname", which is true for nearly every real site, bot-walled or
      // not (confirmed live: a plain MDN Web Docs run defaulted proxy on
      // via this exact logic, which forced stealth on too per live.ts, which
      // together exceeded a free-tier plan's limits and silently degraded
      // EVERY run to a plain, non-stealth session — for a target that never
      // needed a proxy at all and loads just fine without one).
      //
      // The two wrong defaults have asymmetric costs. Guessing "no proxy
      // needed" against a site that actually IS bot-walled fails loudly and
      // actionably: a bare NAVIGATION_ERROR/403 whose message (see live.ts's
      // isLikelyBotBlock handling in executeRun.ts) already tells the user
      // exactly what happened and to turn proxy on. Guessing "proxy needed"
      // against a site that ISN'T fails silently and confusingly instead —
      // a degraded-session warning in the runner's own console that has no
      // direct link to whatever downstream symptom it causes, which a user
      // reading a report full of ASSERTION_FAILED reasons has no way to
      // connect back to "your plan doesn't support stealth+proxy together."
      // Given that, defaulting proxy OFF and letting a real 403 (which is
      // rare, specific, and self-explanatory) be the signal to turn it on
      // is the safer default — an explicit `options.proxy` from the caller
      // still always wins either way.
      const options: Partial<TestPlanOptions> = { ...input.options };

      const plan = await compilePlan(input.steps, input.targetUrl, {
        runs: input.runs,
        options,
      });
      await store.updateRun(input.runId, { plan });

      const client = createSolariClient(input.solariApiKey ?? null);
      const screenshotDir = join(SCREENSHOT_ROOT, input.runId);

      // Solari's Free plan caps concurrent sessions at 3 (confirmed live
      // via 429 ConcurrencyLimitExceeded); a paid plan or a BYOK caller on
      // a higher tier can raise this via MAX_CONCURRENT_SESSIONS.
      //
      // Mock mode has no *external* limit like that, but it's not free of
      // limits either: it launches N real local Chromium processes on the
      // runner's own instance, and each one costs real RAM. Confirmed live
      // against this exact deploy — a 512MB Render free instance launching
      // 10 concurrent local Chromium processes for a mock-mode run got
      // OOM-killed mid-run ("Ran out of memory (used over 512MB)"),
      // dropping the report entirely instead of returning 10 clean
      // results. The old code left maxConcurrency `undefined` in mock mode
      // on the theory that only the *live* Solari API has a concurrency
      // limit to respect — true, but irrelevant: the constraint here is
      // the runner's own memory, not an external API's rate limit.
      const maxConcurrency = Number(
        process.env[client.mode === "live" ? "MAX_CONCURRENT_SESSIONS" : "MOCK_MAX_CONCURRENT_SESSIONS"] ??
          3,
      );

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

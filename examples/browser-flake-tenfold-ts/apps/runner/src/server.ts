import { Hono } from "hono";
import { cors } from "hono/cors";
import { streamSSE } from "hono/streaming";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { z } from "zod";
import type { StepMemoryStore } from "@tenfold/core";
import type { Store } from "./store.js";
import { startRun, screenshotPath } from "./runJob.js";
import { subscribe } from "./pubsub.js";

const DAILY_BUDGET_USD = Number(process.env.DAILY_BUDGET_USD ?? 3.0);
const MAX_RUNS_PER_IP_PER_DAY = Number(process.env.MAX_RUNS_PER_IP_PER_DAY ?? 5);
const DEFAULT_N = Number(process.env.DEFAULT_N ?? 10);
const MAX_N = Number(process.env.MAX_N ?? 15);

const CreateRunSchema = z.object({
  targetUrl: z.string().url(),
  steps: z.array(z.string().min(1)).min(1).max(12),
  runs: z.number().int().min(1).max(MAX_N).optional(),
  options: z
    .object({
      stealth: z.boolean().optional(),
      captcha: z.boolean().optional(),
      proxy: z.enum(["us", "none"]).optional(),
    })
    .optional(),
});

export function createServer(store: Store, stepMemoryStore: StepMemoryStore) {
  const app = new Hono();

  app.use(
    "*",
    cors({
      origin: process.env.ALLOWED_ORIGIN ?? "*",
      allowHeaders: ["Content-Type", "X-Solari-Key"],
    }),
  );

  app.get("/health", async (c) => {
    const [spend, stats] = await Promise.all([store.getSpendToday(), store.getGlobalStatsToday()]);
    return c.json({
      ok: true,
      dailyBudgetUsd: DAILY_BUDGET_USD,
      spentTodayUsd: spend,
      remainingUsd: Math.max(0, DAILY_BUDGET_USD - spend),
      runsToday: stats.runsToday,
      sessionsToday: stats.sessionsToday,
    });
  });

  app.post("/runs", async (c) => {
    const body = await c.req.json().catch(() => null);
    const parsed = CreateRunSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: "Invalid request", details: parsed.error.flatten() }, 400);
    }

    const solariApiKey = c.req.header("X-Solari-Key");
    const mode: "demo" | "byok" = solariApiKey ? "byok" : "demo";
    const ip = c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ?? "unknown";

    if (mode === "demo") {
      const [spentToday, ipRunsToday] = await Promise.all([
        store.getSpendToday(),
        store.getIpRunCountToday(ip),
      ]);
      if (spentToday >= DAILY_BUDGET_USD) {
        return c.json(
          {
            error: "Daily demo budget exhausted",
            message: `Tenfold's shared demo budget ($${DAILY_BUDGET_USD.toFixed(2)}/day) is used up for today. Bring your own Solari key (X-Solari-Key header) to run anyway.`,
          },
          402,
        );
      }
      if (ipRunsToday >= MAX_RUNS_PER_IP_PER_DAY) {
        return c.json(
          {
            error: "Per-IP daily limit reached",
            message: `You've hit the demo limit of ${MAX_RUNS_PER_IP_PER_DAY} runs/day from this IP. Bring your own Solari key to run anyway.`,
          },
          429,
        );
      }
    }

    const runId = randomUUID();
    const runs = Math.min(parsed.data.runs ?? DEFAULT_N, MAX_N);

    await store.createRun({
      id: runId,
      targetUrl: parsed.data.targetUrl,
      plan: null,
      mode,
      createdAt: new Date().toISOString(),
    });
    if (mode === "demo") await store.recordIpRun(ip);
    await store.recordRunCreated(runs);

    startRun(store, stepMemoryStore, {
      runId,
      targetUrl: parsed.data.targetUrl,
      steps: parsed.data.steps,
      runs,
      options: parsed.data.options,
      mode,
      solariApiKey,
    });

    return c.json({ runId }, 202);
  });

  app.get("/runs/:id", async (c) => {
    const run = await store.getRun(c.req.param("id"));
    if (!run) return c.json({ error: "Not found" }, 404);
    return c.json(run);
  });

  app.get("/runs/:id/events", async (c) => {
    const runId = c.req.param("id");
    const run = await store.getRun(runId);
    if (!run) return c.json({ error: "Not found" }, 404);

    return streamSSE(c, async (stream) => {
      let closed = false;
      stream.onAbort(() => {
        closed = true;
      });

      // Replay history first so a refresh (or a client connecting after the
      // run already started) sees everything that already happened.
      const history = await store.getEvents(runId, -1);
      let lastSeq = -1;
      for (const { seq, event } of history) {
        await stream.writeSSE({ event: event.type, data: JSON.stringify(event) });
        lastSeq = seq;
      }

      const current = await store.getRun(runId);
      if (current && (current.status === "done" || current.status === "error")) {
        await stream.close();
        return;
      }

      await new Promise<void>((resolve) => {
        const unsubscribe = subscribe(runId, (event) => {
          if (closed) return;
          void stream.writeSSE({ event: event.type, data: JSON.stringify(event) }).catch(() => undefined);
          if (event.type === "report.ready") {
            unsubscribe();
            resolve();
          }
        });
        stream.onAbort(() => {
          unsubscribe();
          resolve();
        });
      });
      await stream.close();
    });
  });

  app.get("/runs/:id/runs/:n/screenshot", async (c) => {
    const run = await store.getRun(c.req.param("id"));
    if (!run?.report) return c.json({ error: "Not found" }, 404);
    const runIndex = Number(c.req.param("n"));
    const perRun = run.report.perRun[runIndex];
    if (!perRun || perRun.firstFailureStep === null) {
      return c.json({ error: "No screenshot for this run" }, 404);
    }
    try {
      const buf = await readFile(screenshotPath(run.id, runIndex, perRun.firstFailureStep));
      return c.body(new Uint8Array(buf), 200, { "Content-Type": "image/png" });
    } catch {
      return c.json({ error: "Screenshot not found" }, 404);
    }
  });

  return app;
}

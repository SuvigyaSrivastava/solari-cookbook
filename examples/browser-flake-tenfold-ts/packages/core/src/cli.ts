#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { compilePlan } from "./plan/compilePlan.js";
import { runTenfold } from "./fanout/index.js";
import { createSolariClient } from "./solari/index.js";
import { FileStepMemoryStore } from "./memory/store.js";
import { hostOf } from "./memory/applyMemory.js";

/**
 * Minimal CLI for local development and the Day 1/2 acceptance criteria in
 * the build brief:
 *
 *   pnpm tenfold run plan.txt --url https://example.com --n 10
 *
 * plan.txt is one English step per line. The first line's URL (if any) is
 * used as the default targetUrl when --url is omitted.
 */
async function main() {
  const [cmd, planPath, ...rest] = process.argv.slice(2);
  if (cmd !== "run" || !planPath) {
    console.error("Usage: tenfold run <plan.txt> [--url <targetUrl>] [--n <runs>]");
    process.exit(1);
  }

  const n = flagValue(rest, "--n");
  const urlFlag = flagValue(rest, "--url");

  const raw = await readFile(planPath, "utf-8");
  const lines = raw.split("\n").map((l) => l.trim()).filter(Boolean);

  const urlFromPlan = lines.find((l) => /https?:\/\//.test(l))?.match(/https?:\/\/\S+/)?.[0];
  const targetUrl = urlFlag ?? urlFromPlan;
  if (!targetUrl) {
    console.error("No target URL given (pass --url or include one in the plan file)");
    process.exit(1);
  }

  const plan = await compilePlan(lines, targetUrl, {
    runs: n ? Number(n) : undefined,
  });

  console.log(`Compiled ${plan.steps.length} steps, running ${plan.runs}x against ${plan.targetUrl}`);
  const client = createSolariClient();
  console.log(`Solari mode: ${client.mode}${client.mode === "mock" ? " (local Chromium, no cost)" : ""}`);

  // Workflow Memory (§11) — on by default for the CLI (a JSON file next to
  // the plan, so two consecutive `tenfold run` invocations against the same
  // plan actually demonstrate reuse per §11.4); pass --no-memory to disable.
  const memoryDisabled = rest.includes("--no-memory");
  const memoryPath = flagValue(rest, "--memory-file") ?? `${planPath}.memory.json`;
  const memory = memoryDisabled
    ? undefined
    : {
        store: new FileStepMemoryStore(memoryPath),
        targetHost: hostOf(targetUrl),
        fingerprintThresholdBits: Number(process.env.MEMORY_FINGERPRINT_THRESHOLD_BITS ?? 12),
      };
  if (memory) console.log(`Workflow memory: ${memoryPath}`);

  const report = await runTenfold(
    plan,
    {
      mode: client.mode,
      memory,
      onEvent: (e) => {
        if (e.type === "step.relearned") {
          console.log(`  run ${e.runIndex} step ${e.stepIndex}: re-learned (${e.reason})`);
        }
        if (e.type === "run.finished") {
          const r = e.result;
          console.log(
            `  run ${r.runIndex}: ${r.status}${r.cause ? ` (${r.cause} at step ${r.firstFailureStep})` : ""} — ${r.durationMs}ms`,
          );
        }
      },
    },
    client,
  );

  console.log("");
  console.log(`Verdict: ${report.verdict} — ${report.passed}/${report.runs} passed`);
  console.log(`Cost: $${report.cost.usd.toFixed(4)} (${report.cost.browserHours.toFixed(4)} browser-hours)`);
  console.log(`p50: ${report.timing.p50Ms}ms  p95: ${report.timing.p95Ms}ms`);
  console.log(`Own misses (resolver/infra, not the site's fault): ${report.ownMisses}`);
  console.log(`First-failure histogram: ${JSON.stringify(report.firstFailureHistogram)}`);
  console.log(`Cause breakdown: ${JSON.stringify(report.causeBreakdown)}`);
  if (report.memory) {
    const m = report.memory;
    console.log(
      `Memory: reused ${m.reused}/${m.reused + m.resolverCallsMade} steps · re-learned ${m.relearned} · ` +
        `resolver calls: ${m.resolverCallsMade} (baseline ${m.resolverCallsBaseline}) · cost down ${m.costReductionPct}%`,
    );
  }
  console.log(JSON.stringify(report, null, 2));
}

function flagValue(args: string[], flag: string): string | undefined {
  const idx = args.indexOf(flag);
  return idx >= 0 ? args[idx + 1] : undefined;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

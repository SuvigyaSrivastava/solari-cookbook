"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { RunResult, StepResult, TenfoldEvent, TenfoldReport } from "@tenfold/core";
import { fetchRun, subscribeToRunEvents, screenshotUrl, type RunRowClient } from "@/lib/runnerClient";

interface TileState {
  runIndex: number;
  status: "pending" | "running" | "passed" | "failed";
  currentStep?: string;
  stepsDone: number;
  cause?: string;
}

export default function RunPage({ params }: { params: { id: string } }) {
  const runId = params.id;
  const [run, setRun] = useState<RunRowClient | null>(null);
  const [tiles, setTiles] = useState<Record<number, TileState>>({});
  const [stepPassCounts, setStepPassCounts] = useState<Record<number, number>>({});
  const startedAt = useRef<number>(Date.now());
  const [, forceTick] = useState(0);

  useEffect(() => {
    let cancelled = false;
    fetchRun(runId).then((r) => !cancelled && setRun(r));

    const unsubscribe = subscribeToRunEvents(runId, (event: TenfoldEvent) => {
      if (event.type === "run.started") {
        setTiles((prev) => ({
          ...prev,
          [event.runIndex]: { runIndex: event.runIndex, status: "running", stepsDone: 0 },
        }));
      } else if (event.type === "step.completed") {
        const step: StepResult = event.step;
        setTiles((prev) => ({
          ...prev,
          [event.runIndex]: {
            runIndex: event.runIndex,
            status: step.status === "failed" ? "failed" : "running",
            currentStep: step.text,
            stepsDone: step.index + 1,
            cause: step.cause,
          },
        }));
        if (step.status === "passed") {
          setStepPassCounts((prev) => ({ ...prev, [step.index]: (prev[step.index] ?? 0) + 1 }));
        }
      } else if (event.type === "run.finished") {
        const r: RunResult = event.result;
        setTiles((prev) => ({
          ...prev,
          [event.runIndex]: {
            runIndex: event.runIndex,
            status: r.status === "passed" ? "passed" : "failed",
            stepsDone: r.steps.length,
            cause: r.cause ?? undefined,
          },
        }));
      } else if (event.type === "report.ready") {
        setRun((prev) => (prev ? { ...prev, status: "done", report: event.report } : prev));
      }
    });

    const tick = setInterval(() => forceTick((x) => x + 1), 500);
    return () => {
      cancelled = true;
      unsubscribe();
      clearInterval(tick);
    };
  }, [runId]);

  const totalRuns = run?.plan?.runs ?? (Object.keys(tiles).length || 10);
  const stepList = run?.plan?.steps ?? [];

  if (run?.status === "done" && run.report) {
    return <ReportView run={run} report={run.report} />;
  }

  if (run?.status === "error") {
    return (
      <main className="container">
        <div className="error-banner">Run failed: {run.error ?? "unknown error"}</div>
      </main>
    );
  }

  return (
    <main className="container">
      <h1 className="hero-headline" style={{ fontSize: 28 }}>
        Running {totalRuns}× against{" "}
        <span className="mono">{run?.targetUrl ?? "…"}</span>
      </h1>
      <p className="hero-sub">
        Elapsed: <span className="num">{((Date.now() - startedAt.current) / 1000).toFixed(1)}s</span>
      </p>

      <div className="grid-tiles">
        {Array.from({ length: totalRuns }, (_, i) => {
          const t = tiles[i];
          const status = t?.status ?? "pending";
          return (
            <div key={i} className={`tile ${status}`}>
              <div className="idx">#{i}</div>
              <div className="status">{status}</div>
              {t?.currentStep && <div style={{ color: "var(--text-faint)", marginTop: 4 }}>{truncate(t.currentStep, 40)}</div>}
            </div>
          );
        })}
      </div>

      {stepList.length > 0 && (
        <>
          <div className="section-title">Step progress</div>
          <div className="step-progress">
            {stepList.map((step) => {
              const passed = stepPassCounts[step.index] ?? 0;
              const pct = totalRuns > 0 ? Math.round((passed / totalRuns) * 100) : 0;
              return (
                <div className="step-progress-row" key={step.index}>
                  <div className="label">
                    {step.index + 1}. {step.text}
                  </div>
                  <div className="bar-track">
                    <div className="bar-fill" style={{ width: `${pct}%` }} />
                  </div>
                  <div className="num" style={{ width: 60, textAlign: "right" }}>
                    {passed}/{totalRuns}
                  </div>
                </div>
              );
            })}
          </div>
        </>
      )}
    </main>
  );
}

function ReportView({ run, report }: { run: RunRowClient; report: TenfoldReport }) {
  const [copied, setCopied] = useState(false);
  const failuresAtStep = useMemo(() => {
    const entries = Object.entries(report.firstFailureHistogram);
    if (entries.length === 0) return null;
    const [step, count] = entries.sort((a, b) => Number(b[1]) - Number(a[1]))[0]!;
    return { step: Number(step), count };
  }, [report]);

  const maxHistCount = Math.max(1, ...Object.values(report.firstFailureHistogram));

  function handleShare() {
    navigator.clipboard?.writeText(window.location.href).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  }

  return (
    <main className="container">
      <h1 className={`verdict ${report.verdict}`}>
        {report.verdict} — {report.passed}/{report.runs} passed
      </h1>
      <p className="verdict-sub">
        {failuresAtStep
          ? `Fails at step ${failuresAtStep.step + 1} in ${failuresAtStep.count}/${report.failed} failures · `
          : ""}
        cause: {topCause(report)} · p95 {(report.timing.p95Ms / 1000).toFixed(1)}s · cost $
        {report.cost.usd.toFixed(4)}
        {report.mode === "mock" && " · mock mode (local Chromium, no Solari cost)"}
      </p>

      <button className="btn-secondary" onClick={handleShare}>
        {copied ? "Copied!" : "Share report"}
      </button>

      <div className="section-title">First-failure histogram</div>
      <div className="histogram">
        {(run.plan?.steps ?? []).map((step) => {
          const count = report.firstFailureHistogram[step.index] ?? 0;
          const heightPct = (count / maxHistCount) * 100;
          return (
            <div className="bar-col" key={step.index}>
              <div className="num" style={{ fontSize: 11 }}>
                {count || ""}
              </div>
              <div className="bar" style={{ height: `${Math.max(heightPct, count > 0 ? 4 : 0)}%` }} />
              <div className="bar-label">#{step.index + 1}</div>
            </div>
          );
        })}
      </div>

      <div className="section-title">Cause breakdown</div>
      <table className="runs-table">
        <tbody>
          {Object.entries(report.causeBreakdown)
            .filter(([, count]) => count > 0)
            .map(([cause, count]) => (
              <tr key={cause}>
                <td>{cause}</td>
                <td className="num">{count}</td>
              </tr>
            ))}
        </tbody>
      </table>
      <div className="own-misses">
        Tenfold&apos;s own misses (resolver/infra errors — not the target site&apos;s fault):{" "}
        <strong className="num">{report.ownMisses}</strong>
      </div>

      {report.memory && (
        <>
          <div className="section-title">Memory</div>
          <div className="own-misses">
            Reused <strong className="num">{report.memory.reused}</strong>/
            {report.memory.reused + report.memory.resolverCallsMade} steps from memory
            {report.memory.relearned > 0 && (
              <>
                {" "}
                · re-learned <strong className="num">{report.memory.relearned}</strong>
                {report.memory.relearned === 1 ? " step" : " steps"}
              </>
            )}
            {" "}· resolver calls: <strong className="num">{report.memory.resolverCallsMade}</strong> (baseline{" "}
            {report.memory.resolverCallsBaseline}) · resolver cost down{" "}
            <strong className="num">{report.memory.costReductionPct}%</strong>
          </div>
        </>
      )}

      <div className="section-title">Per-run results</div>
      <table className="runs-table">
        <thead>
          <tr>
            <th>#</th>
            <th>Result</th>
            <th>Duration</th>
            <th>First failed step</th>
            <th>Cause</th>
            <th>Replay</th>
          </tr>
        </thead>
        <tbody>
          {report.perRun.map((r) => (
            <tr key={r.runIndex}>
              <td className="num">{r.runIndex}</td>
              <td>
                <span className={`pill ${r.status}`}>{r.status}</span>
              </td>
              <td className="num">{(r.durationMs / 1000).toFixed(1)}s</td>
              <td className="num">{r.firstFailureStep !== null ? r.firstFailureStep + 1 : "—"}</td>
              <td>{r.cause ?? "—"}</td>
              <td>
                <ReplayCell run={r} runId={run.id} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <div className="section-title">Plan</div>
      <details className="plan-collapsible">
        <summary>English plan &amp; compiled JSON</summary>
        <pre>{run.plan?.steps.map((s, i) => `${i + 1}. ${s.text}`).join("\n")}</pre>
        <pre>{JSON.stringify(run.plan, null, 2)}</pre>
      </details>

      <footer className="tenfold-footer">
        Replays expire {new Date(report.replaysExpireAt).toLocaleDateString()} (7-day Solari
        Starter-plan retention).
      </footer>
    </main>
  );
}

function ReplayCell({ run, runId }: { run: RunResult; runId: string }) {
  if (run.replayStatus === "ready" && run.replayUrl) {
    return (
      <a href={run.replayUrl} target="_blank" rel="noreferrer">
        ▶ Replay
      </a>
    );
  }
  if (run.replayStatus === "pending") return <span style={{ color: "var(--amber)" }}>pending…</span>;
  if (run.replayStatus === "expired") return <span style={{ color: "var(--text-faint)" }}>expired</span>;
  if (run.firstFailureStep !== null) {
    return (
      <a href={screenshotUrl(runId, run.runIndex)} target="_blank" rel="noreferrer">
        screenshot
      </a>
    );
  }
  return <span style={{ color: "var(--text-faint)" }}>—</span>;
}

function topCause(report: TenfoldReport): string {
  const entries = Object.entries(report.causeBreakdown).filter(([, c]) => c > 0);
  if (entries.length === 0) return "none";
  return entries.sort((a, b) => b[1] - a[1])[0]![0];
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}

import type { TenfoldEvent, TenfoldReport, TestPlan } from "@tenfold/core";

export const RUNNER_URL =
  process.env.NEXT_PUBLIC_RUNNER_URL ?? "http://localhost:8787";

export interface RunRowClient {
  id: string;
  status: "queued" | "running" | "done" | "error";
  targetUrl: string;
  plan: TestPlan | null;
  mode: "demo" | "byok";
  report: TenfoldReport | null;
  costUsd: number;
  createdAt: string;
  finishedAt: string | null;
  error?: string;
}

export interface HealthResponse {
  ok: boolean;
  dailyBudgetUsd: number;
  spentTodayUsd: number;
  remainingUsd: number;
  runsToday: number;
  sessionsToday: number;
}

export async function fetchHealth(): Promise<HealthResponse> {
  const res = await fetch(`${RUNNER_URL}/health`, { cache: "no-store" });
  if (!res.ok) throw new Error(`health check failed: ${res.status}`);
  return res.json();
}

export interface CreateRunInput {
  targetUrl: string;
  steps: string[];
  runs?: number;
  options?: { stealth?: boolean; captcha?: boolean; proxy?: "us" | "none" };
  solariApiKey?: string;
}

export async function createRun(input: CreateRunInput): Promise<{ runId: string }> {
  const res = await fetch(`${RUNNER_URL}/runs`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(input.solariApiKey ? { "X-Solari-Key": input.solariApiKey } : {}),
    },
    body: JSON.stringify({
      targetUrl: input.targetUrl,
      steps: input.steps,
      runs: input.runs,
      options: input.options,
    }),
  });
  const body = await res.json();
  if (!res.ok) {
    throw new Error(body.message ?? body.error ?? `Run creation failed: ${res.status}`);
  }
  return body;
}

export async function fetchRun(runId: string): Promise<RunRowClient> {
  const res = await fetch(`${RUNNER_URL}/runs/${runId}`, { cache: "no-store" });
  if (!res.ok) throw new Error(`run not found: ${res.status}`);
  return res.json();
}

export function subscribeToRunEvents(
  runId: string,
  onEvent: (event: TenfoldEvent) => void,
): () => void {
  const source = new EventSource(`${RUNNER_URL}/runs/${runId}/events`);
  const types: TenfoldEvent["type"][] = [
    "run.started",
    "step.started",
    "step.completed",
    "run.finished",
    "replay.ready",
    "report.ready",
  ];
  const listeners = types.map((type) => {
    const handler = (e: MessageEvent) => {
      try {
        onEvent(JSON.parse(e.data));
      } catch {
        /* ignore malformed event */
      }
    };
    source.addEventListener(type, handler);
    return { type, handler };
  });
  return () => {
    for (const { type, handler } of listeners) source.removeEventListener(type, handler);
    source.close();
  };
}

export function screenshotUrl(runId: string, runIndex: number): string {
  return `${RUNNER_URL}/runs/${runId}/runs/${runIndex}/screenshot`;
}

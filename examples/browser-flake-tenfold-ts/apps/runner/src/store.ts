import type { TenfoldEvent, TenfoldReport, TestPlan } from "@tenfold/core";

export type RunMode = "demo" | "byok";
export type RunStatus = "queued" | "running" | "done" | "error";

export interface RunRow {
  id: string;
  status: RunStatus;
  targetUrl: string;
  plan: TestPlan | null;
  mode: RunMode;
  report: TenfoldReport | null;
  costUsd: number;
  createdAt: string;
  finishedAt: string | null;
  error?: string;
}

/**
 * Storage abstraction so the runner works with zero setup (in-memory, the
 * default) and with real Postgres (Neon/Render/Railway — anything that
 * accepts infra/schema.sql) by just setting DATABASE_URL. Both
 * implementations satisfy the same interface; nothing in server.ts cares
 * which one is active.
 */
export interface Store {
  createRun(row: Omit<RunRow, "status" | "report" | "costUsd" | "finishedAt">): Promise<void>;
  updateRun(id: string, patch: Partial<RunRow>): Promise<void>;
  getRun(id: string): Promise<RunRow | null>;

  appendEvent(runId: string, event: TenfoldEvent): Promise<number>; // returns seq
  getEvents(runId: string, sinceSeq?: number): Promise<Array<{ seq: number; event: TenfoldEvent }>>;

  addSpend(usd: number): Promise<void>;
  getSpendToday(): Promise<number>;

  recordIpRun(ip: string): Promise<void>;
  getIpRunCountToday(ip: string): Promise<number>;

  /** Public activity ticker on the landing page (brief §6.1) — every run
   * counts here regardless of demo/BYOK mode, unlike spend which is
   * demo-only. */
  recordRunCreated(sessions: number): Promise<void>;
  getGlobalStatsToday(): Promise<{ runsToday: number; sessionsToday: number }>;
}

export function todayKey(): string {
  return new Date().toISOString().slice(0, 10); // YYYY-MM-DD
}

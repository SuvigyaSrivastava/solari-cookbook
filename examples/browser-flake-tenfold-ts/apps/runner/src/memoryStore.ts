import type { TenfoldEvent } from "@tenfold/core";
import type { RunRow, Store } from "./store.js";
import { todayKey } from "./store.js";

/**
 * Zero-config default store. Good enough for the demo deployment and for
 * local dev — everything lives in the runner process's memory and resets on
 * restart. Swap in postgresStore.ts by setting DATABASE_URL for anything
 * that needs to survive a redeploy.
 */
export function createMemoryStore(): Store {
  const runs = new Map<string, RunRow>();
  const events = new Map<string, Array<{ seq: number; event: TenfoldEvent }>>();
  const spendByDay = new Map<string, number>();
  const ipRunsByDay = new Map<string, number>(); // key: `${day}:${ip}`
  const globalStatsByDay = new Map<string, { runsToday: number; sessionsToday: number }>();

  return {
    async createRun(row) {
      runs.set(row.id, {
        ...row,
        status: "queued",
        report: null,
        costUsd: 0,
        finishedAt: null,
      });
      events.set(row.id, []);
    },

    async updateRun(id, patch) {
      const existing = runs.get(id);
      if (!existing) return;
      runs.set(id, { ...existing, ...patch });
    },

    async getRun(id) {
      return runs.get(id) ?? null;
    },

    async appendEvent(runId, event) {
      const list = events.get(runId) ?? [];
      const seq = list.length;
      list.push({ seq, event });
      events.set(runId, list);
      return seq;
    },

    async getEvents(runId, sinceSeq = -1) {
      const list = events.get(runId) ?? [];
      return list.filter((e) => e.seq > sinceSeq);
    },

    async addSpend(usd) {
      const key = todayKey();
      spendByDay.set(key, (spendByDay.get(key) ?? 0) + usd);
    },

    async getSpendToday() {
      return spendByDay.get(todayKey()) ?? 0;
    },

    async recordIpRun(ip) {
      const key = `${todayKey()}:${ip}`;
      ipRunsByDay.set(key, (ipRunsByDay.get(key) ?? 0) + 1);
    },

    async getIpRunCountToday(ip) {
      return ipRunsByDay.get(`${todayKey()}:${ip}`) ?? 0;
    },

    async recordRunCreated(sessions) {
      const key = todayKey();
      const cur = globalStatsByDay.get(key) ?? { runsToday: 0, sessionsToday: 0 };
      globalStatsByDay.set(key, {
        runsToday: cur.runsToday + 1,
        sessionsToday: cur.sessionsToday + sessions,
      });
    },

    async getGlobalStatsToday() {
      return globalStatsByDay.get(todayKey()) ?? { runsToday: 0, sessionsToday: 0 };
    },
  };
}

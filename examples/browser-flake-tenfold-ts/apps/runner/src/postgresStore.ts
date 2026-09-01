import pg from "pg";
import type { TenfoldEvent } from "@tenfold/core";
import type { RunRow, Store } from "./store.js";

const { Pool } = pg;

/**
 * Postgres-backed store matching infra/schema.sql. Works against Neon,
 * Render Postgres, Railway, or a local instance — anything reachable via a
 * standard connection string in DATABASE_URL.
 */
export function createPostgresStore(connectionString: string): Store {
  const pool = new Pool({ connectionString, max: 5 });

  return {
    async createRun(row) {
      await pool.query(
        `insert into runs (id, status, target_url, plan, mode, created_at)
         values ($1, 'queued', $2, $3, $4, $5)`,
        [row.id, row.targetUrl, row.plan, row.mode, row.createdAt],
      );
    },

    async updateRun(id, patch) {
      const sets: string[] = [];
      const values: unknown[] = [];
      let i = 1;
      if (patch.status !== undefined) {
        sets.push(`status = $${i++}`);
        values.push(patch.status);
      }
      if (patch.plan !== undefined) {
        sets.push(`plan = $${i++}`);
        values.push(JSON.stringify(patch.plan));
      }
      if (patch.report !== undefined) {
        sets.push(`report = $${i++}`);
        values.push(JSON.stringify(patch.report));
      }
      if (patch.costUsd !== undefined) {
        sets.push(`cost_usd = $${i++}`);
        values.push(patch.costUsd);
      }
      if (patch.finishedAt !== undefined) {
        sets.push(`finished_at = $${i++}`);
        values.push(patch.finishedAt);
      }
      if (sets.length === 0) return;
      values.push(id);
      await pool.query(`update runs set ${sets.join(", ")} where id = $${i}`, values);
    },

    async getRun(id) {
      const res = await pool.query(`select * from runs where id = $1`, [id]);
      const row = res.rows[0];
      if (!row) return null;
      return {
        id: row.id,
        status: row.status,
        targetUrl: row.target_url,
        plan: row.plan,
        mode: row.mode,
        report: row.report,
        costUsd: Number(row.cost_usd ?? 0),
        createdAt: row.created_at?.toISOString?.() ?? row.created_at,
        finishedAt: row.finished_at?.toISOString?.() ?? row.finished_at,
      };
    },

    async appendEvent(runId, event) {
      const res = await pool.query(
        `insert into events (run_id, type, payload) values ($1, $2, $3) returning seq`,
        [runId, event.type, JSON.stringify(event)],
      );
      return Number(res.rows[0].seq);
    },

    async getEvents(runId, sinceSeq = -1) {
      const res = await pool.query(
        `select seq, payload from events where run_id = $1 and seq > $2 order by seq asc`,
        [runId, sinceSeq],
      );
      return res.rows.map((r) => ({ seq: Number(r.seq), event: r.payload as TenfoldEvent }));
    },

    async addSpend(usd) {
      await pool.query(
        `insert into spend (day, usd) values (current_date, $1)
         on conflict (day) do update set usd = spend.usd + excluded.usd`,
        [usd],
      );
    },

    async getSpendToday() {
      const res = await pool.query(`select usd from spend where day = current_date`);
      return Number(res.rows[0]?.usd ?? 0);
    },

    async recordIpRun(ip) {
      await pool.query(
        `insert into ip_runs (day, ip, count) values (current_date, $1, 1)
         on conflict (day, ip) do update set count = ip_runs.count + 1`,
        [ip],
      );
    },

    async getIpRunCountToday(ip) {
      const res = await pool.query(`select count from ip_runs where day = current_date and ip = $1`, [ip]);
      return Number(res.rows[0]?.count ?? 0);
    },

    async recordRunCreated(sessions) {
      await pool.query(
        `insert into spend (day, usd, runs_count, sessions_count) values (current_date, 0, 1, $1)
         on conflict (day) do update set
           runs_count = spend.runs_count + 1,
           sessions_count = spend.sessions_count + excluded.sessions_count`,
        [sessions],
      );
    },

    async getGlobalStatsToday() {
      const res = await pool.query(
        `select runs_count, sessions_count from spend where day = current_date`,
      );
      return {
        runsToday: Number(res.rows[0]?.runs_count ?? 0),
        sessionsToday: Number(res.rows[0]?.sessions_count ?? 0),
      };
    },
  };
}

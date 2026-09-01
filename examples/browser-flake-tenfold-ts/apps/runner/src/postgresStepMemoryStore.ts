import pg from "pg";
import type { StepMemoryEntry, StepMemoryStore } from "@tenfold/core";

const { Pool } = pg;

/**
 * Postgres-backed Workflow Memory store (§11.1's `step_memory` table,
 * infra/schema.sql), used by the runner whenever DATABASE_URL is set —
 * mirroring postgresStore.ts's own pattern for run rows. Shares one Pool
 * with the rest of the runner's tables would be nicer, but keeping it
 * self-contained matches how postgresStore.ts already does its own pooling
 * and keeps this file swappable independently.
 */
export function createPostgresStepMemoryStore(connectionString: string): StepMemoryStore {
  const pool = new Pool({ connectionString, max: 5 });

  return {
    async get(targetHost, stepTextHash) {
      const res = await pool.query(
        `select target_host, step_text_hash, locator, fingerprint, expect_text, reason, hits, misses, last_verified_at, created_at
         from step_memory where target_host = $1 and step_text_hash = $2`,
        [targetHost, stepTextHash],
      );
      const row = res.rows[0];
      if (!row) return null;
      const entry: StepMemoryEntry = {
        targetHost: row.target_host,
        stepTextHash: row.step_text_hash,
        locator: row.locator,
        fingerprint: row.fingerprint,
        expectText: row.expect_text ?? undefined,
        reason: row.reason ?? undefined,
        hits: row.hits,
        misses: row.misses,
        lastVerifiedAt: row.last_verified_at?.toISOString?.() ?? row.last_verified_at,
        createdAt: row.created_at?.toISOString?.() ?? row.created_at,
      };
      return entry;
    },

    // §11.2's own write-race guard: whichever of the N parallel browsers
    // for this run finishes the step first writes; a slower browser's
    // later-arriving write for the SAME (host, step) only applies if its
    // own last_verified_at is actually newer, so out-of-order completions
    // can't clobber a fresher observation with a stale one.
    async recordSuccess(entry, hit) {
      await pool.query(
        `insert into step_memory (id, target_host, step_text_hash, locator, fingerprint, expect_text, reason, hits, misses, last_verified_at)
         values (gen_random_uuid(), $1, $2, $3, $4, $5, $6, $7, $8, now())
         on conflict (target_host, step_text_hash) do update set
           locator = excluded.locator,
           fingerprint = excluded.fingerprint,
           expect_text = excluded.expect_text,
           reason = excluded.reason,
           hits = step_memory.hits + excluded.hits,
           misses = step_memory.misses + excluded.misses,
           last_verified_at = excluded.last_verified_at
         where excluded.last_verified_at > step_memory.last_verified_at`,
        [
          entry.targetHost,
          entry.stepTextHash,
          JSON.stringify(entry.locator),
          entry.fingerprint,
          entry.expectText ?? null,
          entry.reason ?? null,
          hit ? 1 : 0,
          hit ? 0 : 1,
        ],
      );
    },
  };
}

/**
 * Workflow Memory (§11 of the build brief) — Tenfold remembers how it
 * resolved a step against a given site and reuses that resolution instead
 * of paying for a fresh LLM resolver call every single run, as long as the
 * page hasn't drifted underneath it. This file holds the shapes shared by
 * every piece of that system: the resolver's own locator spec, the
 * on-disk/in-DB memory row, and the storage interface both the CLI
 * (file-backed) and the runner (file-backed or Postgres) implement.
 */

/**
 * How resolveTarget actually found an element, in a form that can be
 * replayed later without re-running any heuristics: `getByRole(role, {
 * name })`, `getByText(text)`, or a raw CSS selector as a last resort.
 * Mirrors the shape resolveTarget's own LLM fallback already asks for
 * (§4.3), just with an explicit `kind` discriminant so it round-trips
 * through JSON/Postgres cleanly.
 */
export type LocatorSpec =
  | { kind: "role"; role: string; name: string }
  | { kind: "text"; text: string }
  | { kind: "css"; css: string };

export interface StepMemoryEntry {
  targetHost: string; // hostname only — memory is per site, per §11.1
  stepTextHash: string; // sha256 of the normalized English step text
  locator: LocatorSpec;
  fingerprint: string; // simhash of the aria snapshot this was resolved against
  expectText?: string;
  reason?: string;
  hits: number;
  misses: number;
  lastVerifiedAt: string;
  createdAt: string;
}

/**
 * Storage abstraction so this works identically from the zero-setup CLI
 * (a small JSON file next to the plan) and the runner service (Postgres,
 * `step_memory` in infra/schema.sql) — same pattern as apps/runner's own
 * `Store` for run rows.
 */
export interface StepMemoryStore {
  get(targetHost: string, stepTextHash: string): Promise<StepMemoryEntry | null>;

  /**
   * Records a step's outcome for this (targetHost, stepTextHash): a
   * successful reuse or a fresh/re-learned resolution both call this with
   * the locator that worked. `hit` is true only when an *existing* memory
   * entry was reused without re-resolving; false covers both "no memory
   * existed yet" and "had to re-learn." The store is responsible for the
   * hits/misses bookkeeping and for not letting a slower browser's stale
   * write clobber a newer one — see postgresStore's `ON CONFLICT ... WHERE
   * excluded.last_verified_at > step_memory.last_verified_at` (§11.2).
   */
  recordSuccess(
    entry: Pick<StepMemoryEntry, "targetHost" | "stepTextHash" | "locator" | "fingerprint" | "expectText" | "reason">,
    hit: boolean,
  ): Promise<void>;
}

export const DEFAULT_FINGERPRINT_THRESHOLD_BITS = 12; // out of 64, per §11.2

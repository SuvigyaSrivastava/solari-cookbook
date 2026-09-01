import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import type { StepMemoryEntry, StepMemoryStore } from "./types.js";

function key(targetHost: string, stepTextHash: string): string {
  return `${targetHost}::${stepTextHash}`;
}

/**
 * Plain in-process Map. Lost on restart — fine for a single CLI invocation,
 * and fine as the runner's zero-setup default (same tradeoff it already
 * makes for run rows in memoryStore.ts).
 */
export class InMemoryStepMemoryStore implements StepMemoryStore {
  protected entries = new Map<string, StepMemoryEntry>();

  async get(targetHost: string, stepTextHash: string): Promise<StepMemoryEntry | null> {
    return this.entries.get(key(targetHost, stepTextHash)) ?? null;
  }

  async recordSuccess(
    entry: Pick<StepMemoryEntry, "targetHost" | "stepTextHash" | "locator" | "fingerprint" | "expectText" | "reason">,
    hit: boolean,
  ): Promise<void> {
    const k = key(entry.targetHost, entry.stepTextHash);
    const existing = this.entries.get(k);
    const now = new Date().toISOString();

    // §11.2's write race guard ("on conflict do update where excluded.
    // last_verified_at > step_memory.last_verified_at") — irrelevant for a
    // single-process Map (no real concurrent writers), but kept so the two
    // store implementations behave identically if this ever moves to a
    // multi-process runner.
    if (existing && existing.lastVerifiedAt > now) return;

    this.entries.set(k, {
      ...entry,
      hits: (existing?.hits ?? 0) + (hit ? 1 : 0),
      misses: (existing?.misses ?? 0) + (hit ? 0 : 1),
      lastVerifiedAt: now,
      createdAt: existing?.createdAt ?? now,
    });
  }
}

/**
 * A JSON-file-backed extension of the in-memory store, so the zero-setup
 * path (the CLI, or the runner with no DATABASE_URL) still lets someone
 * demonstrate reuse-across-runs (§11.4's whole point) without standing up
 * Postgres first. Loads eagerly, flushes after every write. Not meant for
 * concurrent processes — that's what the Postgres store is for.
 */
export class FileStepMemoryStore extends InMemoryStepMemoryStore {
  private loaded: Promise<void>;

  constructor(private readonly filePath: string) {
    super();
    this.loaded = this.load();
  }

  private async load(): Promise<void> {
    try {
      const raw = await readFile(this.filePath, "utf-8");
      const rows = JSON.parse(raw) as StepMemoryEntry[];
      for (const row of rows) {
        this.entries.set(key(row.targetHost, row.stepTextHash), row);
      }
    } catch {
      // No file yet, or unreadable — start empty. Never fail a run over a
      // corrupt cache file; memory is an optimization, not a requirement.
    }
  }

  private async flush(): Promise<void> {
    try {
      await mkdir(dirname(this.filePath), { recursive: true });
      await writeFile(this.filePath, JSON.stringify([...this.entries.values()], null, 2), "utf-8");
    } catch {
      // Best-effort persistence — a failed write just means next run starts
      // cold again, not a reason to fail the current one.
    }
  }

  override async get(targetHost: string, stepTextHash: string): Promise<StepMemoryEntry | null> {
    await this.loaded;
    return super.get(targetHost, stepTextHash);
  }

  override async recordSuccess(
    entry: Pick<StepMemoryEntry, "targetHost" | "stepTextHash" | "locator" | "fingerprint" | "expectText" | "reason">,
    hit: boolean,
  ): Promise<void> {
    await this.loaded;
    await super.recordSuccess(entry, hit);
    await this.flush();
  }
}

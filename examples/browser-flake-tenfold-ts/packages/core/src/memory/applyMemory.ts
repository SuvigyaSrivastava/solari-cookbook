import { createHash } from "node:crypto";
import type { Page } from "playwright-core";
import type { MemorySource, Step } from "../types.js";
import type { StepMemoryStore } from "./types.js";
import { DEFAULT_FINGERPRINT_THRESHOLD_BITS } from "./types.js";
import { simhash, hammingDistance } from "./simhash.js";
import { resolveTarget, resolveFromSpec, ElementNotFoundError, type ResolvedTarget } from "../execute/resolveTarget.js";

export type { MemorySource };

export interface MemoryContext {
  store: StepMemoryStore;
  targetHost: string;
  fingerprintThresholdBits?: number;
}

export interface MemoryResolution extends ResolvedTarget {
  source: MemorySource;
  /** Only set when source is "relearned" — why the remembered locator was distrusted. */
  relearnReason?: string;
  /**
   * The aria-snapshot fingerprint the page had at resolution time. Always
   * present when `memory` was passed in, so the caller can pass it straight
   * to `store.recordSuccess` once the step's action + expect both pass,
   * without re-snapshotting the page a second time.
   */
  fingerprint?: string;
}

/** sha256 of the normalized step text — the memory key's second half (§11.1). */
export function stepTextHash(text: string): string {
  const normalized = text.trim().toLowerCase().replace(/\s+/g, " ");
  return createHash("sha256").update(normalized).digest("hex");
}

export function hostOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}

// Loopback and RFC1918/link-local ranges — anywhere a Solari-launched
// browser would be reaching a target the CALLER controls (their own
// staging box, a local dev server, a hosted demo like Flakemart's own
// deployment). None of these have a reason to run behind a residential
// proxy: there's no commercial bot wall to route around, and every hop
// through a real residential IP only adds latency and (real) proxy cost
// for zero benefit.
const LOCAL_HOSTNAME_PATTERN =
  /^(localhost|127\.\d+\.\d+\.\d+|0\.0\.0\.0|::1|10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+)$/i;

/**
 * Whether a target URL should get Solari's residential proxy turned on by
 * default. Real commercial sites — Amazon, eBay, IMDb, Stack Overflow, all
 * confirmed live in testing — reject requests from datacenter IPs with a
 * bare HTTP 403 before any of Tenfold's own logic runs at all, and every
 * cloud browser (Solari included) launches from exactly that kind of IP by
 * default. A residential proxy is the standard fix; this just means the
 * out-of-the-box experience against a real external site doesn't require
 * the caller to already know that and dig into "advanced options" first.
 * Deliberately conservative — anything that looks like a local/private
 * target returns false, since there's no bot wall there to route around.
 */
export function shouldDefaultProxy(targetUrl: string): boolean {
  const host = hostOf(targetUrl);
  return !LOCAL_HOSTNAME_PATTERN.test(host);
}

async function currentFingerprint(page: Page): Promise<string> {
  try {
    const snapshot = await (page.locator("body") as any).ariaSnapshot();
    return simhash(snapshot);
  } catch {
    return simhash(await page.title().catch(() => ""));
  }
}

/**
 * The reuse/re-learn rule from §11.2, as one function `runStep` can call in
 * place of a bare `resolveTarget`. Steps with no `target` (navigate/wait/
 * assert) never touch memory — there's nothing to remember — and fall
 * straight through to `source: "resolved"` with no store lookup at all.
 */
export async function resolveWithMemory(page: Page, step: Step, memory: MemoryContext | undefined): Promise<MemoryResolution> {
  if (!memory || !step.target) {
    const resolved = await resolveTarget(page, step);
    return { ...resolved, source: "resolved" };
  }

  const threshold = memory.fingerprintThresholdBits ?? DEFAULT_FINGERPRINT_THRESHOLD_BITS;
  const hash = stepTextHash(step.text);
  const entry = await memory.store.get(memory.targetHost, hash);
  const fingerprint = await currentFingerprint(page);

  const relearn = async (reason: string): Promise<MemoryResolution> => {
    try {
      const resolved = await resolveTarget(page, step);
      return { ...resolved, source: "relearned", relearnReason: reason, fingerprint };
    } catch (err) {
      // §11.2 step 4: the remembered locator was already distrusted, and a
      // completely fresh resolve *also* failed — this is specifically the
      // "Tenfold's memory was stale AND couldn't recover" case, distinct
      // from a first-time ELEMENT_NOT_FOUND with no memory involved at all.
      if (err instanceof ElementNotFoundError) {
        throw new RelearnFailedError(step.target!, reason);
      }
      throw err;
    }
  };

  if (entry) {
    const distance = hammingDistance(fingerprint, entry.fingerprint);
    if (distance <= threshold) {
      const reused = await resolveFromSpec(page, entry.locator);
      if (reused) {
        return { locator: reused, spec: entry.locator, source: "reused", fingerprint };
      }
      // Fingerprint looked close enough, but the exact locator no longer
      // resolves to exactly one element — page changed more than the
      // snapshot hash caught.
      return relearn("remembered locator no longer matches exactly one element");
    }
    // Fingerprint drifted past the threshold — don't even try the old spec.
    return relearn("page structure changed (fingerprint drift)");
  }

  // No memory yet for this (host, step) — first time seeing it, resolve
  // fresh and let the caller record it as a miss (a "learn", not a
  // "re-learn": nothing existed before to distrust) once the step succeeds.
  const resolved = await resolveTarget(page, step);
  return { ...resolved, source: "learned", fingerprint };
}

/**
 * Thrown when a remembered locator's fingerprint had drifted AND a fresh
 * resolve also failed — §11.2 step 4's "re-learning also fails" case,
 * surfaced in the report as the NEEDS_HUMAN cause rather than a plain
 * ELEMENT_NOT_FOUND, since Tenfold specifically knows its own memory was
 * stale here rather than never having had an opinion.
 */
export class RelearnFailedError extends Error {
  constructor(target: string, reason: string) {
    super(`Memory re-learn failed for "${target}": fresh resolve also failed (${reason})`);
    this.name = "RelearnFailedError";
  }
}

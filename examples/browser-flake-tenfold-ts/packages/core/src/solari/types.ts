import type { Page } from "playwright-core";
import type { ReplayStatus, SolariLaunchOptions } from "../types.js";

/**
 * The one thing every part of Tenfold outside `solari/` is allowed to depend
 * on. Nothing outside this directory may import a Solari SDK type directly —
 * see the brief, §3: "Nothing outside solari/ may import the Solari SDK."
 */
export interface SolariSession {
  /** Playwright Page to drive with normal Playwright APIs (auto-waiting etc). */
  page: Page;
  /** Solari's session id, or null when running against a local browser (mock mode). */
  sessionId: string | null;
  /** "live" = real Solari cloud browser. "mock" = local headless Chromium, no cost, no cloud. */
  mode: "live" | "mock";
  /** Whether recording was requested for this session. */
  recordingEnabled: boolean;
  /**
   * Mandatory cleanup. MUST be called exactly once, from a `finally` block,
   * on every code path (success, step failure, thrown error, hard-deadline
   * timeout). In live mode this is what prevents the loopback proxy from
   * keeping the process alive forever — see gotcha §3.1 in the README.
   *
   * Returns immediately; replay availability is reported via the returned
   * promise resolving to a status, but callers should not block the run's
   * critical path on it for more than REPLAY_POLL_TIMEOUT_MS.
   */
  release(): Promise<{ replayUrl: string | null; replayStatus: ReplayStatus }>;
}

export interface SolariClient {
  launch(opts: SolariLaunchOptions): Promise<SolariSession>;
  readonly mode: "live" | "mock";
}

import type { SolariClient, SolariSession } from "./types.js";
import type { ReplayStatus, SolariLaunchOptions } from "../types.js";

/**
 * Real Solari cloud browser client.
 *
 * SDK shape confirmed from https://docs.getsolari.com/sessions and
 * https://docs.getsolari.com/recording on 2026-09-01:
 *
 *   import { Solari } from "@solarisdk/browser";
 *   const client = new Solari({ apiKey });
 *   const solari = await client.launch({ stealth, recording, proxy, captcha });
 *   // `solari` behaves like a Playwright Browser (it's driven over CDP) and
 *   // additionally carries a session id + close().
 *   await solari.close();                                  // MANDATORY (§3.1)
 *   const url = await client.sessions.getReplayUrl(sessionId);
 *
 * [VERIFY] before shipping against a real key: the exact property Solari
 * uses to expose the session id on the object `launch()` returns (we read
 * `.sessionId` with a fallback to `.id`), and the exact page-acquisition
 * call (we try `.newPage()`, matching the plain Playwright Browser API,
 * since `solari` is documented as CDP-driven and Playwright-shaped). If
 * either differs, this is the only file that needs to change — that's the
 * whole point of the SolariClient boundary.
 *
 * The SDK package (`@solarisdk/browser`) is gated behind Solari's private
 * registry per their own quickstart repo, so it is intentionally NOT a hard
 * dependency of this package — installing it is a manual step for whoever
 * has program access:
 *
 *   pnpm add @solarisdk/browser --filter @tenfold/core
 *
 * Until that's installed, launch() throws a clear error rather than a bare
 * module-not-found stack trace.
 */

const REPLAY_POLL_TIMEOUT_MS = Number(process.env.REPLAY_POLL_TIMEOUT_MS ?? 30_000);
const REPLAY_POLL_INTERVAL_MS = 1_500;

export function createLiveSolariClient(apiKey: string): SolariClient {
  // Lazily constructed on first launch() so a missing package doesn't break
  // mock-mode users who never call this factory.
  let clientPromise: Promise<any> | null = null;

  async function getClient(): Promise<any> {
    if (!clientPromise) {
      clientPromise = import("@solarisdk/browser")
        .then((mod: any) => {
          const Solari = mod.Solari ?? mod.default;
          return new Solari({ apiKey });
        })
        .catch((err) => {
          throw new Error(
            "SOLARI_API_KEY is set but the `@solarisdk/browser` package is not " +
              "installed (it's gated behind Solari's private registry). Run " +
              "`pnpm add @solarisdk/browser --filter @tenfold/core`, or unset " +
              "SOLARI_API_KEY to fall back to local mock mode.\n" +
              `Underlying error: ${(err as Error).message}`,
          );
        });
    }
    return clientPromise;
  }

  return {
    mode: "live",
    async launch(opts: SolariLaunchOptions): Promise<SolariSession> {
      const client = await getClient();
      const recordingEnabled = opts.recording ?? true;

      let solari: any;
      try {
        solari = await client.launch({
          stealth: opts.stealth ?? true,
          recording: recordingEnabled,
          ...(opts.proxy ? { proxy: opts.proxy } : {}),
          ...(opts.captcha !== undefined ? { captcha: opts.captcha } : {}),
          ...(opts.profileId ? { profileId: opts.profileId } : {}),
        });
      } catch (err) {
        throw new InfraError(`Solari launch() failed: ${(err as Error).message}`, err);
      }

      const sessionId: string | null = solari.sessionId ?? solari.id ?? null;
      const page = await solari.newPage();

      let released = false;
      return {
        page,
        sessionId,
        mode: "live",
        recordingEnabled,
        async release() {
          if (released) {
            return { replayUrl: null, replayStatus: "disabled" as ReplayStatus };
          }
          released = true;

          // §3.1 non-negotiable: this MUST run on every path or the loopback
          // proxy Solari opens locally keeps the Node process alive forever.
          try {
            await solari.close();
          } catch {
            // Swallow — we still want to attempt replay resolution and we
            // never want cleanup itself to crash a run. Best-effort second
            // chance via the sessions API if the SDK exposes one.
            try {
              await client.sessions?.releaseAndWait?.(sessionId);
            } catch {
              /* nothing more we can do */
            }
          }

          if (!recordingEnabled || !sessionId) {
            return { replayUrl: null, replayStatus: "disabled" as ReplayStatus };
          }

          const replay = await pollForReplay(client, sessionId);
          return replay;
        },
      };
    },
  };
}

class InfraError extends Error {
  cause?: unknown;
  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = "InfraError";
    this.cause = cause;
  }
}

/**
 * Recording upload is asynchronous after session release (confirmed in
 * docs). No polling contract is documented, so we poll defensively: try
 * immediately, then every REPLAY_POLL_INTERVAL_MS up to
 * REPLAY_POLL_TIMEOUT_MS. If it's still not ready, we report "pending" and
 * let the runner's background job (apps/runner) keep trying — see
 * infra/schema.sql `browser_runs.replay_status`.
 */
async function pollForReplay(
  client: any,
  sessionId: string,
): Promise<{ replayUrl: string | null; replayStatus: ReplayStatus }> {
  const deadline = Date.now() + REPLAY_POLL_TIMEOUT_MS;
  for (;;) {
    try {
      const url: string | null = await client.sessions.getReplayUrl(sessionId);
      if (url) return { replayUrl: url, replayStatus: "ready" };
    } catch {
      // 404 / not-ready-yet — keep polling until the deadline.
    }
    if (Date.now() >= deadline) {
      return { replayUrl: null, replayStatus: "pending" };
    }
    await new Promise((r) => setTimeout(r, REPLAY_POLL_INTERVAL_MS));
  }
}

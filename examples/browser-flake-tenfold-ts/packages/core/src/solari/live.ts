import type { SolariClient, SolariSession } from "./types.js";
import type { ReplayStatus, SolariLaunchOptions } from "../types.js";

/**
 * Real Solari cloud browser client.
 *
 * SDK shape confirmed directly from the real cookbook examples
 * (examples/browser-quickstart-ts, browser-stealth-proxy-ts,
 * browser-profiles-ts, browser-session-recording-py) once the fork existed
 * to read them — not just the public docs pages this file originally shipped
 * against. Two things changed from the first draft:
 *
 *   import { Solari } from "@solarisdk/browser";
 *   const client = new Solari({ apiKey });          // the top-level client
 *   const browser = await client.launch({ stealth, recording, proxy, captcha });
 *   const page = await browser.newPage();
 *   browser.id;                                      // session id — confirmed `.id`, not `.sessionId`
 *   await browser.close();                            // closes the browser AND releases the session
 *   await client.close();                             // MANDATORY, SEPARATELY — closes the client's
 *                                                      // own loopback proxy; every real example calls
 *                                                      // BOTH close()s in the same finally block.
 *   const url = await client.sessions.getReplayUrl(sessionId);       // [VERIFY] — see below
 *   const raw = await client.sessions.downloadReplay(sessionId);     // confirmed (rrweb NDJSON, gzip
 *                                                                    // handled transparently by the client)
 *
 * Two close() calls, not one: `browser.close()` releases the session;
 * `client.close()` shuts down the client's own loopback proxy, and skipping
 * it is what actually causes the "hangs forever" symptom every example's
 * README warns about. One Tenfold run shares a single SolariClient across
 * all N browsers (see fanout/index.ts), so `client.close()` is called once,
 * after every browser in the run has already closed — not per-session.
 *
 * `proxy` and `captcha` both REQUIRE `stealth: true` per
 * browser-stealth-proxy-ts's own comment ("a proxied request from an
 * obviously-automated browser is the pairing that gets blocked") — we force
 * stealth on whenever either is requested, regardless of what was passed,
 * rather than sending a combination Solari would reject.
 *
 * [VERIFY] still open: `client.sessions.getReplayUrl()` is documented on
 * docs.getsolari.com/recording but the cookbook's own recording example
 * (browser-session-recording-py) only demonstrates `downloadReplay()` (raw
 * NDJSON bytes, polled up to ~30s). We prefer getReplayUrl for the web UI's
 * clickable "▶ Replay" link — a URL is far better UX than raw NDJSON — and
 * fall back to reporting "pending" (never a crash) if it turns out not to
 * exist on a real client. This is the one thing in the codebase that still
 * needs a live key to fully confirm, and it's isolated to `pollForReplay`
 * below.
 *
 * The SDK package (`@solarisdk/browser`) is gated behind Solari's private
 * registry, so it is intentionally NOT a hard dependency of this package —
 * installing it is a manual step for whoever has program access:
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
  // mock-mode users who never call this factory. Shared across every
  // launch() this SolariClient instance makes (one per Tenfold run).
  let clientPromise: Promise<any> | null = null;
  let closed = false;

  async function getClient(): Promise<any> {
    if (!clientPromise) {
      // @ts-expect-error — `@solarisdk/browser` is gated behind Solari's
      // private registry (see the file-level comment above) so it's
      // intentionally not installed here; TS can't resolve its types until
      // someone with program access runs `pnpm add @solarisdk/browser`.
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
      const wantsProxyOrCaptcha = Boolean(opts.proxy || opts.captcha);
      const stealth = (opts.stealth ?? true) || wantsProxyOrCaptcha;

      let browser: any;
      try {
        browser = await client.launch({
          stealth,
          recording: recordingEnabled,
          ...(opts.proxy ? { proxy: opts.proxy } : {}),
          ...(opts.captcha !== undefined ? { captcha: opts.captcha } : {}),
          ...(opts.profileId ? { profileId: opts.profileId } : {}),
        });
      } catch (err) {
        throw new InfraError(`Solari launch() failed: ${(err as Error).message}`, err);
      }

      const sessionId: string | null = browser.id ?? browser.sessionId ?? null;
      const page = await browser.newPage();

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

          // Confirmed pattern from every real example's finally block:
          // browser.close() releases the session; it does NOT close the
          // client. Swallow errors here — cleanup failing must never mask
          // the run's actual result, and we still want to attempt replay
          // resolution below.
          try {
            await browser.close();
          } catch {
            /* best-effort */
          }

          if (!recordingEnabled || !sessionId) {
            return { replayUrl: null, replayStatus: "disabled" as ReplayStatus };
          }
          return pollForReplay(client, sessionId);
        },
      };
    },

    /**
     * MANDATORY, separate from any individual session's release(). Call
     * once after every browser this client launched has already closed
     * (fanout/index.ts does this in a finally block around the whole
     * Promise.allSettled). Idempotent — safe to call more than once or on
     * a client that never actually launched anything.
     */
    async close() {
      if (closed || !clientPromise) return;
      closed = true;
      try {
        const client = await clientPromise;
        await client.close();
      } catch {
        /* best-effort — never let final cleanup throw past the report */
      }
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
 * Recording upload is asynchronous after session release (confirmed in both
 * the docs and browser-session-recording-py's own comment: "the first poll
 * usually 404s even on a perfectly good recording"). That example polls
 * every 3s up to 10 times (~30s) before giving up — we match that budget
 * via REPLAY_POLL_TIMEOUT_MS, polling every REPLAY_POLL_INTERVAL_MS. If
 * still not ready, we report "pending" rather than failing the run.
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
      // 404 / not-ready-yet / method doesn't exist on this SDK version —
      // keep polling until the deadline either way.
    }
    if (Date.now() >= deadline) {
      return { replayUrl: null, replayStatus: "pending" };
    }
    await new Promise((r) => setTimeout(r, REPLAY_POLL_INTERVAL_MS));
  }
}

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
 * UPDATE (verified against the real installed package, @solarisdk/browser
 * 0.1.3 from the public npm registry — it turned out NOT to be gated behind
 * a private registry after all, `npm view @solarisdk/browser` resolves it
 * from registry.npmjs.org same as any other package): `getReplayUrl(id)`
 * is real and resolves `{url, expiresInSeconds, contentEncoding}` — an
 * object, not a bare string. The original draft here (written from docs
 * before this fork could install the real package to check) treated the
 * whole object as the URL, which would have produced garbage replay links
 * on every real run; fixed in `pollForReplay` below to destructure `.url`.
 * `browser.close()` (the BrowserSession wrapper) is also confirmed to call
 * `client.sessions.releaseAndWait()` internally, so the release path here
 * doing nothing more than `await browser.close()` is correct as written.
 *
 * `@solarisdk/browser` is a real dependency of `@tenfold/core` now
 * (package.json), installed the normal way:
 *
 *   pnpm add @solarisdk/browser --filter @tenfold/core
 *
 * The lazy dynamic import below predates that discovery and is kept mainly
 * as a defensive fallback (a clear error instead of a bare
 * module-not-found stack trace) in case someone's install is out of sync
 * with the lockfile — not because the package is actually optional anymore.
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
      // `@solarisdk/browser` is a real, normally-installed dependency of
      // this package now (see the file-level comment above) — this dynamic
      // import is kept mainly as a defensive fallback so a lockfile/install
      // mismatch produces a clear, actionable error instead of a bare
      // module-not-found stack trace, not because the package is optional.
      clientPromise = import("@solarisdk/browser")
        .then((mod: any) => {
          const Solari = mod.Solari ?? mod.default;
          return new Solari({ apiKey });
        })
        .catch((err) => {
          throw new Error(
            "SOLARI_API_KEY is set but the `@solarisdk/browser` package failed " +
              "to load. Run `pnpm install` (it's a normal dependency of " +
              "@tenfold/core), or unset SOLARI_API_KEY to fall back to local " +
              "mock mode.\n" +
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

      const launchOpts = {
        stealth,
        recording: recordingEnabled,
        ...(opts.proxy ? { proxy: opts.proxy } : {}),
        ...(opts.captcha !== undefined ? { captcha: opts.captcha } : {}),
        ...(opts.profileId ? { profileId: opts.profileId } : {}),
      };

      let browser: any;
      try {
        browser = await client.launch(launchOpts);
      } catch (err) {
        // Free-tier accounts get `402 FeatureRequiresPlan` for `stealth`
        // (confirmed live against a real free-plan key) — Tenfold defaults
        // stealth on because that's the right choice for a real target, but
        // a plan limit isn't the target site's fault, and it isn't worth
        // failing 10/10 runs over when a plain (non-stealth) session would
        // work fine against Flakemart or any other non-adversarial demo
        // target. Degrade once, quietly, rather than hard-failing — proxy
        // and captcha both require stealth, so this fallback only applies
        // when neither was actually requested.
        const code = (err as { code?: string })?.code;
        if (code === "FeatureRequiresPlan" && stealth && !wantsProxyOrCaptcha) {
          try {
            browser = await client.launch({ ...launchOpts, stealth: false });
          } catch (retryErr) {
            throw new InfraError(`Solari launch() failed: ${(retryErr as Error).message}`, retryErr);
          }
        } else {
          throw new InfraError(`Solari launch() failed: ${(err as Error).message}`, err);
        }
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
      // Confirmed against the real @solarisdk/browser@0.1.3 type
      // definitions: getReplayUrl() resolves an object
      // ({url, expiresInSeconds, contentEncoding}), not a bare string. The
      // original draft here (written against docs before this fork could
      // install the real package) treated the whole object as the URL,
      // which would have stored `[object Object]`-shaped data as every
      // replay link once a real key was actually used.
      const result: { url: string; expiresInSeconds: number; contentEncoding: string } | null =
        await client.sessions.getReplayUrl(sessionId);
      if (result?.url) return { replayUrl: result.url, replayStatus: "ready" };
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

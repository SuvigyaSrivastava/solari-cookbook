import { existsSync } from "node:fs";
import { chromium } from "playwright-core";
import type { SolariClient, SolariSession } from "./types.js";
import type { ReplayStatus } from "../types.js";

// The sandbox this was built in pins a specific pre-downloaded Chromium
// build under PLAYWRIGHT_BROWSERS_PATH rather than the revision this
// playwright-core version expects, so we point at it explicitly when
// present and fall back to Playwright's normal resolution elsewhere (e.g. a
// real deploy target that ran `npx playwright install chromium`).
const PINNED_CHROMIUM = "/opt/pw-browsers/chromium";
function resolveExecutablePath(): string | undefined {
  return existsSync(PINNED_CHROMIUM) ? PINNED_CHROMIUM : undefined;
}

// Confirmed live on Render's free tier (512MB/0.1 CPU): 3 concurrent
// mock-mode Chromium processes OOM'd against a normal, moderately heavy real
// site (demoqa.com) even though the same cap was comfortably fine against
// Flakemart's deliberately tiny demo page. The gap is per-instance memory,
// not concurrency — a default `chromium.launch()` keeps GPU compositing,
// background networking/sync, and other desktop-browser subsystems active
// that a scripted, invisible test run never touches, and each one costs RAM
// per browser. These flags turn that off. They don't change what a run can
// see or assert on (DOM, network, screenshots — including failure replay
// screenshots — all still render normally), only what Chromium keeps warm in
// the background. This raises how heavy a target site can be before tipping
// a free-tier instance over; it doesn't remove the ceiling entirely — a
// sufficiently heavy page at maxConcurrency can still OOM a 512MB box.
const LOW_MEMORY_CHROMIUM_ARGS = [
  "--disable-dev-shm-usage", // use disk instead of tiny /dev/shm for tab data
  "--disable-gpu", // no GPU in this headless server context anyway
  "--disable-extensions",
  "--disable-background-networking",
  "--disable-background-timer-throttling",
  "--disable-backgrounding-occluded-windows",
  "--disable-default-apps",
  "--disable-sync",
  "--disable-translate",
  "--metrics-recording-only",
  "--no-first-run",
  "--js-flags=--max-old-space-size=128", // cap V8 heap growth per tab
];

/**
 * Local/mock Solari client: launches a real local headless Chromium via
 * Playwright instead of a real Solari cloud session.
 *
 * This is NOT a fake — every Playwright action, assertion, and timing number
 * that comes out of a mock-mode run is real. The only things mocked out are
 * the parts that cost money or require a Solari account: cloud isolation,
 * stealth fingerprinting, and session replay recording. Set SOLARI_API_KEY to
 * switch to `live.ts` and get all of that back with zero code changes above
 * this module.
 *
 * This lets the whole Tenfold pipeline (compile → execute → fan out →
 * analyze → report) be built, run, and demoed with zero external accounts.
 */
export function createLocalSolariClient(): SolariClient {
  return {
    mode: "mock",
    async launch(): Promise<SolariSession> {
      // Respect the environment's outbound HTTP(S) proxy if one is set (e.g.
      // a locked-down sandbox's egress gateway) — Chromium doesn't pick up
      // HTTPS_PROXY env vars on its own the way curl/node's fetch do.
      const proxyServer = process.env.HTTPS_PROXY || process.env.https_proxy;
      const browser = await chromium.launch({
        headless: true,
        executablePath: resolveExecutablePath(),
        args: LOW_MEMORY_CHROMIUM_ARGS,
        ...(proxyServer
          ? { proxy: { server: proxyServer, bypass: "localhost,127.0.0.1,<local>" } }
          : {}),
      });
      const context = await browser.newContext();
      const page = await context.newPage();

      let released = false;
      return {
        page,
        sessionId: null,
        mode: "mock",
        recordingEnabled: false,
        async release() {
          if (released) {
            return { replayUrl: null, replayStatus: "disabled" as ReplayStatus };
          }
          released = true;
          try {
            await context.close();
          } finally {
            await browser.close();
          }
          return { replayUrl: null, replayStatus: "disabled" as ReplayStatus };
        },
      };
    },
  };
}

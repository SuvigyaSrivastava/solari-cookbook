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

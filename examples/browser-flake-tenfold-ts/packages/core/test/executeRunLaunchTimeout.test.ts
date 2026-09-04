import { describe, expect, it, vi } from "vitest";
import type { SolariClient, SolariSession } from "../src/solari/types.js";
import type { TestPlan } from "../src/types.js";
import { executeRun } from "../src/execute/executeRun.js";

// Confirmed live as a real, serious bug: client.launch() had no timeout at
// all. Every OTHER wait in executeRun (individual step actions/verifies) is
// wrapped in withTimeout against the run's remaining hard-deadline budget —
// but session launch itself, the call Solari's own SDK doc comment already
// flags as "the thing that hangs forever when something downstream goes
// wrong", ran completely unbounded. Against a real bot-walled site with no
// proxy (Amazon, no `options.proxy` set — exactly the "site actively
// resists automation" scenario that makes an anomalous launch far more
// likely than against an ordinary site), 3 of 10 real runs hung for ~9131
// seconds each — 76x the plan's own 120-second hardDeadlineMs — while the
// other 7 completed normally in under a minute. A "hard" deadline that a
// stuck launch can blow through by two orders of magnitude isn't hard at
// all; this test reproduces that exact hang deterministically and proves
// executeRun now gives up within its own configured budget instead.
describe("executeRun — a hung session launch is bounded by the run's hard deadline", () => {
  it("returns a TIMEOUT result within the configured hardDeadlineMs instead of hanging forever on a stuck client.launch()", async () => {
    let releasedLate = false;
    const hangingSession: SolariSession = {
      page: {} as SolariSession["page"], // never actually used — launch never "completes" in time
      sessionId: "late-session",
      mode: "live",
      recordingEnabled: true,
      async release() {
        releasedLate = true;
        return { replayUrl: null, replayStatus: "disabled" as const };
      },
    };

    // Simulates the real Amazon hang: launch() never resolves within any
    // reasonable step budget, but — matching the real SDK — DOES eventually
    // resolve (a real Solari session does eventually come up or time out on
    // its own end; the bug was Tenfold never bounding its own wait for it).
    const client: SolariClient = {
      mode: "live",
      async launch() {
        await new Promise((r) => setTimeout(r, 5000)); // "eventually" resolves, well past our 150ms deadline
        return hangingSession;
      },
    };

    const plan: TestPlan = {
      targetUrl: "https://example.com",
      steps: [
        { index: 0, text: "Open the page", intent: "navigate", value: "https://example.com", target: "the page", expect: "the page loads" },
      ],
      runs: 1,
      hardDeadlineMs: 150, // short on purpose — the whole point is not waiting 5000ms for launch
      options: { stealth: true, captcha: false },
    };

    const start = Date.now();
    const result = await executeRun(plan, client, 0);
    const elapsed = Date.now() - start;

    expect(result.status).toBe("failed");
    expect(result.cause).toBe("TIMEOUT");
    // The whole point: bounded by hardDeadlineMs (150ms), not by the mock
    // client's 5000ms hang. Generous slack for CI/sandbox scheduling jitter,
    // but nowhere close to 5000ms, let alone anything like the live 9131s.
    expect(elapsed).toBeLessThan(2000);

    // The late-resolving session must still get cleaned up in the
    // background once it does show up, rather than leaking a real (billed)
    // Solari session just because Tenfold stopped waiting on it.
    await vi.waitFor(() => expect(releasedLate).toBe(true), { timeout: 6000 });
  }, 10000);
});

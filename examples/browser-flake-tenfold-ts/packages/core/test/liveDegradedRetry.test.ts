import { describe, expect, it, vi, beforeEach } from "vitest";

// live.ts dynamically `import("@solarisdk/browser")`s so it never breaks
// mock-mode users without the real package installed. Mocking that module
// here is what actually lets this test exercise the retry branches (the
// exact 402-degrade-and-retry logic that was silently broken by the
// proxy-default change) without a real Solari account.
const launchMock = vi.fn();
const closeMock = vi.fn();

vi.mock("@solarisdk/browser", () => ({
  Solari: class {
    launch = launchMock;
    close = closeMock;
    sessions = { getReplayUrl: vi.fn().mockResolvedValue(null) };
  },
}));

function featureRequiresPlanError() {
  const err = new Error('402 {"error":"Stealth mode requires a paid plan","code":"FeatureRequiresPlan"}');
  (err as any).code = "FeatureRequiresPlan";
  (err as any).status = 402;
  return err;
}

function fakeBrowser() {
  return {
    id: "sess_123",
    newPage: vi.fn().mockResolvedValue({}),
    close: vi.fn().mockResolvedValue(undefined),
  };
}

beforeEach(() => {
  launchMock.mockReset();
  closeMock.mockReset();
});

describe("createLiveSolariClient — degrade-on-402 retry", () => {
  it("retries without stealth when only stealth was requested (no proxy/captcha)", async () => {
    const { createLiveSolariClient } = await import("../src/solari/live.js");
    launchMock.mockRejectedValueOnce(featureRequiresPlanError()).mockResolvedValueOnce(fakeBrowser());

    const client = createLiveSolariClient("fake-key");
    const session = await client.launch({ stealth: true, recording: true });

    expect(launchMock).toHaveBeenCalledTimes(2);
    expect(launchMock.mock.calls[0][0]).toMatchObject({ stealth: true });
    expect(launchMock.mock.calls[1][0]).toMatchObject({ stealth: false });
    // The retry never requested proxy/captcha in the first place, so it
    // must not appear in either call.
    expect(launchMock.mock.calls[1][0]).not.toHaveProperty("proxy");
    expect(session.degraded).toBe(true);
  });

  it("drops proxy too when a proxy-forced-stealth launch hits the plan limit", async () => {
    // This is the exact regression: shouldDefaultProxy() requests
    // `proxy: "us"`, which forces stealth on, which 402s on a free-tier
    // key. The old guard (`!wantsProxyOrCaptcha`) refused to retry at all
    // in this case, hard-failing every run against every external target
    // for a free-tier key. The fix must retry with BOTH dropped.
    const { createLiveSolariClient } = await import("../src/solari/live.js");
    launchMock.mockRejectedValueOnce(featureRequiresPlanError()).mockResolvedValueOnce(fakeBrowser());

    const client = createLiveSolariClient("fake-key");
    const session = await client.launch({ stealth: undefined, recording: true, proxy: "us" });

    expect(launchMock).toHaveBeenCalledTimes(2);
    expect(launchMock.mock.calls[0][0]).toMatchObject({ stealth: true, proxy: "us" });
    const retryCall = launchMock.mock.calls[1][0];
    expect(retryCall.stealth).toBe(false);
    expect(retryCall).not.toHaveProperty("proxy");
    expect(retryCall).not.toHaveProperty("captcha");
    expect(session.degraded).toBe(true);
  });

  it("does not retry, and throws InfraError, for a non-plan-limit failure", async () => {
    const other = new Error("network blip");
    (other as any).code = "SomeOtherError";
    const { createLiveSolariClient } = await import("../src/solari/live.js");
    launchMock.mockRejectedValueOnce(other);

    const client = createLiveSolariClient("fake-key");
    await expect(client.launch({ stealth: true, recording: true })).rejects.toThrow(/Solari launch\(\) failed/);
    expect(launchMock).toHaveBeenCalledTimes(1);
  });

  it("does not mark the session degraded on a clean first-try launch", async () => {
    const { createLiveSolariClient } = await import("../src/solari/live.js");
    launchMock.mockResolvedValueOnce(fakeBrowser());

    const client = createLiveSolariClient("fake-key");
    const session = await client.launch({ stealth: true, recording: true, proxy: "us" });

    expect(launchMock).toHaveBeenCalledTimes(1);
    expect(session.degraded).toBe(false);
  });
});

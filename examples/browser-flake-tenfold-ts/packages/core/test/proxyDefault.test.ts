import { describe, expect, it } from "vitest";
import { shouldDefaultProxy } from "../src/memory/applyMemory.js";

describe("shouldDefaultProxy", () => {
  it("defaults to true for real external sites", () => {
    // Confirmed live this session: Amazon, eBay, IMDb, and Stack Overflow
    // all reject datacenter-IP traffic with a bare HTTP 403 before any of
    // Tenfold's own logic runs. A residential proxy is the standard fix,
    // so any real external target should get it on by default.
    expect(shouldDefaultProxy("https://www.amazon.com")).toBe(true);
    expect(shouldDefaultProxy("https://github.com")).toBe(true);
    expect(shouldDefaultProxy("https://www.ebay.com/search?q=x")).toBe(true);
  });

  it("returns false for localhost and loopback targets", () => {
    expect(shouldDefaultProxy("http://localhost:3000")).toBe(false);
    expect(shouldDefaultProxy("http://127.0.0.1:8080")).toBe(false);
    expect(shouldDefaultProxy("http://0.0.0.0:5000")).toBe(false);
  });

  it("returns false for private-network (RFC1918) targets", () => {
    expect(shouldDefaultProxy("http://192.168.1.5:3000")).toBe(false);
    expect(shouldDefaultProxy("http://10.0.0.5")).toBe(false);
    expect(shouldDefaultProxy("http://172.16.0.1")).toBe(false);
    expect(shouldDefaultProxy("http://172.31.255.255")).toBe(false);
  });

  it("correctly excludes addresses just outside the 172.16-31 private range", () => {
    expect(shouldDefaultProxy("http://172.32.0.1")).toBe(true);
    expect(shouldDefaultProxy("http://172.15.255.255")).toBe(true);
  });
});

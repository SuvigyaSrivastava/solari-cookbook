import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { Page } from "playwright-core";
import type { Cause, RunResult, Step, StepResult, TestPlan } from "../types.js";
import type { SolariClient } from "../solari/types.js";
import { durationMsToBrowserHours } from "../solari/index.js";
import { resolveTarget, ElementNotFoundError } from "./resolveTarget.js";
import { verifyExpect } from "./verifyExpect.js";

export interface ExecuteRunOptions {
  perStepTimeoutMs?: number;
  screenshotDir?: string;
  onStepCompleted?: (result: StepResult) => void;
}

class StepTimeoutError extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = "StepTimeoutError";
  }
}

class CaptchaBlockedError extends Error {
  constructor() {
    super("Captcha challenge detected and solving is disabled");
    this.name = "CaptchaBlockedError";
  }
}

/**
 * Runs one compiled TestPlan against one Solari browser session. Stops at
 * the first failed step (§4.3: "Stop the run at the first failed step").
 * ALWAYS releases the session in `finally`, whatever happens — this is the
 * one function in the whole codebase that must never leak a browser.
 */
export async function executeRun(
  plan: TestPlan,
  client: SolariClient,
  runIndex: number,
  opts: ExecuteRunOptions = {},
): Promise<RunResult> {
  const perStepTimeoutMs = opts.perStepTimeoutMs ?? Number(process.env.PER_STEP_TIMEOUT_MS ?? 15_000);
  const startedAt = new Date();
  const deadline = startedAt.getTime() + plan.hardDeadlineMs;

  const steps: StepResult[] = [];
  let firstFailureStep: number | null = null;
  let cause: Cause | null = null;
  let sessionId: string | null = null;

  let session: Awaited<ReturnType<SolariClient["launch"]>> | null = null;
  let captchaSolves = 0;
  let replayUrl: string | null = null;
  let replayStatus: RunResult["replayStatus"] = "disabled";

  try {
    session = await client.launch({
      stealth: plan.options.stealth,
      recording: true,
      ...(plan.options.proxy ? { proxy: plan.options.proxy } : {}),
      captcha: plan.options.captcha,
      ...(plan.options.profileId ? { profileId: plan.options.profileId } : {}),
    });
    sessionId = session.sessionId;

    for (const step of plan.steps) {
      if (Date.now() > deadline) {
        const result = failStep(step, "TIMEOUT", "Run exceeded hard wall-clock deadline");
        steps.push(result);
        firstFailureStep = step.index;
        cause = "TIMEOUT";
        opts.onStepCompleted?.(result);
        break;
      }

      const remaining = Math.max(1, Math.min(perStepTimeoutMs, deadline - Date.now()));
      const t0 = Date.now();
      try {
        await withTimeout(runStep(session.page, step, plan), remaining);
        const verify = await withTimeout(verifyExpect(session.page, step.expect, step.intent), remaining);
        const durationMs = Date.now() - t0;

        if (!verify.passed) {
          const result: StepResult = {
            index: step.index,
            text: step.text,
            status: "failed",
            durationMs,
            cause: "ASSERTION_FAILED",
            reason: verify.reason,
            screenshotPath: await maybeScreenshot(session.page, opts.screenshotDir, runIndex, step.index),
          };
          steps.push(result);
          firstFailureStep = step.index;
          cause = "ASSERTION_FAILED";
          opts.onStepCompleted?.(result);
          break;
        }

        const result: StepResult = {
          index: step.index,
          text: step.text,
          status: "passed",
          durationMs,
        };
        steps.push(result);
        opts.onStepCompleted?.(result);
      } catch (err) {
        const stepCause = classifyError(err);
        const result: StepResult = {
          index: step.index,
          text: step.text,
          status: "failed",
          durationMs: Date.now() - t0,
          cause: stepCause,
          reason: err instanceof Error ? err.message : String(err),
          screenshotPath: await maybeScreenshot(session.page, opts.screenshotDir, runIndex, step.index),
        };
        steps.push(result);
        firstFailureStep = step.index;
        cause = stepCause;
        opts.onStepCompleted?.(result);
        break;
      }
    }
  } catch (err) {
    // Launch itself failed (INFRA_ERROR) before we ever got a page.
    const c = classifyError(err);
    cause = c;
    firstFailureStep = firstFailureStep ?? 0;
    if (steps.length === 0) {
      steps.push({
        index: 0,
        text: plan.steps[0]?.text ?? "(launch)",
        status: "failed",
        durationMs: 0,
        cause: c,
        reason: err instanceof Error ? err.message : String(err),
      });
    }
  } finally {
    if (session) {
      try {
        const released = await session.release();
        replayUrl = released.replayUrl;
        replayStatus = released.replayStatus;
      } catch {
        // Never let cleanup failure mask the real result — but this should
        // not happen given release() already swallows its own errors.
        replayStatus = "failed";
      }
    }
  }

  const endedAt = new Date();
  const durationMs = endedAt.getTime() - startedAt.getTime();
  const status = cause === null ? "passed" : cause === "INFRA_ERROR" ? "error" : "failed";

  return {
    runIndex,
    status,
    steps,
    firstFailureStep,
    cause,
    sessionId,
    replayUrl,
    replayStatus,
    startedAt: startedAt.toISOString(),
    endedAt: endedAt.toISOString(),
    durationMs,
    browserHours: durationMsToBrowserHours(durationMs),
    captchaSolves,
  };
}

/**
 * Some English test steps combine navigation with the real action in one
 * line ("Go to the cart and apply coupon SAVE10" — see §7 of the brief).
 * Rather than force the compiler to split every such line into two Step
 * objects (which would break the "one line = one step" invariant that keeps
 * site-flakiness and agent-interpretation-variance separated, §4.2), we
 * detect an implied destination in the raw step text and navigate there
 * first, via a real link click when one exists (more representative of an
 * actual user) and a direct goto as a fallback.
 */
async function ensureImpliedNavigation(page: Page, step: Step, plan: TestPlan): Promise<void> {
  const m = step.text.toLowerCase().match(/\bgo to (?:the )?(cart|checkout|home\w*)\b/);
  if (!m) return;
  const dest = m[1] === "home" || m[1]?.startsWith("home") ? "" : m[1]!;
  if (dest && page.url().includes(`/${dest}`)) return; // already there

  const navLink = page.getByRole("link", { name: dest || "home", exact: false }).first();
  if ((await navLink.count().catch(() => 0)) > 0) {
    await navLink.click();
    return;
  }
  const base = new URL(plan.targetUrl);
  await page.goto(new URL(`/${dest}`, base).toString(), { waitUntil: "domcontentloaded" });
}

/**
 * Companion to the compound-line handling above: when a "type" step's
 * original text also names a submit-style verb ("apply", "submit"), click
 * the matching button right after filling the field. This is what actually
 * exercises Flakemart's injected hydration race (§7) — Playwright's
 * `.fill()` sets the DOM value directly regardless of whether our delayed
 * script has attached its click handler yet, so the type action itself
 * always "succeeds"; whether the click does anything depends on timing,
 * exactly like the real bug class this is modeling.
 */
async function maybeClickSubmit(page: Page, step: Step): Promise<void> {
  const m = step.text.match(/\b(apply|submit)\b/i);
  if (!m) return;
  const button = page.getByRole("button", { name: m[1]!, exact: false }).first();
  if ((await button.count().catch(() => 0)) > 0) {
    await button.click().catch(() => undefined); // a no-op click (bug not yet hydrated) is not an error
  }
}

async function runStep(page: Page, step: Step, plan: TestPlan): Promise<void> {
  if (step.intent !== "navigate") {
    await ensureImpliedNavigation(page, step, plan);
  }

  switch (step.intent) {
    case "navigate": {
      const url = step.value || plan.targetUrl;
      const response = await page.goto(url, { waitUntil: "domcontentloaded" });
      if (response && response.status() >= 400) {
        throw new NavigationError(`${url} responded with HTTP ${response.status()}`);
      }
      await detectCaptcha(page, plan);
      return;
    }
    case "click": {
      const locator = await resolveTarget(page, step);
      await locator.click();
      return;
    }
    case "type": {
      const locator = await resolveTarget(page, step);
      await locator.fill(step.value ?? "");
      await maybeClickSubmit(page, step);
      return;
    }
    case "select": {
      const locator = await resolveTarget(page, step);
      await locator.selectOption(step.value ?? "");
      return;
    }
    case "wait": {
      await page.waitForLoadState("networkidle").catch(() => undefined);
      return;
    }
    case "assert": {
      // No action — verification happens uniformly after this switch.
      return;
    }
  }
}

class NavigationError extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = "NavigationError";
  }
}

async function detectCaptcha(page: Page, plan: TestPlan): Promise<void> {
  if (plan.options.captcha) return; // solving enabled — not our problem
  try {
    const text = (await page.locator("body").innerText()).toLowerCase();
    if (text.includes("captcha") || text.includes("verify you are human")) {
      throw new CaptchaBlockedError();
    }
  } catch (err) {
    if (err instanceof CaptchaBlockedError) throw err;
    // ignore innerText failures (e.g. page mid-navigation)
  }
}

function classifyError(err: unknown): Cause {
  const name = err instanceof Error ? err.name : "";
  const message = err instanceof Error ? err.message.toLowerCase() : "";

  if (name === "CaptchaBlockedError") return "CAPTCHA_BLOCKED";
  if (name === "ElementNotFoundError" || err instanceof ElementNotFoundError) return "ELEMENT_NOT_FOUND";
  if (name === "NavigationError") return "NAVIGATION_ERROR";
  if (name === "StepTimeoutError" || name === "HardDeadlineError" || message.includes("timeout")) {
    return "TIMEOUT";
  }
  if (name === "InfraError" || message.includes("solari launch")) return "INFRA_ERROR";
  if (message.startsWith("page.goto") || message.includes("net::")) return "NAVIGATION_ERROR";
  if (message.includes("groq") || message.includes("resolve")) return "RESOLVER_ERROR";
  // Playwright throws generic errors for most locator/action failures; a
  // "waiting for locator" message with no match is effectively not-found.
  if (message.includes("no element") || message.includes("resolved to 0 elements")) {
    return "ELEMENT_NOT_FOUND";
  }
  return "INFRA_ERROR";
}

function failStep(step: Step, cause: Cause, reason: string): StepResult {
  return { index: step.index, text: step.text, status: "failed", durationMs: 0, cause, reason };
}

async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new StepTimeoutError(`Step exceeded ${ms}ms`)), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer!);
  }
}

async function maybeScreenshot(
  page: Page,
  dir: string | undefined,
  runIndex: number,
  stepIndex: number,
): Promise<string | undefined> {
  if (!dir) return undefined;
  try {
    await mkdir(dir, { recursive: true });
    const path = join(dir, `run-${runIndex}-step-${stepIndex}.png`);
    await page.screenshot({ path, timeout: 5000 });
    return path;
  } catch {
    return undefined; // screenshot is best-effort, never fail the run over it
  }
}

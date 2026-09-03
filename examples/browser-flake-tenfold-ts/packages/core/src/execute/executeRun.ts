import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { Page } from "playwright-core";
import type { Cause, RunResult, Step, StepResult, TestPlan } from "../types.js";
import type { SolariClient } from "../solari/types.js";
import { durationMsToBrowserHours } from "../solari/index.js";
import { resolveTarget, ElementNotFoundError } from "./resolveTarget.js";
import { verifyExpect } from "./verifyExpect.js";
import {
  resolveWithMemory,
  stepTextHash,
  RelearnFailedError,
  type MemoryContext,
  type MemoryResolution,
} from "../memory/applyMemory.js";
import { simhash } from "../memory/simhash.js";

export interface ExecuteRunOptions {
  perStepTimeoutMs?: number;
  screenshotDir?: string;
  onStepCompleted?: (result: StepResult) => void;
  /** Workflow Memory (§11) — omit entirely to run with memory disabled. */
  memory?: MemoryContext;
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
        const memoryResolution = await withTimeout(runStep(session.page, step, plan, opts.memory), remaining);
        const verify = await withTimeout(verifyExpect(session.page, step.expect, step.intent), remaining);
        const durationMs = Date.now() - t0;

        if (!verify.passed) {
          // The action itself succeeded (didn't throw) but the page didn't
          // show what was expected. §11.2 step 3 treats this as a drift
          // signal too, but ONLY when we got here by REUSING a memory
          // shortcut ("reused") — we can't tell "the site actually broke"
          // from "memory pointed us at the wrong element" without a fresh
          // look. "learned"/"relearned" already paid for a fresh resolve
          // this same step, so a failing verify there is a real site
          // assertion failure, not a memory artifact — no retry needed.
          if (opts.memory && memoryResolution?.source === "reused") {
            const relearned = await retryWithFreshResolve(session.page, step, plan);
            const revalidated = await withTimeout(verifyExpect(session.page, step.expect, step.intent), remaining);
            if (revalidated.passed) {
              await recordMemorySuccess(opts.memory, step, relearned);
              const result: StepResult = {
                index: step.index,
                text: step.text,
                status: "passed",
                durationMs: Date.now() - t0,
                memory: relearned.source,
                relearnReason: relearned.relearnReason,
              };
              steps.push(result);
              opts.onStepCompleted?.(result);
              continue;
            }
          }
          const result: StepResult = {
            index: step.index,
            text: step.text,
            status: "failed",
            durationMs,
            cause: "ASSERTION_FAILED",
            reason: verify.reason,
            screenshotPath: await maybeScreenshot(session.page, opts.screenshotDir, runIndex, step.index),
            memory: memoryResolution?.source,
          };
          steps.push(result);
          firstFailureStep = step.index;
          cause = "ASSERTION_FAILED";
          opts.onStepCompleted?.(result);
          break;
        }

        if (opts.memory && memoryResolution && memoryResolution.source !== "resolved") {
          await recordMemorySuccess(opts.memory, step, memoryResolution);
        }

        const result: StepResult = {
          index: step.index,
          text: step.text,
          status: "passed",
          durationMs,
          memory: memoryResolution?.source,
          relearnReason: memoryResolution?.relearnReason,
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
    // Launch itself failed (INFRA_ERROR) before we ever got a page. This is
    // Tenfold's own miss, not the target site's fault, and the underlying
    // error is usually a specific, actionable message (a missing dependency,
    // a bad API key, a network error talking to Solari) — worth a
    // console.error so it's visible in the runner's own terminal instead of
    // only inside the stored report's `reason` field, which is easy to miss
    // when a whole batch fails identically and instantly.
    console.error(`[tenfold-core] run ${runIndex} launch/step failed:`, err);
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

/**
 * Returns the MemoryResolution used, for click/type/select steps — that's
 * what the caller needs to persist to Workflow Memory (§11) once the step's
 * whole outcome (action + expect) is known to have actually succeeded.
 * navigate/wait/assert never touch memory (nothing to resolve) and return
 * undefined.
 */
async function runStep(page: Page, step: Step, plan: TestPlan, memory?: MemoryContext): Promise<MemoryResolution | undefined> {
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
      return undefined;
    }
    case "click":
    case "type":
    case "select": {
      const resolution = await resolveWithMemory(page, step, memory);
      await performAction(page, step, resolution.locator);
      return resolution;
    }
    case "wait": {
      await page.waitForLoadState("networkidle").catch(() => undefined);
      return undefined;
    }
    case "assert": {
      // No action — verification happens uniformly after this switch.
      return undefined;
    }
  }
}

async function performAction(page: Page, step: Step, locator: Awaited<ReturnType<typeof resolveTarget>>["locator"]): Promise<void> {
  switch (step.intent) {
    case "click":
      await locator.click();
      return;
    case "type":
      await locator.fill(step.value ?? "");
      await maybeClickSubmit(page, step);
      return;
    case "select":
      await locator.selectOption(step.value ?? "");
      return;
    default:
      return;
  }
}

/**
 * §11.2 step 3-4: a REUSED memory locator's action succeeded but the
 * expect check didn't — bypass memory entirely and re-resolve fresh before
 * trusting that as a real site failure. If the fresh resolve itself can't
 * find the element either, that's specifically "our memory was stale AND
 * couldn't recover" (§11.2 step 4) — thrown as RelearnFailedError so it
 * lands on NEEDS_HUMAN rather than a plain ELEMENT_NOT_FOUND.
 */
async function retryWithFreshResolve(page: Page, step: Step, plan: TestPlan): Promise<MemoryResolution> {
  try {
    if (step.intent !== "navigate") await ensureImpliedNavigation(page, step, plan);
    const resolved = await resolveTarget(page, step);
    await performAction(page, step, resolved.locator);
    const fingerprint = await currentPageFingerprint(page);
    return { ...resolved, source: "relearned", relearnReason: "reused locator's expect check failed; re-resolved fresh", fingerprint };
  } catch (err) {
    if (err instanceof ElementNotFoundError) {
      throw new RelearnFailedError(step.target ?? step.text, "reused locator's expect check failed, and a fresh resolve found nothing");
    }
    throw err;
  }
}

async function currentPageFingerprint(page: Page): Promise<string> {
  try {
    const snapshot = await (page.locator("body") as any).ariaSnapshot();
    return simhash(snapshot);
  } catch {
    return simhash(await page.title().catch(() => ""));
  }
}

async function recordMemorySuccess(memory: MemoryContext, step: Step, resolution: MemoryResolution): Promise<void> {
  if (!step.target || !resolution.fingerprint) return;
  await memory.store
    .recordSuccess(
      {
        targetHost: memory.targetHost,
        stepTextHash: stepTextHash(step.text),
        locator: resolution.spec,
        fingerprint: resolution.fingerprint,
        expectText: step.expect,
        reason: resolution.relearnReason,
      },
      resolution.source === "reused",
    )
    .catch(() => undefined); // memory is an optimization — never fail a run over a write error
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
  // Checked before the plain ElementNotFoundError case below: a
  // RelearnFailedError means Workflow Memory (§11.2 step 4) already tried
  // reuse, then a fresh re-resolve, and both failed — a distinct signal
  // from a first-time element-not-found with no memory involved at all.
  if (name === "RelearnFailedError" || err instanceof RelearnFailedError) return "NEEDS_HUMAN";
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

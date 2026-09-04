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
import type { LocatorSpec } from "../memory/types.js";

export interface ExecuteRunOptions {
  perStepTimeoutMs?: number;
  screenshotDir?: string;
  /**
   * Fired the instant a step begins, before resolveTarget/verifyExpect run —
   * this is what lets the UI show "run #3: typing into username field" live
   * instead of only updating once the step has already finished. Purely a
   * progress signal: nothing here affects pass/fail or memory bookkeeping,
   * which all still hang off onStepCompleted.
   */
  onStepStarted?: (step: Step) => void;
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
    // "none" is TestPlanOptions' explicit proxy opt-out (distinct from
    // omitting the field, which lets shouldDefaultProxy decide) — it must
    // never reach Solari's real launch options as the literal string
    // "none", since SolariLaunchOptions.proxy only knows the real region
    // value "us". Only a real region value gets forwarded.
    const proxyOption = plan.options.proxy === "us" ? plan.options.proxy : undefined;
    session = await client.launch({
      stealth: plan.options.stealth,
      recording: true,
      ...(proxyOption ? { proxy: proxyOption } : {}),
      captcha: plan.options.captcha,
      ...(plan.options.profileId ? { profileId: plan.options.profileId } : {}),
    });
    sessionId = session.sessionId;
    if (session.degraded) {
      // live.ts fell back to a plain (non-stealth, non-proxied) session
      // because the account's plan didn't support what was requested —
      // most commonly a free-tier key plus shouldDefaultProxy() having
      // requested `proxy: "us"` against a real external target. The run
      // still proceeds, but a bot-protected target may now 403/timeout for
      // a plan reason rather than a Tenfold bug — worth a loud note in the
      // runner terminal since it won't otherwise be obvious from a single
      // run's failure cause.
      console.warn(
        `[tenfold-core] run ${runIndex}: Solari session launched in a degraded ` +
          "configuration (stealth/proxy disabled) — the account's plan didn't " +
          "support the requested options. If this run fails with a 403 or " +
          "timeout against a bot-protected site, that's likely why.",
      );
    }

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
      opts.onStepStarted?.(step);
      try {
        const memoryResolution = await withTimeout(runStep(session.page, step, plan, opts.memory), remaining);
        const verify = await withTimeout(verifyExpect(session.page, step.expect, step.intent, step.value), remaining);
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
            const revalidated = await withTimeout(verifyExpect(session.page, step.expect, step.intent, step.value), remaining);
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
        const reason = err instanceof Error ? err.message : String(err);
        // Full detail (including the enriched "what did it actually
        // resolve to" context and stack trace, when this came through
        // enrichActionError) always goes to the runner's own terminal, not
        // just the report's `reason` field — confirmed painful live when a
        // whole 10-run batch failed identically and the only way to see
        // WHY was to painstakingly download and decode a session replay by
        // hand, which doesn't even always cover the moment of failure.
        console.error(
          `[tenfold-core] run ${runIndex} step ${step.index} ("${step.text}") failed [${stepCause}]: ${reason}`,
        );
        if (err instanceof Error && err.stack) console.error(err.stack);
        const result: StepResult = {
          index: step.index,
          text: step.text,
          status: "failed",
          durationMs: Date.now() - t0,
          cause: stepCause,
          reason,
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
        const status = response.status();
        // A bare "responded with HTTP 403" reads like Tenfold or the
        // target broke — confirmed live to be genuinely confusing (Amazon,
        // eBay, IMDb, and Stack Overflow all returned exactly this, and
        // each time it needed explaining that it's the site's own
        // anti-automation defense, not a bug). 401/403 specifically, on
        // the very FIRST navigation with no cookies or prior requests from
        // this session, is the signature of a datacenter-IP block rather
        // than a real auth wall (a real login gate would render a login
        // PAGE with a 200, not refuse the connection outright) — worth
        // naming explicitly so a user reading a report understands what
        // happened and what to do about it, instead of assuming their test
        // plan is wrong.
        const isLikelyBotBlock = status === 401 || status === 403;
        const message = isLikelyBotBlock
          ? `${url} responded with HTTP ${status} — this usually means the site is blocking ` +
            "automated/datacenter traffic (common on large commercial sites), not a problem with " +
            "the test plan itself. Try enabling the residential proxy option if you're not already."
          : `${url} responded with HTTP ${status}`;
        throw new NavigationError(message);
      }
      await detectCaptcha(page, plan);
      // Confirmed live against bbc.com: a cookie/consent overlay sat on
      // top of the page after navigation and every subsequent step (a
      // click on the search icon) silently did nothing, because the
      // overlay — not the real page — was what actually received the
      // click. This is the single most common reason a real-world site
      // "just doesn't respond" to automation, far more common than any of
      // the element-resolution issues fixed elsewhere in this file, so it
      // runs unconditionally after every navigation, before any other step
      // gets a chance to interact with the page.
      await dismissConsentBanners(page);
      return undefined;
    }
    case "click":
    case "type":
    case "select": {
      const resolution = await resolveWithMemory(page, step, memory);
      const urlBefore = page.url();
      try {
        await performAction(page, step, resolution.locator);
      } catch (err) {
        // A resolved-but-wrong-element failure (e.g. Playwright's own
        // "Element is not an <input>, <textarea>...") used to surface with
        // nothing but that generic message — no way to tell WHAT was
        // actually resolved without re-running the whole thing under a
        // debugger. Confirmed painful live: a real RESOLVER_ERROR against
        // github.com took three separate live test cycles to track down
        // because neither the report nor the runner's own console said
        // which spec resolveTarget had picked or what tag/attributes it
        // actually pointed to. Enriching the error here — cheap, and only
        // on the failure path — means the NEXT time this happens, the
        // report's own "Reason" column already has the answer.
        throw await enrichActionError(err, step, resolution.spec, resolution.locator);
      }
      // A click that navigates (e.g. "click the first search result")
      // returns from .click() the instant the click event fires — it does
      // NOT wait for the resulting page to load, unlike the "navigate"
      // intent's own page.goto() a few lines up. Without this, the very
      // next step (typically an "assert" reading page text, or another
      // click) can run against a half-loaded page: confirmed live against
      // Wikipedia, where a replay showed the correct article URL already
      // loaded but the title-visibility assertion still failed, because
      // verifyExpect's body.innerText() read fired before the new page's
      // content had actually rendered. Only worth checking for "click" —
      // type/select essentially never navigate on their own.
      if (step.intent === "click" && page.url() !== urlBefore) {
        await page.waitForLoadState("domcontentloaded").catch(() => undefined);
        await page.waitForLoadState("networkidle", { timeout: 5000 }).catch(() => undefined);
      }
      return resolution;
    }
    case "press": {
      // Deliberately does NOT go through resolveTarget/resolveWithMemory —
      // there is no element named "Enter" to resolve. Confirmed live as a
      // real, silent bug: before the "press" intent existed, "Press Enter"
      // was classified as intent "click" with target "Enter", which either
      // threw ELEMENT_NOT_FOUND or (worse) fuzzy-matched some unrelated
      // element via the generic text fallback — either way, no key was ever
      // actually sent to the page. A real user pressing Enter sends it to
      // whatever currently has focus (almost always the field from the
      // immediately preceding "type" step), so page.keyboard.press does the
      // same here — no element resolution needed or possible.
      const key = step.value || "Enter";
      await page.keyboard.press(key);
      // Same reasoning as the "click" case above: pressing Enter in a
      // search box commonly submits a form and navigates or triggers an
      // async results load. Give the page a chance to settle before the
      // next step (typically an "assert") reads its content, instead of
      // racing a still-loading or still-updating results page. Unlike the
      // click case, this isn't conditioned on the URL actually changing —
      // a settle wait is cheap and correct whether Enter navigated,
      // triggered an async fetch on the same page, or did nothing at all.
      await page.waitForLoadState("domcontentloaded").catch(() => undefined);
      await page.waitForLoadState("networkidle", { timeout: 5000 }).catch(() => undefined);
      return undefined;
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
 * Wraps a thrown action error (Playwright's own message, e.g. "Element is
 * not an <input>, <textarea>...") with WHAT resolveTarget actually resolved
 * to — the LocatorSpec strategy that matched, plus the real element's tag
 * name and a handful of identifying attributes. Without this, a
 * RESOLVER_ERROR's `reason` field is just Playwright's generic complaint,
 * which says nothing about which of several candidate strategies picked
 * the wrong element or why. Confirmed expensive the hard way: a real
 * github.com RESOLVER_ERROR took three live test cycles (each costing real
 * Solari runs) to diagnose because neither the report nor the runner
 * console said what had actually been resolved. This is deliberately
 * best-effort — if introspecting the bad element ALSO throws (it may be
 * detached, or the page navigated away), the original error still surfaces
 * with the spec alone rather than being swallowed.
 */
async function enrichActionError(
  err: unknown,
  step: Step,
  spec: LocatorSpec,
  locator: Awaited<ReturnType<typeof resolveTarget>>["locator"],
): Promise<Error> {
  const original = err instanceof Error ? err : new Error(String(err));
  let elementInfo = "(could not introspect the resolved element)";
  try {
    elementInfo = await locator.evaluate((el: any) => {
      const attrList = Array.from(el.attributes ?? []) as Array<{ name: string; value: string }>;
      const attrs = attrList
        .slice(0, 6)
        .map((a) => `${a.name}="${a.value}"`)
        .join(" ");
      const text = ((el.textContent ?? "") as string).trim().slice(0, 60);
      return `<${el.tagName.toLowerCase()}${attrs ? " " + attrs : ""}>${text ? ` "${text}"` : ""}`;
    });
  } catch {
    // best-effort only — see doc comment above
  }
  const specDesc = JSON.stringify(spec);
  const enriched = new Error(
    `${original.message} — resolveTarget for step ${step.index} ("${step.text}") matched via spec ${specDesc}, ` +
      `which pointed to: ${elementInfo}`,
  );
  enriched.name = original.name;
  enriched.stack = original.stack;
  return enriched;
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

/**
 * Common cookie/consent-banner "accept" button patterns, most-specific
 * (real vendor widgets) first, falling back to generic accessible-name
 * matches. Deliberately ONLY matches accept/agree/allow-all language —
 * never "reject", "manage", "settings", "customize", or "necessary only",
 * since clicking one of those would change the page's actual behavior
 * (and for a flakiness test, silently opting out of cookies/personalization
 * is exactly the kind of side effect that could itself cause different
 * flakiness on a later run). This deliberately does NOT try to detect
 * whether a banner is actually present first — every selector below is
 * scoped to a real accept-style label, so on a page with no banner at all
 * every candidate simply matches zero elements and this is a no-op.
 */
const CONSENT_ACCEPT_SELECTORS: string[] = [
  // OneTrust — one of the most widely deployed consent platforms.
  "#onetrust-accept-btn-handler",
  // Cookiebot.
  "#CybotCookiebotDialogBodyLevelButtonLevelOptinAllowAll",
  "#CybotCookiebotDialogBodyButtonAccept",
  // Quantcast Choice / IAB TCF generic mounts.
  ".qc-cmp2-summary-buttons button[mode='primary']",
  // Generic data-testid conventions seen across many custom banners.
  "[data-testid='cookie-accept']",
  "[data-testid='accept-all-cookies']",
  "[data-testid='uc-accept-all-button']",
];

/**
 * Dismisses whatever cookie/consent overlay is on the page, if any, by
 * trying known vendor widget selectors first, then a generic accessible
 * button-name scan ("Accept all", "Accept cookies", "I agree", "Allow
 * all"), each bounded to a short timeout so a page with no banner at all
 * costs only a handful of near-instant zero-count checks. Never throws —
 * a consent banner that can't be dismissed is a degraded page, not a
 * reason to fail the whole step, and the step that actually needs the
 * page (the next click/type) will surface its own real error if the
 * overlay really is still blocking interaction.
 */
async function dismissConsentBanners(page: Page): Promise<void> {
  for (const selector of CONSENT_ACCEPT_SELECTORS) {
    try {
      const btn = page.locator(selector).first();
      if ((await btn.count().catch(() => 0)) === 0) continue;
      await btn.click({ timeout: 1500 });
      await page.waitForTimeout(150);
      return;
    } catch {
      // this vendor's widget isn't present or isn't clickable — try the next
    }
  }

  const genericNamePattern = /^(accept all|accept cookies|accept|i agree|agree|allow all|got it)$/i;
  try {
    const candidate = page.getByRole("button", { name: genericNamePattern }).first();
    if ((await candidate.count().catch(() => 0)) > 0) {
      await candidate.click({ timeout: 1500 });
      await page.waitForTimeout(150);
    }
  } catch {
    // no matching button, or it wasn't clickable — leave the page as-is
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

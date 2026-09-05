import type { Locator, Page } from "playwright-core";
import type { Step } from "../types.js";
import type { LocatorSpec } from "../memory/types.js";
import { chatJson, stripFences, getGroqClient } from "../llm/groq.js";

export class ElementNotFoundError extends Error {
  constructor(target: string, extraContext?: string) {
    super(extraContext ? `No element found matching "${target}" — ${extraContext}` : `No element found matching "${target}"`);
    this.name = "ElementNotFoundError";
  }
}

// A small, deliberately narrow set of real block-page phrasings — confirmed
// live against Amazon with no proxy: every navigation returned a plain 200
// (so the executeRun navigate-step 401/403 bot-block message never fires —
// that check only sees the HTTP status), and detectCaptcha's own "captcha"/
// "verify you are human" scan doesn't match either — Amazon's own wording is
// different and the resolver never even calls detectCaptcha's exact check.
// The actual, confusing failure mode: a step trying to type into "search
// input" and finding none, one full step after a page that visibly LOOKS
// like a normal load, throws a bare ELEMENT_NOT_FOUND that gives a user no
// hint the whole page they're driving is an anti-bot interstitial, not a
// broken selector or a wrong test plan. Each phrase here is specific enough
// that ordinary page prose won't contain it by coincidence (unlike a bare
// "error" or "sorry"), the same design principle verifyExpect's own
// ERROR_INDICATORS list already uses.
const BOT_BLOCK_PAGE_INDICATORS = [
  "to discuss automated access",
  "automated access to amazon data",
  "unusual traffic from your computer network",
  "our systems have detected unusual traffic",
  "enter the characters you see below",
  "pardon our interruption",
  "access to this page has been denied",
  "you have been blocked",
  "request could not be satisfied",
];

/**
 * Best-effort, same pattern as executeRun.ts's own detectCaptcha: a cheap
 * innerText() scan for known anti-bot phrasing, never thrown as its own
 * error — just used to enrich ElementNotFoundError's message with the same
 * "this is the site's defense, not your test plan" context the navigation-
 * level 401/403 case already gives, for the case where the block is a
 * rendered 200-status interstitial rather than a rejected connection.
 * Swallows its own failures; a page mid-navigation or with no readable body
 * simply gets the plain, unenriched error, exactly as before this existed.
 */
async function detectLikelyBotBlockPage(page: Page): Promise<string | undefined> {
  try {
    const text = (await page.locator("body").innerText()).toLowerCase();
    const hit = BOT_BLOCK_PAGE_INDICATORS.find((phrase) => text.includes(phrase));
    if (hit) {
      return (
        "the page looks like it's showing an anti-automation block/interstitial " +
        `(found the phrase "${hit}"), not the site's real content — this is ` +
        "usually the site's own bot defense, not a problem with the test plan. " +
        "Try enabling the residential proxy option if you're not already."
      );
    }
  } catch {
    // page mid-navigation, body not readable, etc. — fall through to the
    // plain error exactly as if this check didn't exist.
  }
  return undefined;
}

class LlmTimeoutError extends Error {
  constructor(public readonly timeoutMs: number) {
    super(`LLM resolver call exceeded ${timeoutMs}ms`);
    this.name = "LlmTimeoutError";
  }
}

/** Local to this file — deliberately independent of executeRun.ts's own
 * step-level withTimeout/StepTimeoutError, since a timed-out LLM call here
 * should resolve to "no match" (letting the caller fall through to its
 * normal ElementNotFoundError), not to a different, step-level error type. */
async function withLlmTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new LlmTimeoutError(ms)), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer!);
  }
}

export interface ResolvedTarget {
  locator: Locator;
  /** How this was found — persisted to Workflow Memory (§11) on success. */
  spec: LocatorSpec;
}

/**
 * Resolves a step's natural-language `target` to a concrete Playwright
 * Locator, AND to the portable `LocatorSpec` that found it — the spec is
 * what Workflow Memory (§11) writes to `step_memory` so a later run against
 * the same page can skip straight to `resolveFromSpec` instead of paying
 * for this whole function (including its LLM fallback) again.
 *
 * Deterministic role/text/testid heuristics run first — they're fast, free,
 * and cover the overwhelming majority of well-built pages (including our
 * own Flakemart). The LLM resolver only kicks in when those all come up
 * empty AND GROQ_API_KEY is set, exactly per §4.3 of the brief ("prefer
 * getByRole/getByText; CSS is last resort").
 *
 * Resolutions are cached per (step index, snapshot hash) within a run by the
 * caller (executeRun.ts) — this function itself is stateless.
 */
export async function resolveTarget(page: Page, step: Step): Promise<ResolvedTarget> {
  if (!step.target) {
    throw new ElementNotFoundError("(no target specified)");
  }
  const target = step.target;
  const quoted = firstQuoted(target) ?? firstQuoted(step.value ?? "");
  const needle = quoted ?? target;

  // Role/placeholder/label-based candidates: each one names a SPECIFIC,
  // semantically meaningful attribute (an accessible role+name, a
  // placeholder, a <label> association), so a match here is a genuinely
  // strong signal — worth trying first, and worth re-trying after the
  // reveal-path click below.
  const candidates: Array<{ make: () => Locator; spec: LocatorSpec }> = [];

  if (step.intent === "click") {
    candidates.push({
      make: () => page.getByRole("button", { name: needle, exact: false }),
      spec: { kind: "role", role: "button", name: needle },
    });
    candidates.push({
      make: () => page.getByRole("link", { name: needle, exact: false }),
      spec: { kind: "role", role: "link", name: needle },
    });
  }
  if (step.intent === "type") {
    candidates.push({
      make: () => page.getByPlaceholder(needle, { exact: false }),
      spec: { kind: "role", role: "textbox", name: needle },
    });
    candidates.push({
      make: () => page.getByLabel(needle, { exact: false }),
      spec: { kind: "role", role: "textbox", name: needle },
    });
    candidates.push({
      make: () => page.getByRole("textbox", { name: needle, exact: false }),
      spec: { kind: "role", role: "textbox", name: needle },
    });
  }
  if (step.intent === "select") {
    candidates.push({
      make: () => page.getByLabel(needle, { exact: false }),
      spec: { kind: "role", role: "combobox", name: needle },
    });
    candidates.push({
      make: () => page.getByRole("combobox", { name: needle, exact: false }),
      spec: { kind: "role", role: "combobox", name: needle },
    });
  }

  // Generic, LOOSE fallbacks — a plain text match or a `data-testid`
  // substring say nothing about whether the element is even interactive,
  // let alone the right one. Confirmed live to be a real, active hazard, not
  // a theoretical one: github.com's real search dialog ships a purely
  // decorative `<div aria-hidden="true" data-testid="quick-search-input-overlay">`
  // sitting over the real input for visual/animation purposes — slugify("search
  // input") produces "search-input", which is a substring of
  // "quick-search-input-overlay", so `[data-testid*="search-input"]` matched
  // this inert div instead of the real, fillable input a few lines away, and
  // did so on EVERY run because it used to be checked before the role-based
  // keyword scan and reveal logic ever got a chance. These are now tried
  // only as a last resort, after every stronger signal (role-based
  // candidates, keyword-overlap scan, the search-reveal path) has already
  // come up empty — matching the LLM resolver's own "cheapest/most-specific
  // signal first" ordering, just one tier up.
  const genericFallbackCandidates: Array<{ make: () => Locator; spec: LocatorSpec }> = [];
  genericFallbackCandidates.push({
    make: () => page.getByText(needle, { exact: false }),
    spec: { kind: "text", text: needle },
  });
  const testidCss = `[data-testid="${slugify(needle)}"]`;
  const testidCssContains = `[data-testid*="${slugify(needle)}"]`;
  genericFallbackCandidates.push({ make: () => page.locator(testidCss), spec: { kind: "css", css: testidCss } });
  genericFallbackCandidates.push({
    make: () => page.locator(testidCssContains),
    spec: { kind: "css", css: testidCssContains },
  });

  for (const { make, spec } of candidates) {
    try {
      const loc = make().first();
      if ((await loc.count()) > 0) return { locator: loc, spec };
    } catch {
      // invalid selector shape for this candidate type — try the next one
    }
  }

  // An LLM-written target often describes an element in different word
  // order than its actual accessible name ("Blue Hoodie add to cart button"
  // vs. the real "Add Blue Hoodie to Cart") — a direct substring match in
  // either direction fails even though a human would call it an obvious
  // match. Before paying for an LLM resolver call, try a keyword-overlap
  // scan: does every "significant" word in the target appear somewhere in
  // this candidate's accessible name, in any order?
  if (step.intent === "click" || step.intent === "type" || step.intent === "select") {
    const roles = step.intent === "click" ? (["button", "link"] as const) : (["textbox", "combobox"] as const);
    for (const r of roles) {
      const found = await keywordScan(page, r, needle);
      if (found) return { locator: found.locator, spec: { kind: "role", role: r, name: found.name } };
    }
  }

  // A structural gap distinct from (and found while stress-testing after
  // fixing) the earlier press-intent/verify bugs: a native <select>'s
  // accessible name is ALWAYS its currently-selected option's text — never
  // a description of the element's own purpose — because that's simply how
  // the browser computes it, not a quirk of any one badly-built page. A
  // plan line like "Select X from the sort dropdown" reasonably compiles to
  // target: "sort dropdown" (compilePlan's system prompt correctly asks for
  // the single concrete element being acted on), but no candidate above,
  // and no keyword scan, can ever match a target whose words ("sort",
  // "dropdown") don't and structurally can't appear anywhere in the
  // element's own accessible name or option text. Confirmed live against
  // saucedemo.com's real sort control: a bare <select> with no <label>, no
  // aria-label, options named "Name (A to Z)"/"Price (low to high)"/etc.,
  // and an accessible name that's just whichever option is selected — 10/10
  // real runs failed here even with the LLM resolver enabled, since an ARIA
  // snapshot of this element genuinely contains nothing resembling "sort".
  // The fix mirrors the search-reveal path's own "sole visible field on the
  // page" reasoning below, generalized: for "select" specifically, if
  // there's exactly ONE visible combobox/listbox anywhere on the page, it's
  // overwhelmingly likely to be the one the plan means, regardless of
  // whether its name textually resembles the target phrase at all — the
  // same "there's only one plausible candidate" signal, just without
  // needing a reveal click first. Multiple selects on the page (a real,
  // possible case) correctly falls through to the LLM/generic fallbacks
  // instead of guessing wrong.
  if (step.intent === "select") {
    for (const role of ["combobox", "listbox"] as const) {
      const anyMatch = page.getByRole(role);
      const visibleCount = await anyMatch.count().catch(() => 0);
      if (visibleCount === 1) {
        const loc = anyMatch.first();
        // Persist the element's OWN current accessible name to Workflow
        // Memory, not the mismatched `needle` — a future run's memory-reuse
        // attempt needs to target what the element actually is. Deliberately
        // NOT this file's shared accessibleName() helper here: that helper's
        // innerText() fallback (tuned for buttons/links, where innerText IS
        // the visible label) is wrong for a <select> specifically — a raw
        // <select>'s innerText concatenates EVERY option's text ("Name (A to
        // Z)\nName (Z to A)\nPrice (low to high)\n..."), not just the
        // selected one, confirmed live against saucedemo's real markup.
        // Playwright's actual computed accessible name for a combobox is
        // its selected option's text alone (confirmed via this same page's
        // real ARIA snapshot) — read that directly from the DOM instead.
        const ownName = await loc
          .evaluate((el: any) => el.options?.[el.selectedIndex]?.text ?? "")
          .catch(() => "");
        return { locator: loc, spec: { kind: "role", role, name: ownName || needle } };
      }
    }
  }

  // A real, common pattern on modern sites (GitHub, Slack, Notion, and many
  // others) that every candidate above will always miss: the actual <input>
  // for search does not exist in the DOM at all until an icon button or
  // "Search..." affordance is clicked to open it (an overlay, a command
  // palette, an expanding field). Confirmed live against github.com's real
  // homepage — its only search element is a plain icon <button> in the nav;
  // there is no textbox anywhere on the page until that button is clicked.
  // A "type" step whose target sounds like a search field is exactly the
  // case worth a deterministic, cheap reveal-then-retry before paying for
  // the LLM resolver (which would face the identical problem: an ARIA
  // snapshot of the CURRENT page also has no textbox to point at).
  // Unassociated visible-label fallback: a real, common form pattern
  // (confirmed live against demoqa.com's Text Box page) where a <label>
  // sits next to an input purely visually — same Bootstrap form-row grid,
  // no `for`/`id` pairing, no wrapping, no aria-labelledby — so neither
  // getByLabel() nor the accessible-name-based role/keyword-scan candidates
  // above can ever connect the two: Playwright (correctly, per the real
  // accessibility tree) computes the input's accessible name from its
  // `placeholder` alone ("name@example.com"), which shares zero words with
  // a target like "Email field". A sighted human has no trouble matching
  // them because the label sits right next to the field, so this looks for
  // a <label> (or label-like small text element) whose OWN text matches the
  // needle, then finds the nearest fillable input in the same layout
  // container — walking up a few ancestor levels the way a human's eye
  // would scan "this row" rather than the whole page. Tried after every
  // accessible-name-based signal (candidates, keyword scan) and before the
  // LLM resolver: it's still a cheap, deterministic DOM query, and it
  // catches exactly the case the LLM resolver's own ARIA-snapshot view
  // structurally cannot — the snapshot has no way to represent "this label
  // and this input are near each other" once the accessibility tree itself
  // doesn't associate them.
  if (step.intent === "type" || step.intent === "select") {
    const fromLabel = await resolveViaUnassociatedLabel(page, needle, step.intent);
    if (fromLabel) return fromLabel;
  }

  if (step.intent === "type" && /search/i.test(needle)) {
    const revealed = await tryRevealSearchInput(page);
    if (revealed) {
      for (const { make, spec } of candidates) {
        try {
          const loc = make().first();
          if ((await loc.count()) > 0) return { locator: loc, spec };
        } catch {
          // invalid selector shape for this candidate type — try the next one
        }
      }
      // The needle ("search input", or whatever generic phrase the LLM
      // plan used) very often won't literally match the revealed input's
      // own placeholder/label text — confirmed against a GitHub-shaped
      // fixture, where the real placeholder is "Search or jump to...",
      // nothing like the generic target text. A keyword-overlap scan is
      // already the established middle ground for this exact mismatch (see
      // above), so try it against the freshly-revealed DOM too. Scan BOTH
      // "textbox" and "combobox": confirmed live against github.com's real
      // revealed search field — it's a plain <input type="text"> but with
      // an EXPLICIT role="combobox" (aria-haspopup="listbox",
      // aria-autocomplete="list", for the type-ahead suggestion dropdown),
      // so Playwright's accessibility tree reports it as combobox, not
      // textbox. A scan that only checks "textbox" misses it entirely and
      // falls through to a genuinely wrong element (the earlier live test
      // resolved to something non-fillable and threw RESOLVER_ERROR).
      for (const role of ["textbox", "combobox"] as const) {
        const kwFound = await keywordScan(page, role, needle);
        if (kwFound) return { locator: kwFound.locator, spec: { kind: "role", role, name: kwFound.name } };
      }

      // Last resort for this reveal path specifically: a search overlay
      // that was just opened by a click we ourselves triggered is
      // overwhelmingly likely to contain exactly one purpose-built
      // textbox/combobox (a command palette, a search modal) — if there's
      // exactly one visible fillable field anywhere on the page now, it's
      // almost certainly the one we just revealed, even if neither its
      // name nor placeholder textually resembles the plan's target phrase
      // at all. The spec we persist to Workflow Memory here deliberately
      // does NOT reuse the mismatched `needle` as a role name (that spec
      // would never re-match on a future run) — instead it records the
      // element's OWN accessible name/placeholder, whatever that actually
      // is, so a later run's memory-reuse attempt targets the real thing
      // rather than a phrase known not to match it.
      for (const role of ["textbox", "combobox"] as const) {
        const anyMatch = page.getByRole(role);
        const visibleCount = await anyMatch.count().catch(() => 0);
        if (visibleCount === 1) {
          const loc = anyMatch.first();
          const ownName =
            (await loc.getAttribute("aria-label").catch(() => null)) ??
            (await loc.getAttribute("placeholder").catch(() => null)) ??
            needle;
          return { locator: loc, spec: { kind: "role", role, name: ownName } };
        }
      }
    }
  }

  // Only now — after every role-based signal (candidates, keyword-overlap
  // scan, the search-reveal path) has come up empty — fall back to the
  // loose text/testid-substring candidates. See their definition above for
  // why they're gated this late: a decorative, non-interactive element
  // (github.com's real `data-testid="quick-search-input-overlay"` div,
  // confirmed live) can satisfy a substring match purely by coincidence,
  // and used to win outright before a much better role-based match ever got
  // a chance.
  for (const { make, spec } of genericFallbackCandidates) {
    try {
      const loc = make().first();
      if ((await loc.count()) > 0) return { locator: loc, spec };
    } catch {
      // invalid selector shape for this candidate type — try the next one
    }
  }

  if (getGroqClient()) {
    const llmResult = await resolveWithLlm(page, step);
    if (llmResult) return llmResult;
  }

  const botBlockContext = await detectLikelyBotBlockPage(page);
  throw new ElementNotFoundError(target, botBlockContext);
}

/**
 * Finds a <label> (or small label-like text node) whose own text overlaps
 * the target needle, then looks for the nearest fillable input/select
 * sharing a layout container with it — covering forms where the label is
 * visually adjacent but not programmatically associated (no `for`, no
 * wrapping, no aria-labelledby). Returns a CSS-spec ResolvedTarget built
 * from the matched element's own id/name/placeholder so Workflow Memory can
 * replay it later without re-running this DOM walk.
 *
 * Runs entirely inside a single page.evaluate() — walking up ancestors and
 * querying descendants per-candidate from Node would be a lot of round
 * trips for what's fundamentally one DOM query.
 */
async function resolveViaUnassociatedLabel(
  page: Page,
  needle: string,
  intent: "type" | "select",
): Promise<ResolvedTarget | null> {
  const words = significantWords(needle);
  if (words.length === 0) return null;

  const fillableSelector =
    intent === "select" ? "select" : 'input:not([type="hidden"]):not([type="checkbox"]):not([type="radio"]), textarea';

  let cssSelector: string | null = null;
  try {
    const result = await page.evaluate(
      ({ words, fillableSelector }: { words: string[]; fillableSelector: string }) => {
        // MUST be the first statement. Root cause of every prior attempt
        // silently failing: tsx/esbuild's `keepNames` behavior rewrites
        // named function/arrow const declarations into
        // `const foo = /* @__PURE__ */ __name((...) => {...}, "foo")`,
        // baked directly into the literal source esbuild hands to Node —
        // and Playwright's page.evaluate() serializes this function via
        // `.toString()` and re-runs that exact source in the BROWSER's own
        // global scope, where esbuild's shared `__name` helper (defined
        // once elsewhere in the bundle) does not exist. Every local const
        // below (`norm`, `isVisible`, `escapeAttr`) got this treatment,
        // so this function has been throwing
        // `ReferenceError: __name is not defined` on its very first
        // wrapped declaration on EVERY call since it was introduced —
        // confirmed live via the runner's own logs — meaning none of this
        // function's actual matching logic had ever executed in
        // production, despite checking out perfectly against the real
        // page when the same logic was pasted directly into a live
        // browser console (which never passes through esbuild at all).
        // A harmless shim resolves it without needing to touch the
        // project's tsx/esbuild config.
        if (!(globalThis as any).__name) (globalThis as any).__name = (fn: any) => fn;

        const doc = (globalThis as any).document;
        const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter(Boolean);

        const isVisible = (el: any) => {
          const r = el.getBoundingClientRect();
          return r.width > 0 && r.height > 0;
        };

        const debug = { labelCount: 0, spanDivPCount: 0, textMatches: [] as string[], visibleTextMatches: [] as string[] };

        // Two passes, real <label>s first and ONLY falling back to generic
        // span/div/p text if no <label> anywhere on the page yields a
        // usable answer. Confirmed live to matter: a real page's incidental
        // ad/promo copy (demoqa.com visibly carries "Advertisement" blocks)
        // can easily contain a target word ("email" is common ad copy) in
        // some <div> or <span> that has nothing to do with the actual form
        // — real <label> elements are a far more deliberate, reliable
        // signal, so they get the first and much stronger look.
        const labelPass = Array.from(doc.querySelectorAll("label")) as any[];
        const spanDivPPass = Array.from(doc.querySelectorAll("span, div, p")) as any[];
        const passes = [labelPass, spanDivPPass];
        debug.labelCount = labelPass.length;
        debug.spanDivPCount = spanDivPPass.length;

        for (const labelLike of passes) {
        for (const el of labelLike) {
          // Only the element's OWN direct text (not children's), so a big
          // wrapping <div> around the whole form doesn't spuriously "match"
          // every field's label text concatenated together.
          const ownText = Array.from(el.childNodes)
            .filter((n: any) => n.nodeType === 3)
            .map((n: any) => n.textContent || "")
            .join(" ")
            .trim();
          if (!ownText) continue;
          const elWords = norm(ownText);
          const allPresent = words.every((w) => elWords.includes(w));
          if (!allPresent) continue;
          debug.textMatches.push(`${el.tagName}:"${ownText}"`);
          if (!isVisible(el)) continue;
          debug.visibleTextMatches.push(`${el.tagName}:"${ownText}"`);

          // If it's a real <label for="...">, that association would have
          // already been caught by getByLabel() above — this path exists
          // for the unassociated case, so skip labels that DO resolve to a
          // real control (avoids double-handling and possible mismatches).
          const forId = el.tagName === "LABEL" ? el.getAttribute("for") : null;
          if (forId && doc.getElementById(forId)) continue;

          // Walk up a few ancestor levels looking for the nearest fillable
          // field in the same layout container — mirrors how a sighted user
          // scans "this row/section", not the whole page. Attribute values
          // are escaped by hand (quote/backslash only) rather than via
          // CSS.escape() — this runs inside page.evaluate(), a plain
          // browser-global context tsc has no DOM lib visibility into here,
          // and ids/names/placeholders are virtually never anything more
          // exotic than that in practice.
          const escapeAttr = (s: string) => s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
          let container = el.parentElement;
          let matchedButUnusable = false;
          for (let depth = 0; depth < 4 && container; depth++) {
            const field = container.querySelector(fillableSelector);
            if (field) {
              if (field.id) return { selector: `#${field.id.replace(/([^a-zA-Z0-9_-])/g, "\\$1")}`, debug };
              if (field.name)
                return { selector: `${field.tagName.toLowerCase()}[name="${escapeAttr(field.name)}"]`, debug };
              // Last resort: a stable-enough path via placeholder, if present.
              const placeholder = field.getAttribute("placeholder");
              if (placeholder) return { selector: `[placeholder="${escapeAttr(placeholder)}"]`, debug };
              matchedButUnusable = true;
              break;
            }
            container = container.parentElement;
          }
          if (matchedButUnusable) continue;
        }
        }
        return { selector: null, debug };
      },
      { words, fillableSelector },
    );
    cssSelector = result.selector;
    if (!cssSelector) {
      console.error(
        `[tenfold-core] resolveViaUnassociatedLabel found nothing for "${needle}" — ` +
          `labels=${result.debug.labelCount} spanDivP=${result.debug.spanDivPCount} ` +
          `textMatches=${JSON.stringify(result.debug.textMatches)} ` +
          `visibleTextMatches=${JSON.stringify(result.debug.visibleTextMatches)}`,
      );
    }
  } catch (err) {
    console.error(`[tenfold-core] resolveViaUnassociatedLabel threw for "${needle}":`, err);
    return null;
  }

  if (!cssSelector) return null;
  try {
    const loc = page.locator(cssSelector).first();
    if ((await loc.count()) > 0) {
      return { locator: loc, spec: { kind: "css", css: cssSelector } };
    }
  } catch {
    // constructed selector was somehow invalid — fall through to caller's
    // next strategy rather than throwing here.
  }
  return null;
}

/**
 * Looks for a clickable trigger that plausibly opens a hidden search input
 * (an icon-only button with an accessible name like "Search", "Search or
 * jump to...", or an aria-label containing "search"), clicks the first one
 * found, and gives the page a brief moment to render whatever it reveals
 * (an overlay, a command palette, an expanding inline field). Returns
 * whether a trigger was found and clicked — the caller re-runs its own
 * textbox candidates afterward rather than this function guessing which
 * locator strategy will find the newly-revealed input.
 */
async function tryRevealSearchInput(page: Page): Promise<boolean> {
  const triggerCandidates: Array<() => Locator> = [
    () => page.getByRole("button", { name: /search/i }),
    () => page.getByRole("link", { name: /^search$/i }),
    () => page.locator('[aria-label*="search" i]'),
    () => page.locator('button[aria-label*="search" i], [role="button"][aria-label*="search" i]'),
    // bbc.com's actual header trigger, confirmed from a screenshot: a
    // combined icon that opens search, with common real-world markup
    // conventions for it — a data-testid, or a title attribute, since not
    // every real site puts a proper aria-label on every icon button (BBC's
    // own accessibility can be inconsistent across the many CMS-driven
    // components on a page this large).
    () => page.locator('[data-testid*="search" i]'),
    () => page.locator('[title*="search" i]'),
    // Some sites use a <button> or <a> that visually contains ONLY an
    // icon (svg/img) with no visible text and no aria-label at all, but do
    // give the icon itself or a wrapping element a recognizable class name
    // (e.g. "icon-search", "search-toggle", "SearchButton"). A CSS
    // attribute-contains selector on class is a last-resort, lower-
    // confidence signal — kept last in the list, and still gated behind
    // the caller only reaching this function for a "type" step whose OWN
    // target already mentions "search", so a false click here can only
    // ever cost one extra click on an already-search-related page area.
    () => page.locator('[class*="search-toggle" i], [class*="searchbutton" i], [class*="search-trigger" i]'),
  ];

  const fillableSelector = '[role="textbox"], [role="combobox"], input:not([type="hidden"]), textarea';
  // Snapshot how many fillable fields exist BEFORE clicking anything. This
  // matters because a real page (github.com's homepage, concretely) can
  // already have unrelated fillable fields on it before the reveal click —
  // in that live case, two <input type="email"> newsletter-signup fields.
  // A plain "wait for ANY fillable field to be attached" is a no-op on such
  // a page: those inputs are already attached, so the wait resolves
  // instantly, long before the real revealed field exists, defeating the
  // entire point of waiting. This bug shipped once already — confirmed by
  // three more live GitHub test failures AFTER the wait was added, all
  // with the identical RESOLVER_ERROR, because the wait was never actually
  // waiting for anything. Comparing against a pre-click count is what
  // makes this a wait for a NEW field, not just any field.
  const countBefore = await page.locator(fillableSelector).count().catch(() => 0);

  for (const make of triggerCandidates) {
    try {
      const trigger = make().first();
      if ((await trigger.count()) === 0) continue;
      await trigger.click({ timeout: 2000 });

      // A fixed sleep here is a real, confirmed source of flakiness, not a
      // theoretical one: a live replay against github.com showed the click
      // registering (aria-expanded flips true within ~30ms) but the actual
      // <input role="combobox"> for the search dialog not landing in the
      // DOM until ~190-350ms later — a portal-mounted dialog with its own
      // mount/animation delay. Waiting for the fillable-field COUNT to
      // increase past its pre-click value (bounded, so a page where the
      // click didn't reveal anything new doesn't hang) is what actually
      // detects the new field, unlike a plain existence check.
      try {
        await page.waitForFunction(
          ({ selector, before }: { selector: string; before: number }) =>
            (globalThis as any).document.querySelectorAll(selector).length > before,
          { selector: fillableSelector, before: countBefore },
          { timeout: 3000 },
        );
      } catch {
        // Nothing NEW appeared within the budget — still report the click
        // as having happened; the caller's own candidate/keyword-scan
        // retries will simply come up empty and fall through as before.
      }
      return true;
    } catch {
      // trigger not clickable (hidden, detached, etc.) — try the next strategy
    }
  }
  return false;
}

/**
 * The reuse half of Workflow Memory (§11.2 step 2): given a spec that
 * worked on a previous run, try to rebuild it and confirm it STILL matches
 * exactly one element. Deliberately stricter than resolveTarget's own
 * candidates (which take the first match of several strategies) — a
 * remembered locator that now matches zero or more-than-one elements is
 * exactly the "page drifted" signal that should trigger a re-learn instead
 * of silently clicking the wrong thing.
 */
export async function resolveFromSpec(page: Page, spec: LocatorSpec): Promise<Locator | null> {
  try {
    const loc = locatorForSpec(page, spec);
    const count = await loc.count();
    return count === 1 ? loc.first() : null;
  } catch {
    return null;
  }
}

function locatorForSpec(page: Page, spec: LocatorSpec): Locator {
  if (spec.kind === "role") {
    return page.getByRole(spec.role as Parameters<Page["getByRole"]>[0], { name: spec.name, exact: false });
  }
  if (spec.kind === "text") {
    return page.getByText(spec.text, { exact: false });
  }
  if (spec.kind === "placeholder") {
    return page.getByPlaceholder(spec.placeholder, { exact: false });
  }
  return page.locator(spec.css);
}

async function resolveWithLlm(page: Page, step: Step): Promise<ResolvedTarget | null> {
  let snapshot: string;
  try {
    // Playwright >= 1.49 ARIA snapshot, trimmed per §4.3 step 1.
    snapshot = await (page.locator("body") as any).ariaSnapshot();
    if (snapshot.length > 6000) snapshot = snapshot.slice(0, 6000);
  } catch {
    snapshot = await page.title().catch(() => "");
  }

  const model = process.env.RESOLVE_MODEL ?? "openai/gpt-oss-20b";
  try {
    // Confirmed live: chatJson has no timeout of its own, and a slow/stuck
    // Groq call here can silently eat the ENTIRE remaining step budget. When
    // the outer per-step timeout (executeRun.ts) then fires and closes the
    // page/browser out from under this still-in-flight call, every
    // subsequent Playwright call this function makes (locator.count(),
    // page.title(), etc., all used in its own error-diagnostic fallbacks)
    // throws "Target page, context or browser has been closed" — a
    // confusing secondary error that buries the real cause (this call
    // simply took too long) and looked, at first glance, like Tenfold's own
    // bug rather than an unbounded LLM call. Bounding it here means a slow
    // Groq response reliably surfaces as this function returning `null`
    // (falling through to the same ElementNotFoundError a real "no match"
    // would produce) well before the outer step timeout, instead of
    // racing it.
    const raw = await withLlmTimeout(
      chatJson({
        model,
        system:
          'Given an ARIA snapshot of a web page and a natural-language target description, ' +
          'return ONLY JSON: {"role":string,"name":string} OR {"text":string} OR {"css":string}. ' +
          "Prefer role+name. Use css only as a last resort.",
        user: `Target: ${step.target}\n\nARIA snapshot:\n${snapshot}`,
      }),
      Number(process.env.RESOLVE_LLM_TIMEOUT_MS ?? 8000),
    );
    const rawSpec = JSON.parse(stripFences(raw));
    const spec: LocatorSpec | null =
      rawSpec.role && rawSpec.name
        ? { kind: "role", role: rawSpec.role, name: rawSpec.name }
        : rawSpec.text
          ? { kind: "text", text: rawSpec.text }
          : rawSpec.css
            ? { kind: "css", css: rawSpec.css }
            : null;
    if (!spec) return null;

    const loc = locatorForSpec(page, spec);
    if ((await loc.first().count()) > 0) return { locator: loc.first(), spec };

    // A very common real-world case: the LLM correctly names a form field
    // by its visible/placeholder text (role: "textbox", name: "Username"),
    // but the element has no accessible name at all — only a `placeholder`
    // attribute, no <label> or aria-label (Saucedemo's login form is
    // exactly this). getByRole's `name` matches accessible name, not
    // placeholder, so it comes up empty even though the LLM's answer was
    // right in substance. Before giving up, retry the same `name` as a
    // placeholder for textbox/combobox roles — cheap, and covers this
    // pattern without needing a second LLM round-trip.
    if (spec.kind === "role" && (spec.role === "textbox" || spec.role === "combobox")) {
      const phSpec: LocatorSpec = { kind: "placeholder", placeholder: spec.name };
      const phLoc = locatorForSpec(page, phSpec);
      if ((await phLoc.first().count()) > 0) return { locator: phLoc.first(), spec: phSpec };
    }

    // The LLM answered, but its answer doesn't resolve to anything on the
    // real page — worth knowing about when this is the reason a step
    // reports ELEMENT_NOT_FOUND instead of assuming Groq was never reached.
    console.error(`[tenfold-core] LLM resolver returned a spec that matched 0 elements for target "${step.target}":`, spec);
    return null;
  } catch (err) {
    // Swallowed by design (falls through to ElementNotFoundError, which is
    // the correct user-facing failure either way) but silent otherwise —
    // an auth/network/parse failure here looked identical to "the deterministic
    // heuristics just couldn't find it" until this was added, which made a
    // real live-mode ELEMENT_NOT_FOUND much harder to diagnose than it
    // needed to be. A timeout gets its own clearly-labeled branch (rather
    // than folding into the generic message below) since it's the one
    // failure mode confirmed live to otherwise look like a totally
    // unrelated "page has been closed" crash once the outer step timeout
    // raced this call and won.
    if (err instanceof LlmTimeoutError) {
      console.error(
        `[tenfold-core] LLM resolver call for target "${step.target}" did not respond within ` +
          `${err.timeoutMs}ms — treating as no match rather than letting it run past the step's own deadline.`,
      );
      return null;
    }
    console.error(`[tenfold-core] LLM resolver call failed for target "${step.target}":`, err);
    return null;
  }
}

const STOPWORDS = new Set([
  "a", "an", "the", "to", "for", "on", "in", "of", "and", "or", "button",
  "field", "input", "box", "click", "add", "go", "open", "page", "type",
  "enter", "select", "with", "this", "that",
]);

function significantWords(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 1 && !STOPWORDS.has(w));
}

/**
 * Scans every element with the given ARIA role for one whose accessible
 * name contains all of the target's significant words, regardless of order
 * — a cheap, deterministic middle ground between a strict substring match
 * and a full LLM resolver call. Bounded to the first 30 matches on the page
 * so a pathological page can't make this scan expensive.
 */
async function keywordScan(page: Page, role: string, needle: string): Promise<{ locator: Locator; name: string } | null> {
  const words = significantWords(needle);
  if (words.length === 0) return null;
  const locator = page.getByRole(role as Parameters<Page["getByRole"]>[0]);
  const count = Math.min(await locator.count().catch(() => 0), 30);
  for (let i = 0; i < count; i++) {
    const el = locator.nth(i);
    const name = (await accessibleName(el)).toLowerCase();
    if (words.every((w) => name.includes(w))) return { locator: el, name };
  }
  return null;
}

/**
 * Approximates the computed accessible name for a keyword-scan candidate.
 * `innerText()` alone is NOT the accessible name — confirmed live to be a
 * real, silent miss: GitHub's actual search trigger is an icon-only
 * `<button aria-label="Search or jump to, type / to search">` with no
 * visible text content at all, so `innerText()` returns "" and the keyword
 * scan skipped straight past the one element that should have matched,
 * falling through all the way to the (much slower, and in this case
 * hanging) LLM resolver. `aria-label` wins when present (matches the real
 * accessible-name-computation priority order closely enough for this
 * heuristic's purposes — an exact implementation would also need
 * aria-labelledby, native <label> association, alt/title, etc., but those
 * either don't apply to button/link roles or are rare enough not to be
 * worth the extra round trips here); falls back to visible text otherwise.
 */
async function accessibleName(el: Locator): Promise<string> {
  const ariaLabel = await el.getAttribute("aria-label").catch(() => null);
  if (ariaLabel && ariaLabel.trim()) return ariaLabel;
  return el.innerText().catch(() => "");
}

function firstQuoted(text: string): string | undefined {
  const m = text.match(/"([^"]+)"|'([^']+)'/);
  return m?.[1] ?? m?.[2];
}

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

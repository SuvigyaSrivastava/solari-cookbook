"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { createRun, fetchHealth, type HealthResponse } from "@/lib/runnerClient";

const FLAKEMART_URL = process.env.NEXT_PUBLIC_FLAKEMART_URL ?? "http://localhost:3100";

const DEFAULT_PLAN = [
  "Open the homepage",
  `Add "Blue Hoodie" to the cart`,
  "Go to the cart and apply coupon SAVE10",
  "Confirm the total shows a 10% discount",
  "Click Checkout and confirm an order number appears",
].join("\n");

export default function LandingPage() {
  const router = useRouter();
  const [targetUrl, setTargetUrl] = useState(FLAKEMART_URL);
  const [stepsText, setStepsText] = useState(DEFAULT_PLAN);
  const [runs, setRuns] = useState(10);
  const [stealth, setStealth] = useState(true);
  const [captcha, setCaptcha] = useState(false);
  // "auto" leaves it to Tenfold's own shouldDefaultProxy() heuristic (proxy
  // on for any real external target); "us"/"none" are explicit overrides —
  // see TestPlanOptions.proxy's own comment in packages/core/src/types.ts
  // for why "not set" and "off" are meaningfully different states, not the
  // same thing with a different label. Exposed here (not just via
  // shouldDefaultProxy's silent guess) because a free-tier Solari account
  // can't actually afford proxy+stealth together — confirmed live via
  // 402 FeatureRequiresPlan against a real bot-protected target — so a
  // BYOK caller on a paid plan needs a way to force it on explicitly rather
  // than hoping the auto-heuristic's guess lines up with their plan limits.
  const [proxy, setProxy] = useState<"auto" | "us" | "none">("auto");
  const [advanced, setAdvanced] = useState(false);
  const [byokKey, setByokKey] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [health, setHealth] = useState<HealthResponse | null>(null);

  useEffect(() => {
    let cancelled = false;
    const load = () => fetchHealth().then((h) => !cancelled && setHealth(h)).catch(() => undefined);
    load();
    const id = setInterval(load, 8000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      const steps = stepsText
        .split("\n")
        .map((l) => l.trim())
        .filter(Boolean);
      const { runId } = await createRun({
        targetUrl,
        steps,
        runs,
        options: { stealth, captcha, ...(proxy === "auto" ? {} : { proxy }) },
        solariApiKey: byokKey.trim() || undefined,
      });
      router.push(`/runs/${runId}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setSubmitting(false);
    }
  }

  return (
    <main className="container">
      <div className="hero-wrap">
        <span className="eyebrow">Built on Solari</span>
        <h1 className="hero-headline">
          Your test passed.
          <br />
          Run it ten times.
          <svg className="scribble" viewBox="0 0 300 20" fill="none" aria-hidden="true">
            <path
              d="M2 12C60 4 140 4 200 10C230 13 260 9 298 6"
              stroke="var(--accent)"
              strokeWidth="5"
              strokeLinecap="round"
            />
          </svg>
        </h1>
      </div>
      <p className="hero-sub">
        Tenfold runs your plain-English test plan 10× in parallel in real cloud Chrome and
        reports the <em>flake rate</em> — with a session replay attached to every failure.
      </p>

      <div className="sticky-row">
        <span className="sticky yellow">10× parallel runs</span>
        <span className="sticky blue">real cloud Chrome</span>
        <span className="sticky orange">replay every failure</span>
      </div>

      <table className="diff-table">
        <thead>
          <tr>
            <th>Everyone else</th>
            <th>Tenfold</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td>Runs once → pass / fail</td>
            <td className="win">Runs 10× → 80% pass, fails at step 4</td>
          </tr>
          <tr>
            <td>A screenshot, maybe</td>
            <td className="win">A replay of every failure</td>
          </tr>
          <tr>
            <td>&quot;It works on my machine&quot;</td>
            <td className="win">Real Chrome, real network, 10 machines</td>
          </tr>
        </tbody>
      </table>

      <div className="lines">
        <div>
          <strong>Flake rate is a distribution, not a boolean.</strong> We show the histogram.
        </div>
        <div>
          <strong>We report our own misses separately.</strong> If the agent misread the page,
          that&apos;s on us, not your site — and we say so.
        </div>
        <div>
          <strong>Every run prints its cost.</strong> A 10-browser run against Flakemart costs
          about $0.001–0.01.
        </div>
        <div>
          <strong>It remembers your site.</strong> Workflow Memory reuses locators it already
          resolved instead of re-asking an LLM every run — up to 70% cheaper on a warm run, and
          it re-learns automatically the moment the page actually changes.
        </div>
        <div>
          <strong>Built on Solari:</strong> stealth cloud Chrome, per-session recording, one API
          key.
        </div>
      </div>

      <form className="card" onSubmit={handleSubmit}>
        <div className="form-row">
          <label htmlFor="targetUrl">Target</label>
          <input
            id="targetUrl"
            type="url"
            required
            value={targetUrl}
            onChange={(e) => setTargetUrl(e.target.value)}
          />
        </div>
        <div className="form-row">
          <label htmlFor="steps">Plan (one plain-English step per line)</label>
          <textarea id="steps" required value={stepsText} onChange={(e) => setStepsText(e.target.value)} />
        </div>

        {error && <div className="error-banner">{error}</div>}

        <button className="btn" type="submit" disabled={submitting}>
          {submitting ? "Starting…" : "Run it 10 times"}
        </button>

        {health && (
          <div className="stat-strip">
            <span>
              Runs today: <span className="num">{health.runsToday}</span>
            </span>
            <span>
              Total cost: <span className="num">${health.spentTodayUsd.toFixed(2)}</span>
            </span>
            <span>
              Solari sessions opened: <span className="num">{health.sessionsToday}</span>
            </span>
          </div>
        )}

        <p style={{ marginTop: 20 }}>
          <button
            type="button"
            className="btn-secondary"
            onClick={() => setAdvanced((a) => !a)}
          >
            {advanced ? "Hide advanced options" : "Try your own URL / advanced options"}
          </button>
        </p>

        {advanced && (
          <div style={{ marginTop: 16 }}>
            <div className="form-row">
              <label htmlFor="runs">Runs: {runs}</label>
              <input
                id="runs"
                type="range"
                min={3}
                max={15}
                value={runs}
                onChange={(e) => setRuns(Number(e.target.value))}
              />
            </div>
            <div className="form-row checkbox-row">
              <input
                id="stealth"
                type="checkbox"
                checked={stealth}
                onChange={(e) => setStealth(e.target.checked)}
              />
              <label htmlFor="stealth" style={{ margin: 0, textTransform: "none" }}>
                Stealth mode (recommended)
              </label>
            </div>
            <div className="form-row checkbox-row">
              <input
                id="captcha"
                type="checkbox"
                checked={captcha}
                onChange={(e) => setCaptcha(e.target.checked)}
              />
              <label htmlFor="captcha" style={{ margin: 0, textTransform: "none" }}>
                Solve captchas ($0.01/solve)
              </label>
            </div>
            <div className="form-row">
              <label htmlFor="proxy">Residential proxy</label>
              <select
                id="proxy"
                value={proxy}
                onChange={(e) => setProxy(e.target.value as "auto" | "us" | "none")}
              >
                <option value="auto">Auto (on for real external sites)</option>
                <option value="us">Always on (US)</option>
                <option value="none">Always off</option>
              </select>
              <p style={{ fontSize: 12, color: "var(--text-faint)", marginTop: 4 }}>
                Bot-protected sites (Cloudflare, etc.) usually need this. Requires a Solari plan
                that supports stealth + proxy together — a free-tier key will silently run a
                degraded, unprotected session instead (you&apos;ll see a warning in the report if
                that happens).
              </p>
            </div>
            <div className="form-row">
              <label htmlFor="byok">Bring your own Solari key (optional)</label>
              <input
                id="byok"
                type="text"
                placeholder="slr_live_…"
                value={byokKey}
                onChange={(e) => setByokKey(e.target.value)}
              />
            </div>
            <p style={{ fontSize: 12, color: "var(--text-faint)" }}>
              Your key is used for this request only and never stored.
            </p>
          </div>
        )}
      </form>

      <div className="cta-band">
        <svg
          viewBox="0 0 900 200"
          preserveAspectRatio="none"
          style={{ position: "absolute", inset: 0, width: "100%", height: "100%", opacity: 0.22 }}
          aria-hidden="true"
        >
          <path
            d="M -20 40 Q 60 -10 140 40 T 320 30"
            stroke="#fff8ec"
            strokeWidth="3"
            fill="none"
          />
          <path
            d="M 920 160 Q 840 190 760 150 T 580 170"
            stroke="#fff8ec"
            strokeWidth="3"
            fill="none"
          />
        </svg>
        <h2>Stop shipping tests that lie.</h2>
        <p>Ten runs tell you what one run can&apos;t.</p>
        <a className="btn-cream" href="#targetUrl">
          Try it above ↑
        </a>
      </div>

      <footer className="tenfold-footer">
        Tenfold is a submission to the Pinetree Research / Solari hiring challenge — a fork of{" "}
        <a href="https://github.com/solari-sdk/solari-cookbook" target="_blank" rel="noreferrer">
          solari-cookbook
        </a>
        .
      </footer>
    </main>
  );
}

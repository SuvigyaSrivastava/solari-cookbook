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
        options: { stealth, captcha },
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
      <h1 className="hero-headline">Your test passed. Run it ten times.</h1>
      <p className="hero-sub">
        Tenfold runs your plain-English test plan 10× in parallel in real cloud Chrome and
        reports the <em>flake rate</em> — with a session replay attached to every failure.
      </p>

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

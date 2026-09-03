# Deploying Tenfold

Three independent deployables. All three can run with zero external API
keys in mock mode — see the root README's "Running with zero API keys"
section — so you can deploy and demo today, then wire in real `SOLARI_API_KEY`
/ `GROQ_API_KEY` whenever you have them, with no code changes.

## 1. Flakemart → Render (Web Service)

Zero dependencies, plain Node — the simplest possible Render deploy.

1. New **Web Service** on Render, point at your fork.
2. Root directory: `examples/browser-flake-tenfold-ts/apps/flakemart`
3. Build command: *(none needed)*
4. Start command: `node server.mjs`
5. Env var: `PORT` is set automatically by Render — Flakemart already reads
   `process.env.PORT`.
6. Note the assigned URL (e.g. `https://flakemart-xyz.onrender.com`) — you'll
   need it for both the runner and web deploys below.

## 2. Runner → Render (Web Service)

1. New **Web Service** on Render, same repo.
2. Root directory: `examples/browser-flake-tenfold-ts`
3. Build command: `pnpm install && pnpm --filter @tenfold/core build`
4. Start command: `pnpm --filter runner start`
5. Env vars (Render dashboard → Environment):
   ```
   RUNNER_PORT=10000          # Render injects PORT; set RUNNER_PORT to match, or
                              # read process.env.PORT directly if you prefer
   ALLOWED_ORIGIN=https://<your-vercel-web-domain>
   # Note: the runner never talks to Flakemart directly, so there is no
   # FLAKEMART_URL variable here — Flakemart's deployed URL only matters to
   # the WEB app below, as NEXT_PUBLIC_FLAKEMART_URL.
   DAILY_BUDGET_USD=3.00
   MAX_RUNS_PER_IP_PER_DAY=5
   DEFAULT_N=10
   MAX_N=15
   HARD_DEADLINE_MS=120000
   # Optional — omit to run in mock mode:
   SOLARI_API_KEY=
   GROQ_API_KEY=
   # Optional — omit to use the in-memory store (resets on redeploy):
   DATABASE_URL=
   ```
6. **Persistence (optional but recommended for anything beyond a demo):**
   add a Render Postgres instance, copy its connection string into
   `DATABASE_URL`, then run `infra/schema.sql` against it once:
   ```bash
   psql "$DATABASE_URL" -f infra/schema.sql
   ```

Render's free/starter web services sleep on inactivity — the first request
after a cold start will be slow. Fine for a demo; upgrade the instance type
if this matters for judging day.

## 3. Web → Vercel

1. New Vercel project, same repo.
2. Root directory: `examples/browser-flake-tenfold-ts/apps/web`
3. Framework preset: Next.js (auto-detected).
4. Build command / install command: Vercel's defaults work, but since this
   is a pnpm workspace, set the install command to run from the repo root:
   ```
   cd ../.. && pnpm install
   ```
   (or use Vercel's "Root Directory" + "Include files outside the root
   directory" setting, which handles this automatically for pnpm
   workspaces as of recent Vercel CLI versions.)
5. Env vars (Vercel dashboard → Settings → Environment Variables):
   ```
   NEXT_PUBLIC_RUNNER_URL=https://<your-runner-render-domain>
   NEXT_PUBLIC_FLAKEMART_URL=https://<your-flakemart-render-domain>
   ```
6. Deploy. The landing page's pre-filled demo form should immediately work
   against the deployed Flakemart + runner.

## After all three are live

- Visit the Vercel URL, click **Run it 10 times**, confirm you get a
  `FLAKY` verdict with replays/screenshots.
- Append `?flake=0` to the Flakemart target URL in the "Try your own URL"
  form and confirm you get `STABLE`.
- Once you have a `SOLARI_API_KEY`, set it on the runner service and
  redeploy — no code changes needed. Confirm `client.mode` flips to `"live"`
  (visible in the report's `mode` field) and that real replay links appear.
- Real commercial sites (Amazon, eBay, IMDb, Stack Overflow — all confirmed
  live) reject datacenter-IP traffic with a bare HTTP 403 before Tenfold's
  own logic ever runs, which every cloud browser is vulnerable to. The
  runner now defaults Solari's residential proxy (`options.proxy: "us"`) on
  for any non-local target automatically — no action needed — but be aware
  this adds real proxy cost/latency on every live run against an external
  site; a target you control (your own staging/prod, or Flakemart itself)
  gets no benefit from it either way, but pays the same small overhead. Set
  `options.proxy` explicitly in a run request if you need to opt out.

## Forking upstream

This example lives at `examples/browser-flake-tenfold-ts/` inside a fork of
`solari-sdk/solari-cookbook`. Once the fork exists:

1. Add one row to the upstream root `README.md`'s "Cloud browser" examples
   table pointing at `browser-flake-tenfold-ts` (TypeScript).
2. Keep the fork public from the first commit — this is a judging
   requirement, not a suggestion.
3. Commit with small, real messages (`fanout: cap N at 15, add per-run cost
   estimate`) — reviewers read commit history.

-- Tenfold runner schema. Works against Neon, Render Postgres, Railway, or a
-- local Postgres instance — anything reachable via DATABASE_URL.
--
-- Note on `browser_runs`: the MVP runner stores each browser's full result
-- (including sessionId, replayUrl, cause, screenshots) inside `runs.report`
-- as JSONB (see TenfoldReport.perRun in packages/core/src/types.ts), so the
-- web app never needs to join against this table. `browser_runs` is kept
-- here, matching the brief's original schema, as the natural next step for
-- P1 work that needs to query across runs (e.g. "show me every failure with
-- cause=ASSERTION_FAILED across all runs this week") without scanning JSONB.

create table if not exists runs (
  id uuid primary key,
  status text not null,                    -- queued|running|done|error
  target_url text not null,
  plan jsonb,
  mode text not null,                       -- demo|byok
  report jsonb,
  cost_usd numeric(10,6) default 0,
  created_at timestamptz not null default now(),
  finished_at timestamptz
);

create table if not exists browser_runs (
  id uuid primary key default gen_random_uuid(),
  run_id uuid references runs(id) on delete cascade,
  idx int not null,
  session_id text,
  status text,
  cause text,
  first_failure_step int,
  replay_url text,
  replay_status text,                       -- pending|ready|failed|expired|disabled
  started_at timestamptz,
  ended_at timestamptz,
  result jsonb
);
create index if not exists browser_runs_run_id_idx on browser_runs(run_id);

create table if not exists events (
  run_id uuid not null references runs(id) on delete cascade,
  seq bigserial,
  type text not null,
  payload jsonb not null,
  at timestamptz not null default now(),
  primary key (run_id, seq)
);
create index if not exists events_run_id_seq_idx on events(run_id, seq);

create table if not exists spend (
  day date primary key,
  usd numeric(10,6) not null default 0,
  runs_count int not null default 0,
  sessions_count int not null default 0
);

-- Per-IP daily run count for the demo-mode budget guard (brief §1: "a
-- per-IP cap (5 runs/day)"). Not in the brief's original table list but
-- required to implement that constraint against real persistence.
create table if not exists ip_runs (
  day date not null,
  ip text not null,
  count int not null default 0,
  primary key (day, ip)
);

-- Workflow Memory (§11.1): Tenfold remembers how it resolved a step against
-- a given site and reuses that resolution instead of paying for a fresh LLM
-- resolver call on every run, as long as the page hasn't drifted since.
-- Locators, a page-structure fingerprint, and a one-line reason ONLY — never
-- page content, form values, or anything a user typed (§11.1's explicit
-- rule). Written by apps/runner/src/postgresStepMemoryStore.ts.
create table if not exists step_memory (
  id uuid primary key default gen_random_uuid(),
  target_host text not null,          -- hostname only; memory is per site
  step_text_hash text not null,       -- sha256 of the normalized English step
  locator jsonb not null,             -- { kind: "role"|"text"|"css", ... } from the resolver
  fingerprint text not null,          -- simhash of the aria snapshot it was resolved against
  expect_text text,                   -- the expect that confirmed it
  reason text,                        -- resolver's/relearn's one-line reason for this choice
  hits int not null default 0,
  misses int not null default 0,
  last_verified_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  unique (target_host, step_text_hash)
);
create index if not exists step_memory_host_idx on step_memory(target_host);

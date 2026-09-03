import { config as loadEnv } from "dotenv";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { serve } from "@hono/node-server";
import { InMemoryStepMemoryStore } from "@tenfold/core";
import { createServer } from "./server.js";
import { createMemoryStore } from "./memoryStore.js";
import { createPostgresStore } from "./postgresStore.js";
import { createPostgresStepMemoryStore } from "./postgresStepMemoryStore.js";

// The shared .env lives at the example's root (browser-flake-tenfold-ts/.env),
// two levels above this file (apps/runner/src/index.ts) — not at whatever
// directory the process happens to be launched from (`pnpm --filter runner
// dev` runs with cwd=apps/runner, so a bare `dotenv/config` import would
// silently find nothing and every process.env.* read below would fall back
// to its default, exactly as happened the first time this was run outside
// the sandbox it was built in). Explicit path, so it works the same whether
// this is started via pnpm, `tsx src/index.ts` directly, or a built dist/.
const here = dirname(fileURLToPath(import.meta.url));
loadEnv({ path: resolve(here, "../../../.env") });

const store = process.env.DATABASE_URL
  ? createPostgresStore(process.env.DATABASE_URL)
  : createMemoryStore();

// Workflow Memory (§11) gets the same demo/production split as run rows:
// Postgres (step_memory, infra/schema.sql) when DATABASE_URL is set, an
// in-process Map otherwise — lost on restart, but still lets a single
// long-lived demo process show reuse across runs against the same site.
const stepMemoryStore = process.env.DATABASE_URL
  ? createPostgresStepMemoryStore(process.env.DATABASE_URL)
  : new InMemoryStepMemoryStore();

if (!process.env.DATABASE_URL) {
  console.warn(
    "[tenfold-runner] DATABASE_URL not set — using the in-memory store. " +
      "Runs and spend tracking (and Workflow Memory) reset on restart. Fine " +
      "for local dev/demo; set DATABASE_URL (see infra/schema.sql) for " +
      "anything that needs to persist.",
  );
}

const app = createServer(store, stepMemoryStore);
const port = Number(process.env.RUNNER_PORT ?? 8787);

// Visibility for exactly the ambiguity that made a real live-mode
// ELEMENT_NOT_FOUND hard to diagnose: without this, "the LLM resolver
// wasn't reached" and "the LLM resolver was reached and still couldn't
// find the element" printed identically (nothing) in the runner's own
// terminal. The CLI already prints an equivalent line; the runner never did.
console.log(
  `[tenfold-runner] LLM backend: ${process.env.GROQ_API_KEY ? "Groq (live)" : "local heuristic compiler (GROQ_API_KEY not set)"}`,
);

serve({ fetch: app.fetch, port }, (info) => {
  console.log(`[tenfold-runner] listening on http://localhost:${info.port}`);
});

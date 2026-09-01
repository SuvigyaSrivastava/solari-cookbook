import { serve } from "@hono/node-server";
import { InMemoryStepMemoryStore } from "@tenfold/core";
import { createServer } from "./server.js";
import { createMemoryStore } from "./memoryStore.js";
import { createPostgresStore } from "./postgresStore.js";
import { createPostgresStepMemoryStore } from "./postgresStepMemoryStore.js";

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

serve({ fetch: app.fetch, port }, (info) => {
  console.log(`[tenfold-runner] listening on http://localhost:${info.port}`);
});

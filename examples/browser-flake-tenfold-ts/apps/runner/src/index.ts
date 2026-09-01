import { serve } from "@hono/node-server";
import { createServer } from "./server.js";
import { createMemoryStore } from "./memoryStore.js";
import { createPostgresStore } from "./postgresStore.js";

const store = process.env.DATABASE_URL
  ? createPostgresStore(process.env.DATABASE_URL)
  : createMemoryStore();

if (!process.env.DATABASE_URL) {
  console.warn(
    "[tenfold-runner] DATABASE_URL not set — using the in-memory store. " +
      "Runs and spend tracking reset on restart. Fine for local dev/demo; " +
      "set DATABASE_URL (see infra/schema.sql) for anything that needs to persist.",
  );
}

const app = createServer(store);
const port = Number(process.env.RUNNER_PORT ?? 8787);

serve({ fetch: app.fetch, port }, (info) => {
  console.log(`[tenfold-runner] listening on http://localhost:${info.port}`);
});

import { EventEmitter } from "node:events";
import type { TenfoldEvent } from "@tenfold/core";

/**
 * In-process pub/sub for live SSE fan-out. A run's events also get
 * persisted via Store.appendEvent so a client that connects to
 * GET /runs/:id/events after the run already started (or after a page
 * refresh) can replay history before subscribing to what's still live —
 * see server.ts.
 */
const bus = new EventEmitter();
bus.setMaxListeners(0);

export function publish(runId: string, event: TenfoldEvent): void {
  bus.emit(runId, event);
}

export function subscribe(runId: string, onEvent: (event: TenfoldEvent) => void): () => void {
  bus.on(runId, onEvent);
  return () => bus.off(runId, onEvent);
}

/**
 * Minimal counting semaphore — enough to satisfy §5's "p-limit at 1
 * concurrent Tenfold run in demo mode, 3 in BYOK mode" without pulling in a
 * dependency for four lines of logic.
 */
export function createSemaphore(limit: number) {
  let active = 0;
  const queue: Array<() => void> = [];

  async function acquire(): Promise<() => void> {
    if (active >= limit) {
      await new Promise<void>((resolve) => queue.push(resolve));
    }
    active++;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      active--;
      const next = queue.shift();
      if (next) next();
    };
  }

  return { acquire };
}

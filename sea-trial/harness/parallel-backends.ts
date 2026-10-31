import { availableParallelism } from "node:os";

/** Native CLIs use their own threads and children; reserve half the cores, cap at four. */
export async function runBackends<T>(
  targets: readonly string[],
  run: (target: string) => Promise<T>,
  cores = availableParallelism(),
): Promise<T[]> {
  const concurrency = Math.max(1, Math.min(4, Math.floor(cores / 2)));
  const results: T[] = [];
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, targets.length) }, async () => {
    while (next < targets.length) {
      const index = next++;
      const target = targets[index];
      if (target !== undefined) { results[index] = await run(target); }
    }
  }));
  return results;
}

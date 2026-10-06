/**
 * What is left of a budget that ends at `deadline` (epoch milliseconds). None
 * left is a timeout, which rejects: `${name} timed out`.
 */
export function remainingMs(deadline: number, name: string): number {
  const remaining = deadline - Date.now();
  if (remaining <= 0) {
    throw new Error(`${name} timed out`);
  }
  return remaining;
}

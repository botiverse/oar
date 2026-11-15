/** Every message along an error's `cause` chain, one per line: what a host could log. */
export function errorChain(error: unknown): string {
  let chain = "";
  for (let link: unknown = error; link instanceof Error; link = link.cause) { chain += `${link.message}\n`; }
  return chain;
}

/** The rejection of a promise expected to reject, or null when it resolved. */
export async function rejectionOf(pending: Promise<unknown>): Promise<unknown> {
  try { await pending; return null; } catch (error) { return error; }
}

import type { LineProcess } from "./process.js";
import { killGraceMs } from "./process-signals.js";

/**
 * End a line process through stdin EOF, letting native shutdown finish while
 * preserving process-tree cleanup, then fall back to kill after the grace period.
 */
export async function closeLineProcess(child: LineProcess): Promise<void> {
  if (child.stopping()) { await child.exited; return; }
  await child.prepareShutdown();
  if (child.stopping()) { await child.exited; return; }
  const timer = setTimeout(() => { child.kill(); }, killGraceMs());
  child.markNativeStop();
  child.stdin.end();
  try { await child.exited; }
  finally { clearTimeout(timer); }
}

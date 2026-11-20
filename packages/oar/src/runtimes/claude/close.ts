import type { LineProcess } from "../../shared/executable/index.js";
import { killGraceMs } from "../../shared/executable/process-signals.js";

/** EOF lets Claude finish its own shutdown (including in-flight OAuth refreshes) before process-tree cleanup enforces the bound. */
export async function closeClaude(child: LineProcess): Promise<void> {
  if (child.stopping()) { await child.exited; return; }
  await child.prepareShutdown();
  if (child.stopping()) { await child.exited; return; }
  const timer = setTimeout(() => { child.kill(); }, killGraceMs());
  child.markNativeStop();
  child.stdin.end();
  try { await child.exited; }
  finally { clearTimeout(timer); }
}

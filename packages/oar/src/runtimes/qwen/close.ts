import type { LineProcess } from "../../shared/executable/index.js";

/** EOF lets native initialization finish and release its extension-store lock before exit. */
export async function closeQwen(child: LineProcess): Promise<void> {
  const timer = setTimeout(() => { child.kill(); }, 5000);
  child.stdin.end();
  try { await child.exited; }
  finally { clearTimeout(timer); }
}

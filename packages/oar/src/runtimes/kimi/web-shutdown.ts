import { type LineProcess } from "../../shared/executable/index.js";
import { kimiWebRequest, type WebEndpoint } from "./web-query.js";

// Native 2.6.3 preserved a cancelled 600 ms refresh and exited in 693-709 ms.
// Two seconds gives that measured path headroom, not a remote-service guarantee.
export const KIMI_WEB_SHUTDOWN_GRACE_MS = 2000;

/** Use a fresh cleanup signal: a cancelled query must still request native shutdown. */
export async function stopKimiWeb(child: LineProcess, web: WebEndpoint): Promise<void> {
  if (child.stopping()) { await child.exited; return; }
  const controller = new AbortController();
  const deadline = Promise.withResolvers<never>();
  const timer = setTimeout(() => {
    deadline.reject(new Error("Kimi native shutdown timed out"));
    controller.abort();
  }, KIMI_WEB_SHUTDOWN_GRACE_MS);
  let graceful = false;
  const shutdown = async (): Promise<void> => {
    await child.prepareShutdown();
    controller.signal.throwIfAborted();
    child.markNativeStop();
    await kimiWebRequest(web, controller.signal, "/shutdown", "POST");
    await child.exited;
  };
  try { await Promise.race([shutdown(), deadline.promise]); graceful = true; }
  catch { /* A failed native request retains the existing bounded process cleanup. */ }
  finally {
    clearTimeout(timer); controller.abort();
    if (!graceful && !child.stopping()) { child.kill(); }
    await child.exited;
  }
}

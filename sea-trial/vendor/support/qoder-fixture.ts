import { onTestFinished } from "vitest";
import { startQoderNative, type QoderNativeEnv, type QoderReply } from "../../harness/qoder-native.js";

/** Windows HOME deletion can take 21 to 43 seconds after the native process exits. */
export async function qoderFixture(replies: readonly QoderReply[], delayMs = 1): Promise<Omit<QoderNativeEnv, "stop">> {
  const fixture = await startQoderNative(replies, delayMs);
  // Preserve each test's behavior deadline. Cleanup has its own bounded hook;
  // a rejection or timeout still fails the test, and the next test waits for it.
  onTestFinished(fixture.stop, 90_000);
  return { home: fixture.home, options: fixture.options };
}

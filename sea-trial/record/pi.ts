import { startPiAimock } from "../harness/aimock.js";
import { toolRoundFixtures } from "../vendor/support/tool-round.js";
import type { RecordRequest } from "./claude.js";

/**
 * pi has no bare-metal provider on dev machines, so we record REAL pi SDK
 * events (the shapes our fold consumes) with the provider scripted via
 * pi-aimock — same fidelity as the pi-aimock behavior tests. We keep the SDK
 * event verbatim (it is already the scrubbed shape the projection reads).
 */
export async function startPiRecording(request: RecordRequest): Promise<Record<string, unknown>[]> {
  // Script a two-round tool conversation so the recording exercises pi's
  // tool_execution_* events (the interesting projection path), not just text.
  const env = await startPiAimock((mock) => {
    toolRoundFixtures(mock, (command) => ({ name: "bash", arguments: JSON.stringify({ command }) }));
  });
  const sdk = await import("@earendil-works/pi-coding-agent");
  const session = await sdk.createAgentSession({
    cwd: process.cwd(),
    ...(process.env.OAR_PI_AGENT_DIR === undefined ? {} : { agentDir: process.env.OAR_PI_AGENT_DIR }),
  }).then((result) => result.session);
  const raw: Record<string, unknown>[] = [];
  session.subscribe((event) => {
    raw.push({ ...event });
  });
  await session.prompt("please run the tool as instructed");
  for (const followUp of request.followUps.filter((p) => !p.startsWith("+"))) {
    await session.prompt(followUp);
  }
  session.dispose();
  await env.stop();
  return raw;
}

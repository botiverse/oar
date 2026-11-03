/* oxlint-disable import/max-dependencies -- The probe composes the real ACP transport, host and provider, without the product compact control. */
/* oxlint-disable eslint/no-await-in-loop -- Native scenarios and their records are intentionally sequential. */
/** Direct native controls, with only the model provider replaced. */
import { setImmediate as settle } from "node:timers/promises";
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { grokRuntime, opencodeRuntime } from "../../packages/oar/src/index.js";
import { grokAcpProfile } from "../../packages/oar/src/runtimes/grok/session.js";
import { opencodeV2AcpProfile } from "../../packages/oar/src/runtimes/opencode/session.js";
import { createAcpClientApp } from "../../packages/oar/src/shared/acp/client-app.js";
import { createAcpTerminalHost } from "../../packages/oar/src/shared/acp/terminal.js";
import { openAcpSession } from "../../packages/oar/src/shared/acp/profile.js";
import { startAcpProcess, withAcpDeadline } from "../../packages/oar/src/shared/acp/process.js";
import { acpErrorNative } from "../../packages/oar/src/shared/acp/projection.js";
import { asRecord } from "../../packages/oar/src/shared/json.js";
import { startGrokAimock, startOpencodeAimock } from "../../sea-trial/harness/aimock-acp.js";

const [backend, output] = process.argv.slice(2);
assert.ok((backend === "grok" || backend === "opencode") && output !== undefined);
const results: unknown[] = [];
for (const scenario of (backend === "opencode" ? ["completed", "failed", "cancelled", "empty", "invalid_summary"] : ["completed", "failed", "cancelled", "empty"])) {
  let phase = "seed";
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const fixture = await (backend === "grok" ? startGrokAimock : startOpencodeAimock)((mock) => {
    mock.onMessage(/[\s\S]*/u, async () => {
      if (phase === "cancelled") { entered.resolve(); await release.promise; }
      if (phase === "failed") { return { error: { message: "OAR_NATIVE_COMPACT_FAILURE", type: "invalid_request_error" }, status: 400 }; }
      if (phase === "invalid_summary") { return { content: "Deliberately missing the required native summary headings." }; }
      return { content: `## Objective\nKeep the controlled conversation.\n## Work State\n${"A local synthetic conversation was summarized. ".repeat(80)}`, usage: { input_tokens: 10_000, output_tokens: 1000 } };
    });
  });
  const runtime: typeof grokRuntime | typeof opencodeRuntime = backend === "grok" ? grokRuntime : opencodeRuntime;
  const profile = backend === "grok" ? grokAcpProfile : opencodeV2AcpProfile;
  const installation = await runtime.installation();
  assert.ok(installation.kind === "available" && installation.via === "executable");
  const cwd = fixture.env.HOME ?? "";
  const options = { cwd, env: fixture.env };
  const terminal = createAcpTerminalHost(cwd, fixture.env);
  const updates: unknown[] = [];
  const client = createAcpClientApp(terminal, {
    update: (value) => { updates.push(value); },
    extension: (method, value) => { updates.push({ method, ...value }); },
    requested: () => {}, answered: () => {}, extensionNotifications: profile.extensionNotifications ?? [],
  });
  const args = typeof profile.args === "function" ? profile.args(options) : profile.args;
  const nativeProcess = startAcpProcess(installation.command, args, client, { cwd, env: fixture.env });
  const timer = setTimeout(() => { nativeProcess.kill(); }, 45_000);
  try {
    const opened = await openAcpSession(nativeProcess, profile, options);
    const request = async (method: string, params: Record<string, unknown>): Promise<unknown> => {
      const result = await withAcpDeadline(nativeProcess, method, null, async (settings) => {
        const response = await nativeProcess.connection.agent.request(method, params, settings);
        return response;
      });
      return result;
    };
    if (scenario !== "empty") {
      for (const input of ["OAR_SEED_ONE", "OAR_SEED_TWO"]) {
        await request("session/prompt", { sessionId: opened.sessionId, prompt: [{ type: "text", text: input }] });
      }
    }
    updates.splice(0);
    phase = scenario;
    const method = backend === "grok" ? "_x.ai/compact_conversation" : "session/prompt";
    const params = { sessionId: opened.sessionId, ...(backend === "grok" ? {} : { prompt: [{ type: "text", text: "/compact" }] }) };
    // oxlint-disable-next-line unicorn/prefer-top-level-await -- The cancellation branch must run concurrently with the native response.
    const waiting = (async (): Promise<{ kind: string; value: unknown }> => {
      try { return { kind: "success", value: await request(method, params) }; }
      catch (error) { return { kind: "error", value: acpErrorNative(error) }; }
    })();
    if (scenario === "cancelled") {
      await Promise.race([entered.promise, (async (): Promise<never> => { await waiting; throw new Error("native operation ended before provider request"); })()]);
      await nativeProcess.connection.agent.notify("session/cancel", { sessionId: opened.sessionId });
    }
    const answer = await waiting;
    release.resolve();
    await settle();
    const markers = updates.filter((value) => {
      const update = asRecord(asRecord(value)?.update);
      // oxlint-disable-next-line eslint/no-underscore-dangle -- Native ACP extension metadata.
      return typeof update?.sessionUpdate === "string" && (update.sessionUpdate.includes("compact") || asRecord(update._meta)?.["opencode/compaction"] !== undefined);
    });
    const result = { backend, version: installation.version, scenario, answer, markers };
    results.push(result);
    console.log(JSON.stringify(result));
    await writeFile(output, `${JSON.stringify(results, null, 2)}\n`);
  } finally { clearTimeout(timer); release.resolve(); await nativeProcess.prepareShutdown(); nativeProcess.kill(); await nativeProcess.exited; await terminal.dispose(); await fixture.stop(); }
}

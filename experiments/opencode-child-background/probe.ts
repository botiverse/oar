/** Compare native background child delivery with and without the extension capability. */
/* oxlint-disable import/max-dependencies -- Reuse isolated provider, native ACP transport, and owned fixture cleanup. */
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { acpFixture } from "../sharing/acp-fixture.js";
import { preservingProbeEvidence } from "../sharing/fixture-lifetime.js";
import { createAcpClientApp } from "../../packages/oar/src/shared/acp/client-app.js";
import { createAcpTerminalHost } from "../../packages/oar/src/shared/acp/terminal.js";
import { startAcpProcess } from "../../packages/oar/src/shared/acp/process.js";
import { asRecord } from "../../packages/oar/src/shared/json.js";

const [output, mode] = process.argv.slice(2);
assert.ok(output !== undefined, "Supply a private output directory");
assert.ok(mode === "enabled" || mode === "disabled", "Choose enabled or disabled");
const directory = path.resolve(output);
await mkdir(directory, { recursive: true, mode: 0o700 });
const fixture = await acpFixture("opencode");
const started = Date.now();
interface Frame { readonly atMs: number; readonly direction: "toRuntime" | "fromRuntime"; readonly message: unknown }
const wire: Frame[] = [];
const terminal = createAcpTerminalHost(fixture.cwds[0] ?? fixture.home, fixture.env);
const app = createAcpClientApp(terminal, {
  update: () => {}, requested: () => {}, answered: () => {}, extension: () => {},
  extensionNotifications: ["opencode/session/child_update"],
});
let summary: unknown = null;
await preservingProbeEvidence(async () => {
  assert.equal(fixture.installation.via, "executable");
  const child = startAcpProcess(fixture.installation.command, ["acp"], app, {
    cwd: fixture.cwds[0] ?? fixture.home, env: fixture.env,
    incoming: (message) => { wire.push({ atMs: Date.now() - started, direction: "fromRuntime", message }); return message; },
    outgoing: (message) => { wire.push({ atMs: Date.now() - started, direction: "toRuntime", message }); },
  });
  fixture.children.push(child);
  const initialized = await fixture.request(child, "initialize", {
    protocolVersion: 1,
    clientCapabilities: { fs: {}, terminal: true, ...(mode === "enabled" ? { _meta: { "opencode/child-session-updates": true } } : {}) },
    clientInfo: { name: "oar-background-evidence", version: "1" },
  });
  const session = await fixture.open({ child, initialized, args: ["acp"] }, "A", { withMcp: false });
  const result = await fixture.prompt(child, session.id, "A_child");
  const promptReturnedMs = Date.now() - started;
  // Keep the same observation window in both modes, even when completion arrives early.
  await delay(60_000);
  const notifications = wire.flatMap((frame) => {
    const message = asRecord(frame.message);
    const params = asRecord(message?.params);
    return typeof message?.method === "string" && params !== null ? [{ atMs: frame.atMs, method: message.method, params }] : [];
  });
  const extensions = notifications.filter((frame) => frame.method === "opencode/session/child_update");
  const childFrames = notifications.filter((frame) => frame.method === "session/update"
    // oxlint-disable-next-line eslint/no-underscore-dangle -- Native ACP field name.
    && asRecord(asRecord(frame.params.update)?._meta)?.["opencode/child-session"] !== undefined);
  const completedReports = fixture.seen.flatMap((entry) => {
    const request = asRecord(entry.request);
    const messages: readonly unknown[] = Array.isArray(request?.messages) ? request.messages : [];
    return messages.filter((value: unknown) => {
      const message = asRecord(value);
      return message?.role === "user" && typeof message.content === "string"
        && message.content.includes("<subagent ") && message.content.includes('state="completed"');
    });
  });
  summary = { version: fixture.installation.version, capabilityEnabled: mode === "enabled", promptReturnedMs,
    waitAfterPromptMs: 60_000, keys: fixture.seen.map(({ key, stage }) => ({ key, stage })),
    childFrameCount: childFrames.length, extensionCount: extensions.length,
    childStatuses: extensions.filter((frame) => frame.params.type === "status").map((frame) => ({ atMs: frame.atMs, status: frame.params.status })),
    nativeCompletedReportCount: completedReports.length, result };
  await writeFile(path.join(directory, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`, { mode: 0o600 });
  process.stdout.write(`${JSON.stringify(summary)}\n`);
}, [
  async (): Promise<void> => { await writeFile(path.join(directory, "raw.json"), `${JSON.stringify({ summary, wire, seen: fixture.seen, calls: fixture.calls }, null, 2)}\n`, { mode: 0o600 }); },
  async (): Promise<void> => { await terminal.dispose(); },
  async (): Promise<void> => { await fixture.stop(); },
]);

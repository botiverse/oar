/* oxlint-disable import/max-dependencies, eslint/max-params -- Native timing probe composes the real transport and a local model provider. */
/**
 * Timestamp Grok's child frames before SDK dispatch on a two-root connection.
 * pnpm tsx experiments/sharing/grok-child-order.ts [output-directory]
 * No real login: disposable home, local scripted model, native Grok 1.0.70.
 */
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { grokInstallation } from "../../packages/oar/src/runtimes/grok/installation.js";
import { grokAcpProfile } from "../../packages/oar/src/runtimes/grok/session.js";
import { createRoutedAcpClientApp } from "../../packages/oar/src/shared/acp/client-app.js";
import { startAcpProcess, withAcpDeadline } from "../../packages/oar/src/shared/acp/process.js";
import { acpLineageOf } from "../../packages/oar/src/shared/acp/records.js";
import { asRecord, type JsonRecord } from "../../packages/oar/src/shared/json.js";
import { startGrokAimock } from "../../sea-trial/harness/aimock-acp.js";
import { probeFixture, probeErrorText, usingProbeFixture } from "./fixture-lifetime.js";

interface Wire {
  readonly sequence: number;
  readonly elapsedMs: number;
  readonly receivedAt: number;
  readonly message: JsonRecord;
}

const output = path.resolve(process.argv[2] ?? "oar-trial-run/grok-child-order");
await mkdir(output, { recursive: true });
const wire: Wire[] = [];
const rows: JsonRecord[] = [];
const responses: unknown[] = [];
const start = performance.now();
const report: JsonRecord = { at: new Date().toISOString(), platform: process.platform, arch: process.arch,
  timing: "Decoded native incoming message before SDK dispatch; monotonic elapsed milliseconds", rows };

function observed(entry: Wire): { params: JsonRecord | null; update: JsonRecord | null; output: JsonRecord | null } {
  const params = asRecord(entry.message.params);
  const update = asRecord(params?.update);
  return { params, update, output: asRecord(update?.rawOutput) };
}

function summarize(root: string, offset: number, latencyMs: number, round: number): JsonRecord {
  const events = wire.slice(offset);
  const completed = events.find(entry => {
    const { params, output: result } = observed(entry);
    return params?.sessionId === root && typeof result?.subagent_id === "string";
  });
  assert.ok(completed !== undefined, "parent tool result must name its child");
  const childId = observed(completed).output?.subagent_id;
  assert.equal(typeof childId, "string");
  const first = events.find(entry => observed(entry).params?.sessionId === childId);
  assert.ok(first !== undefined, "child must emit its own frame");
  const links = events.filter(entry => {
    const { params } = observed(entry);
    if (params === null) { return false; }
    const link = acpLineageOf(params);
    return link?.parent === root && link.child === childId;
  });
  const spawn = links.find(entry => observed(entry).update?.sessionUpdate === "subagent_spawned");
  assert.ok(spawn !== undefined, "native subagent_spawned must carry the same explicit relation as the completed tool");
  const [earliest] = links; assert.ok(earliest !== undefined);
  const children = events.filter(entry => observed(entry).params?.sessionId === childId);
  return { round, scriptedChildLatencyMs: latencyMs, childFrames: children.length,
    firstChildSequence: first.sequence, firstChildMethod: first.message.method,
    spawnSequence: spawn.sequence, completedToolSequence: completed.sequence,
    earliestAssociationKind: observed(earliest).update?.sessionUpdate,
    associationMinusFirstChildMs: earliest.elapsedMs - first.elapsedMs,
    completedMinusFirstChildMs: completed.elapsedMs - first.elapsedMs,
    spawnAndToolAgree: true,
    links: links.map(entry => ({ sequence: entry.sequence, kind: observed(entry).update?.sessionUpdate,
      relativeToFirstChildMs: entry.elapsedMs - first.elapsedMs })),
    childTimeline: children.map(entry => ({ sequence: entry.sequence, method: entry.message.method,
      kind: observed(entry).update?.sessionUpdate ?? null, relativeToFirstChildMs: entry.elapsedMs - first.elapsedMs })),
  };
}

try {
  await usingProbeFixture(async () => {
    const value = await probeFixture(async defer => {
      const installation = await grokInstallation();
      assert.ok(installation.kind === "available" && installation.via === "executable");
      assert.match(installation.version ?? "", /^grok 1\.0\.70 \(/u);
      report.installationVersion = installation.version;
      const stages = new Map<string, number>();
      const provider = await startGrokAimock(mock => {
        mock.on({ predicate: () => true }, async request => {
          const user = request.messages.findLast(message => message.role === "user" && /ORDER_(?:ROOT|CHILD|PEER)_\d+_\d+/u.test(JSON.stringify(message.content)));
          const match = /ORDER_(?<role>ROOT|CHILD|PEER)_(?<latency>\d+)_(?<round>\d+)/u.exec(JSON.stringify(user));
          if (match === null) { return { content: "metadata" }; }
          const [key, role, latency] = match;
          assert.ok(latency !== undefined);
          const stage = stages.get(key) ?? 0; stages.set(key, stage + 1);
          if (role === "ROOT" && stage === 0) {
            return { toolCalls: [{ id: `call_${key}`, name: "spawn_subagent", arguments: JSON.stringify({
              prompt: key.replace("ROOT", "CHILD"), description: "Observe child ancestry timing", background: false,
            }) }] };
          }
          if (role === "CHILD") { await delay(Number(latency)); }
          return { content: `${key}_ANSWER` };
        });
      });
      defer(async () => { await provider.stop(); });
      const home = provider.env.HOME; assert.ok(home !== undefined);
      const cwds = [path.join(home, "a"), path.join(home, "b")];
      await Promise.all(cwds.map(async cwd => { await mkdir(cwd, { recursive: true }); }));
      const platformEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => ["systemroot", "windir", "comspec", "pathext", "temp", "tmp"].includes(key.toLowerCase())));
      const app = createRoutedAcpClientApp({
        target: async () => { await Promise.resolve(); throw new Error("Text-only timing probe received an unexpected host request"); },
        update: () => {}, extension: () => {}, extensionNotifications: grokAcpProfile.extensionNotifications ?? [],
      });
      const { args } = grokAcpProfile; assert.ok(Array.isArray(args));
      const native = startAcpProcess(installation.command, args, app, {
        cwd: home, env: { PATH: process.env.PATH ?? "", ...platformEnv, ...provider.env, USERPROFILE: home, NO_PROXY: "*" },
        inheritStderr: false,
        incoming: message => {
          const record = asRecord(message); assert.ok(record !== null);
          wire.push({ sequence: wire.length, elapsedMs: performance.now() - start, receivedAt: Date.now(), message: record });
          return message;
        },
      });
      defer(async () => { native.kill(); await native.exited; });
      const request = async (method: string, params: JsonRecord): Promise<JsonRecord> => {
        const reply = await withAcpDeadline(native, method, 30_000, async options => {
          const result = await native.connection.agent.request(method, params, options); return result;
        });
        const result = asRecord(reply); assert.ok(result !== null); return result;
      };
      const initialized = await request("initialize", { protocolVersion: 1, clientCapabilities: { fs: {}, terminal: true },
        clientInfo: { name: "oar-grok-child-order", version: "1" }, _meta: grokAcpProfile.initializeMeta?.({ cwd: home }) ?? {} });
      // oxlint-disable-next-line eslint/no-underscore-dangle -- Grok reports its version in the ACP extension envelope.
      report.nativeVersion = asRecord(initialized._meta)?.agentVersion;
      assert.equal(report.nativeVersion, "1.0.70");
      const auth = grokAcpProfile.selectAuthMethod?.(initialized);
      if (auth !== undefined) { await request("authenticate", { methodId: auth }); }
      const roots = await Promise.all(cwds.map(async cwd => {
        const opened = await request("session/new", { cwd, mcpServers: [], _meta: { yoloMode: true } });
        assert.equal(typeof opened.sessionId, "string"); return String(opened.sessionId);
      }));
      return { roots, request, native };
    });
    return value;
  }, async fixture => {
    const [root, peer] = fixture.roots; assert.ok(root !== undefined && peer !== undefined && root !== peer);
    for (const latencyMs of [0, 250, 1500, 5000]) {
      for (let round = 0; round < 3; round++) {
        const offset = wire.length;
        const prompt = async (sessionId: string, text: string): Promise<JsonRecord> => {
          const result = await fixture.request("session/prompt", { sessionId, prompt: [{ type: "text", text }] }); return result;
        };
        // oxlint-disable-next-line no-await-in-loop -- Each measured child starts after the prior sample completes, while its peer runs concurrently.
        responses.push(await Promise.all([prompt(root, `ORDER_ROOT_${latencyMs}_${round}`), prompt(peer, `ORDER_PEER_${latencyMs}_${round}`)]));
        const row = summarize(root, offset, latencyMs, round); rows.push(row);
        console.log(JSON.stringify(row));
      }
    }
    report.unexpectedHostRequests = wire.filter(entry => typeof entry.message.method === "string" && "id" in entry.message).length;
    assert.equal(report.unexpectedHostRequests, 0);
    report.completed = true;
  });
} catch (error) { report.error = probeErrorText(error); process.exitCode = 1; }
finally {
  await writeFile(path.join(output, "wire.json"), JSON.stringify(wire, null, 2));
  await writeFile(path.join(output, "responses.json"), JSON.stringify(responses, null, 2));
  await writeFile(path.join(output, "evidence.json"), JSON.stringify(report, null, 2));
}

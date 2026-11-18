/* oxlint-disable max-statements, max-lines-per-function -- Keep each native observation and its resource cleanup together. */
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { serveMcpTools, kimiRuntime, type Session, type HostTool, type ExecutableInstallation } from "../../../packages/oar/src/index.js";
import { awaitTurnEnd } from "../../../packages/oar/src/observe/turns.js";
import { createAcpClient, methods, startAcpProcess, withAcpDeadline } from "../../../packages/oar/src/shared/acp/process.js";
import { asRecord, type JsonRecord } from "../../../packages/oar/src/shared/json.js";
import { startKimiAimock } from "../../harness/aimock-acp.js";
import { ALPHA, BETA, defined, loggingProxy } from "./tools-list-changed.js";

export interface KimiCatalogOptions {
  readonly mode: "prepared-native" | "cold-native" | "cold-oar";
  readonly delayMs: number;
}
export interface KimiCatalogRun {
  readonly mode: KimiCatalogOptions["mode"];
  readonly delayMs: number;
  readonly log: readonly string[];
  readonly marks: readonly { event: string; at: number }[];
  readonly preparation: readonly (readonly string[])[];
  readonly turns: readonly [readonly (readonly string[])[], readonly (readonly string[])[]];
  readonly relisted: boolean;
  readonly frames: readonly { direction: string; message: unknown }[];
  readonly provider: Awaited<ReturnType<typeof startKimiAimock>>["raw"];
}

const tool = (name: string): HostTool => ({ name, description: `Probe ${name}, never called.`, inputSchema: { type: "object", properties: {} }, handler: () => name });

/** Direct ACP preparation is confined to this native declaration control, never an OAR startup workaround. */
export async function runKimiCatalog(installation: ExecutableInstallation, options: KimiCatalogOptions): Promise<KimiCatalogRun> {
  const served = await serveMcpTools({ name: "probe", tools: [tool(ALPHA)] });
  const log: string[] = [];
  const marks: { event: string; at: number }[] = [];
  const mark = (event: string): void => { marks.push({ event, at: performance.now() }); };
  const listed = Promise.withResolvers<void>();
  let firstList = true;
  const proxy = await loggingProxy(served, log, async () => {
    if (!firstList) { return; }
    firstList = false;
    mark("list_response_ready");
    if (options.delayMs > 0) { await delay(options.delayMs); }
    mark("list_response_released");
    listed.resolve();
  });
  const f = await startKimiAimock(mock => { mock.onMessage(/[\s\S]*/u, { content: "ok" }); });
  const home = f.env.HOME; const kimiHome = f.env.KIMI_CODE_HOME;
  assert.ok(home !== undefined && kimiHome !== undefined);
  const server = { name: "probe", type: "http" as const, url: proxy.url, headers: [] };
  const frames: { direction: string; message: unknown }[] = [];
  let native: ReturnType<typeof startAcpProcess> | undefined = undefined;
  let session: Session | undefined = undefined;
  let preparationEnd = 0;
  try {
    let turn: ((text: string) => Promise<void>) | undefined = undefined;
    if (options.mode === "cold-oar") {
      session = await kimiRuntime.session(installation, { cwd: home, env: f.env, mcpServers: [{ name: "probe", type: "http", url: proxy.url }] });
      const opened = session;
      turn = async (text): Promise<void> => { const started = await opened.prompt(text); await awaitTurnEnd(opened, started.request.seq); };
    } else {
      if (options.mode === "prepared-native") {
        await writeFile(path.join(kimiHome, "mcp.json"), JSON.stringify({ mcpServers: { probe: { type: "http", url: proxy.url } } }));
      }
      const child = startAcpProcess(installation.command, ["acp"], createAcpClient({ name: "oar-kimi-catalog-control" }).onNotification(methods.client.session.update, () => {}), {
        cwd: home, env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, ...f.env }, inheritStderr: false,
        incoming: message => { frames.push({ direction: "in", message }); return message; },
        outgoing: message => { frames.push({ direction: "out", message }); },
      });
      native = child;
      const request = async (method: string, params: JsonRecord): Promise<JsonRecord> => asRecord(await withAcpDeadline(child, method, 60_000,
        async send => { const result = await child.connection.agent.request(method, params, send); return result; })) ?? {};
      const open = async (): Promise<string> => {
        const result = await request("session/new", { cwd: home, mcpServers: options.mode === "prepared-native" ? [] : [server] });
        assert.equal(typeof result.sessionId, "string");
        const id = String(result.sessionId);
        await request("session/set_mode", { sessionId: id, modeId: "yolo" });
        return id;
      };
      const prompt = async (sessionId: string, text: string): Promise<void> => {
        const result = await request("session/prompt", { sessionId, prompt: [{ type: "text", text }] });
        assert.equal(result.stopReason, "end_turn", JSON.stringify(result));
      };
      await request("initialize", { protocolVersion: 1, clientCapabilities: {} });
      if (options.mode === "prepared-native") {
        // Native before-step preparation joins workspace MCP discovery. A second
        // session in this same process snapshots that already connected catalog.
        await prompt(await open(), "prepare catalog: reply ok");
        mark("preparation_done");
        preparationEnd = f.raw.length;
      }
      const id = await open();
      turn = async (text): Promise<void> => { await prompt(id, text); };
    }
    mark("opened");
    // Explicitly wait for the reply and then two more seconds. A missing
    // catalog after this wait cannot be blamed on an early first prompt.
    const timeout = setTimeout(() => { listed.reject(new Error("MCP tools/list did not complete")); }, 15_000);
    try { await listed.promise; } finally { clearTimeout(timeout); }
    if (options.mode !== "prepared-native") { await delay(2000); }
    mark("first_prompt");
    await turn("first turn: reply ok");
    const afterFirst = f.raw.length;
    served.setTools([tool(BETA)]); log.push("setTools");
    // Keep the original notification observation bound, including no-relist runtimes.
    await delay(10_000);
    await turn("second turn: reply ok");
    mark("second_done");
    return { ...options, log, marks, preparation: f.raw.slice(0, preparationEnd).map(row => defined(row.body)),
      turns: [f.raw.slice(preparationEnd, afterFirst).map(row => defined(row.body)), f.raw.slice(afterFirst).map(row => defined(row.body))],
      relisted: log.slice(log.indexOf("setTools")).includes("tools/list"), frames, provider: [...f.raw] };
  } finally {
    await session?.dispose();
    native?.kill(); await native?.exited;
    await proxy.close(); await served.close(); await f.stop();
  }
}

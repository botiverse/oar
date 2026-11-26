/* oxlint-disable import/max-dependencies -- A real Pi child, a scripted provider, a per-session MCP server and the record/journal readers meet in this test. */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";
import type { PiSessionProvider } from "../../packages/oar/src/contracts/pi-provider.js";
import type { Session } from "../../packages/oar/src/contracts/session.js";
import { asRecord } from "../../packages/oar/src/shared/json.js";
import { startPiAimock } from "../harness/aimock.js";
import { runTurn, withProcessEnv } from "./support/asserts.js";
import { currentTurnSays, echoServers, expectedEchoes, leakedCredentials, scriptEchoes, startHttpEcho } from "./support/echo-mcp.js";
import { isPiBackend, piRpc, piSession } from "./support/pi-runtime.js";
import { structuralToolRound } from "./support/tool-round.js";

/**
 * SessionOptions.piProvider (and the compaction budget) on the REAL harness,
 * with a scripted provider in place of the model: the provider exists only in
 * the session's declaration — no models.json entry, no command line — and one
 * per-session MCP server comes along with it. The RPC child registers the
 * declaration from OAR's own extension while it loads; the in-process SDK
 * registers it in the session's model plane. The compaction budget is honored
 * in process and refused by the RPC child, which compacts from the settings
 * files it reads.
 */

/** The bundled installation: this file exercises the SDK and its own RPC child, never a host executable. */
const piInstallation = { kind: "available", via: "bundled" } as const;
const GATEWAY_KEY = "oar-gateway-key-4f1c9e77";
const GATEWAY_KEY_ENV = "OAR_TEST_GATEWAY_KEY";
const MODEL = "probe-small";

/** The provider a host declares for this session: aimock behind a gateway name no catalog carries. */
function declaredProvider(baseUrl: string): PiSessionProvider {
  return {
    id: "gateway",
    api: "anthropic-messages",
    baseUrl,
    apiKeyEnv: GATEWAY_KEY_ENV,
    models: [{ id: MODEL, name: "Probe Small", contextWindow: 200_000, maxTokens: 1024 }],
  };
}

/** The echo conversations plus a plain answer for the resumed turn. */
function scriptDeclaredProvider(mock: Parameters<typeof scriptEchoes>[0]): void {
  scriptEchoes(mock);
  mock.on({ predicate: currentTurnSays(/just answer/u) }, { content: "answered" });
}

/** The model id every provider request carried, from the mock's own journal. */
function requestedModels(mock: { getRequests(): readonly { readonly body: unknown }[] }): ReadonlySet<unknown> {
  return new Set(mock.getRequests().map((entry) => asRecord(entry.body)?.model));
}

/** How many requests carried a credential header: aimock redacts the value, so a present header is the evidence. */
function presentedCredentials(mock: { getRequests(): readonly { readonly headers: Record<string, string> }[] }): number {
  return mock.getRequests().filter((entry) => (entry.headers["x-api-key"] ?? "").length > 0).length;
}

async function cleanCwd(name: string): Promise<string> {
  // Canonicalize once: Pi's RPC child records its physical cwd for session lookup.
  return mkdtemp(path.join(tmpdir(), `oar-${name}-`));
}

async function disposeAll(sessions: readonly Session[]): Promise<void> {
  await Promise.all(sessions.map(async (session) => { await session.dispose(); }));
}

describe.skipIf(!isPiBackend)("pi host-declared provider", () => {
  test("a declared provider serves a turn and a per-session MCP tool, and a resume keeps its model", async () => {
    const http = await startHttpEcho();
    const env = await startPiAimock(scriptDeclaredProvider);
    const cwd = await cleanCwd("pi-provider");
    const sessions: Session[] = [];
    try {
      await withProcessEnv({ [GATEWAY_KEY_ENV]: GATEWAY_KEY }, async () => {
        // A bare model id the declaration serves: Pi is asked for
        // `gateway/probe-small` without the host spelling it.
        const session = await piSession(piInstallation, { cwd, model: MODEL, piProvider: declaredProvider(env.mock.url), mcpServers: echoServers(http.url) });
        sessions.push(session);
        expect(await structuralToolRound(session, env.mock, "please call both echo tools")).toEqual([
          "request:prompt",
          "response:accepted",
          "tool_call_started:mcp__echo__echo",
          "tool_call_ended",
          "tool_call_started:mcp__remote__echo",
          "tool_call_ended",
          "turn_ended:completed",
        ]);
        // Both servers' outputs reached the provider, so per-session MCP ran
        // next to the declaration instead of replacing it.
        const journal = JSON.stringify(env.mock.getRequests());
        for (const echo of expectedEchoes().slice(0, 2)) { expect(journal).toContain(echo); }
        // Every request named the declared model: the turn came from the
        // declaration, not from a catalog entry or models.json.
        expect(requestedModels(env.mock)).toEqual(new Set([MODEL]));
        // The credential resolved from the environment on the wire (aimock
        // records the header, redacted); OAR held only the NAME, and no record
        // carries the value.
        expect(presentedCredentials(env.mock)).toBeGreaterThan(0);
        expect(leakedCredentials(session)).toEqual([]);
        expect(JSON.stringify(session.records())).not.toContain(GATEWAY_KEY);
        await session.dispose();
        // Native resume, with no model given: the recorded one is restored
        // through the declaration, and the session file is Pi's own.
        const resumed = await piSession(piInstallation, { cwd, resume: session.id, piProvider: declaredProvider(env.mock.url) });
        sessions.push(resumed);
        expect(resumed.id).toBe(session.id);
        expect(await runTurn(resumed, "just answer")).toMatchObject({ kind: "completed" });
        expect(asRecord(env.mock.getLastRequest()?.body)?.model).toBe(MODEL);
        expect(JSON.stringify(resumed.records())).not.toContain(GATEWAY_KEY);
      });
    } finally {
      await disposeAll(sessions);
      await env.stop();
      http.stop();
      await rm(cwd, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
    }
  }, 180_000);

  test.skipIf(piRpc)("the compaction budget compacts this session at the declared trigger, not Pi's default", async () => {
    // Pi's pinned auto-compaction recipe: a reported usage and a window where
    // Pi's own 16384-token headroom would NOT compact (threshold 183_616) but
    // the declared 190_000 does (10_000), with a kept-recent window small
    // enough that there is history to summarize.
    const env = await startPiAimock((mock) => {
      mock.onMessage(/[\s\S]*/u, {
        content: `answered. ${"the quick brown fox jumps over the lazy dog. ".repeat(120)}`,
        usage: { input_tokens: 15_000, output_tokens: 400 },
      });
    });
    const cwd = await cleanCwd("pi-compaction");
    const sessions: Session[] = [];
    try {
      await withProcessEnv({ [GATEWAY_KEY_ENV]: GATEWAY_KEY }, async () => {
        const session = await piSession(piInstallation, { cwd, model: MODEL, piProvider: declaredProvider(env.mock.url), piCompaction: { reserveTokens: 190_000, keepRecentTokens: 500 } });
        sessions.push(session);
        await runTurn(session, "topic one");
        // The next prompt crosses the declared trigger before it is sent.
        await runTurn(session, "topic two");
        const compactionTypes = session.records()
          .flatMap((record) => (record.kind === "frame" && record.body.type.startsWith("compaction_") ? [record.body.type] : []));
        expect(compactionTypes).toContain("compaction_start");
        expect(compactionTypes).toContain("compaction_end");
      });
    } finally {
      await disposeAll(sessions);
      await env.stop();
      await rm(cwd, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
    }
  }, 180_000);

  test.skipIf(!piRpc)("the RPC child refuses the compaction budget before it starts", async () => {
    await expect(piSession(piInstallation, { cwd: process.cwd(), piCompaction: { reserveTokens: 100_000 } }))
      .rejects.toMatchObject({ name: "UnsupportedOptionError", option: "piCompaction" });
  });
});

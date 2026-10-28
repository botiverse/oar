/* oxlint-disable eslint/no-await-in-loop -- Resume phases must share one native conversation in order. */
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "vitest";
import { claudeInstallation, claudeSession, promptAndWait, type Session, type SessionOptions } from "../../packages/oar/src/index.js";
import { asRecord } from "../../packages/oar/src/shared/json.js";
import { startClaudeAimock } from "../harness/aimock.js";
import { expectAvailable } from "./support/asserts.js";

function bashArgument(value: string): string {
  return `'${value.replaceAll("\\", "/").replaceAll("'", String.raw`'\''`)}'`;
}

async function fixture(tool: "Write" | "Bash" = "Write", severity = 90): Promise<{
  readonly options: SessionOptions;
  readonly classifierCalls: () => number;
  readonly wrote: (marker: string) => Promise<boolean>;
  readonly stop: () => Promise<void>;
}> {
  // Windows tmpdir can contain an 8.3 alias that native permission checks
  // deliberately require manual approval for, even in acceptEdits mode.
  const temporary = await mkdtemp(path.join(tmpdir(), "oar-permission-mode-"));
  const directory = await realpath(temporary);
  const script = path.join(directory, "write-fixture.cjs");
  await writeFile(script, 'require("node:fs").writeFileSync(process.argv[2], process.argv[3]);\n');
  const calls = new Map<string, number>();
  let classifierCalls = 0;
  const provider = await startClaudeAimock((mock) => {
    mock.onMessage(/[\s\S]*/u, (request) => {
      if (JSON.stringify(request.messages).includes("<severity>")) {
        classifierCalls += 1;
        return { content: `<severity>${String(severity)}</severity>` };
      }
      const latest = request.messages.findLast((message) => message.role === "user" && /PERMISSION_PHASE_\d/u.test(JSON.stringify(message.content)));
      const marker = /PERMISSION_PHASE_\d/u.exec(JSON.stringify(latest))?.[0];
      if (marker === undefined) { return { content: "metadata" }; }
      const count = calls.get(marker) ?? 0;
      calls.set(marker, count + 1);
      const file = path.join(directory, `${marker}.txt`);
      const input = tool === "Write" ? { file_path: file, content: marker }
        : { command: [process.execPath, script, file, marker].map((argument) => bashArgument(argument)).join(" ") };
      return count === 0 ? { toolCalls: [{ id: marker, name: tool, arguments: JSON.stringify(input) }] } : { content: "finished" };
    });
  });
  return {
    options: {
      cwd: directory, model: "sonnet",
      env: { ...provider.env, HOME: directory, USERPROFILE: directory, CLAUDE_CONFIG_DIR: path.join(directory, ".claude"),
        ANTHROPIC_AUTH_TOKEN: null, CLAUDE_CODE_OAUTH_TOKEN: null, CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1" },
      launchArgs: ["--settings", '{"disableAllHooks":true}', "--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}'],
    },
    classifierCalls: () => classifierCalls,
    wrote: async (marker) => {
      const value = await readFile(path.join(directory, `${marker}.txt`), "utf8").then((text) => text, (error: unknown) => {
        if (error instanceof Error && "code" in error && error.code === "ENOENT") { return null; }
        throw error;
      });
      return value === marker;
    },
    stop: async () => { await provider.stop(); await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 }); },
  };
}

async function phase(session: Session, marker: string, mode: string): Promise<string> {
  expect(await promptAndWait(session, marker, { timeoutMs: 25_000 })).toMatchObject({ kind: "ended", outcome: { kind: "completed" } });
  const init = session.records().flatMap((record) => record.kind === "frame" && record.body.type === "system/init" ? [asRecord(record.body.native)] : []).at(-1);
  expect(init?.permissionMode).toBe(mode);
  expect(session.records().filter((record) => record.kind === "request" && record.direction === "toApp")).toEqual([]);
  return JSON.stringify(session.records().flatMap((record) => record.kind === "frame"
    ? record.body.events.filter((event) => event.kind === "tool_call_ended") : []));
}

test.skipIf(process.env.OAR_TEST !== "claude-aimock").each([
  ["default", false], ["dontAsk", false], ["acceptEdits", true], ["plan", false],
] as const)("Claude %s completes without an approval request and Write allowed=%s", async (mode, allowed) => {
  const setup = await fixture();
  let session: Session | undefined = undefined;
  try {
    const installation = await claudeInstallation();
    expectAvailable(installation, "Claude");
    session = await claudeSession(installation, { ...setup.options, launchArgs: [...setup.options.launchArgs ?? [], "--permission-mode", mode] });
    const results = await phase(session, "PERMISSION_PHASE_1", mode);
    expect(await setup.wrote("PERMISSION_PHASE_1"), results).toBe(allowed);
  } finally { await session?.dispose(); await setup.stop(); }
}, 60_000);

test.skipIf(process.env.OAR_TEST !== "claude-aimock")("Claude resume reapplies a restricted mode; omitting it restores OAR bypass", async () => {
  const setup = await fixture();
  let session: Session | undefined = undefined;
  try {
    const installation = await claudeInstallation();
    expectAvailable(installation, "Claude");
    let id: string | undefined = undefined;
    for (const [index, mode] of ["dontAsk", "dontAsk", undefined].entries()) {
      session = await claudeSession(installation, { ...setup.options, ...(id === undefined ? {} : { resume: id }),
        launchArgs: [...setup.options.launchArgs ?? [], ...(mode === undefined ? [] : [`--permission-mode=${mode}`, "--permission-prompts=none"])] });
      if (id !== undefined) { expect(session.id).toBe(id); }
      id = session.id;
      const marker = `PERMISSION_PHASE_${String(index)}`;
      const results = await phase(session, marker, mode ?? "bypassPermissions");
      expect(await setup.wrote(marker), results).toBe(mode === undefined);
      await session.dispose();
    }
  } finally { await session?.dispose(); await setup.stop(); }
}, 120_000);

// The native classifier's decision is model output, not a filesystem sandbox.
test.skipIf(process.env.OAR_TEST !== "claude-aimock").each([0, 90])("Claude plan Bash classifier severity %s retains its native effect", async (severity) => {
  const setup = await fixture("Bash", severity);
  let session: Session | undefined = undefined;
  try {
    const installation = await claudeInstallation();
    expectAvailable(installation, "Claude");
    session = await claudeSession(installation, { ...setup.options, launchArgs: [...setup.options.launchArgs ?? [], "--permission-mode=plan"] });
    const results = await phase(session, "PERMISSION_PHASE_1", "plan");
    expect(setup.classifierCalls()).toBeGreaterThan(0);
    expect(await setup.wrote("PERMISSION_PHASE_1"), results).toBe(severity === 0);
  } finally { await session?.dispose(); await setup.stop(); }
}, 60_000);

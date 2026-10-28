/** Native Claude permission modes against a local provider, with an isolated HOME.
 * OAR_CLAUDE_BIN=/absolute/claude pnpm tsx experiments/claude-permissions/probe.ts
 * Optional OAR_PERMISSION_CASE filters labels. No account or remote model calls.
 */
/* oxlint-disable eslint/no-await-in-loop -- Observe each native case independently. */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnLineProcess } from "../../packages/oar/src/shared/executable/index.js";
import { asRecord, asRecordList, parseJson } from "../../packages/oar/src/shared/json.js";
import { startClaudeAimock } from "../../sea-trial/harness/aimock.js";

interface Workspace { readonly home: string; readonly cwd: string; readonly id: string; }

interface Scenario {
  readonly label: string;
  readonly mode?: string;
  readonly none?: boolean;
  readonly stdio?: boolean;
  readonly answer?: "allow" | "deny";
  readonly tool: "Bash" | "Write";
  readonly bypass?: boolean;
  readonly classifierSeverity?: number;
  readonly configuredMode?: string;
}
const command = process.env.OAR_CLAUDE_BIN;
assert.ok(command !== undefined, "set OAR_CLAUDE_BIN to the Claude executable");
const root = await mkdtemp(path.join(tmpdir(), "oar-claude-permissions-"));
const output = path.resolve(process.env.OAR_PERMISSION_OUTPUT ?? "oar-trial-run/claude-permissions");
await mkdir(output, { recursive: true });
const reports: unknown[] = [];

async function run(scenario: Scenario, workspace: Workspace, resume = false): Promise<unknown> {
  const { home, cwd, id } = workspace;
  const marker = path.join(cwd, `${scenario.label}.txt`);
  let calls = 0;
  let classifierCalls = 0;
  const toolInput = scenario.tool === "Write"
    ? { file_path: marker, content: scenario.label }
    : { command: `node -e 'require("node:fs").writeFileSync(${JSON.stringify(marker)},${JSON.stringify(scenario.label)})'` };
  const provider = await startClaudeAimock((mock) => {
    mock.onMessage(/[\s\S]*/u, (request: { messages?: unknown }) => {
      if (JSON.stringify(request.messages).includes("<severity>")) {
        classifierCalls += 1;
        return { content: `<severity>${scenario.classifierSeverity ?? 0}</severity>` };
      }
      calls += 1;
      return calls === 1 ? { toolCalls: [{ name: scenario.tool, arguments: JSON.stringify(toolInput) }] } : { content: "probe complete" };
    });
  }, { captureRaw: true });
  const args = ["-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose", "--replay-user-messages", "--include-partial-messages", "--model", "haiku", resume ? "--resume" : "--session-id", id,
    "--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}', "--settings", JSON.stringify({ disableAllHooks: true,
      ...(scenario.configuredMode === undefined ? {} : { permissions: { defaultMode: scenario.configuredMode } }) }),
    ...(scenario.mode === undefined ? [] : ["--permission-mode", scenario.mode]),
    ...(scenario.none === true ? ["--permission-prompts", "none"] : []),
    ...(scenario.stdio === true ? ["--permission-prompt-tool", "stdio"] : []),
    ...(scenario.bypass === true ? ["--dangerously-skip-permissions"] : []),
  ];
  const child = spawnLineProcess(command ?? "claude", args, {
    cwd, killTree: true, inheritStderr: false,
    env: { PATH: process.env.PATH, LANG: "C.UTF-8", HOME: home, USERPROFILE: home, CLAUDE_CONFIG_DIR: path.join(home, ".claude"),
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1", ...provider.env },
  });
  const frames: unknown[] = [];
  const permissions: unknown[] = [];
  const done = Promise.withResolvers<string>();
  const ready = Promise.withResolvers<void>();
  const afterSettings = Promise.withResolvers<void>();
  const settingsEvidence: unknown[] = [];
  let result: unknown = null;
  let applied: unknown = null;
  const started = Date.now();
  let permissionTimer: ReturnType<typeof setTimeout> | undefined = undefined;
  const timer = setTimeout(() => { ready.resolve(); afterSettings.resolve(); done.resolve("deadline"); }, 25_000);
  child.onExit(() => { ready.resolve(); afterSettings.resolve(); done.resolve("exited"); });
  child.onLine((line) => {
    const message = asRecord(parseJson(line));
    if (message === null) { return; }
    const requestId = asRecord(message.response)?.request_id;
    if (message.type === "control_response" && (requestId === "settings" || requestId === "after-settings")) {
      const value = asRecord(asRecord(message.response)?.response);
      const selected = asRecord(value?.applied);
      settingsEvidence.push({ phase: requestId, fields: Object.keys(value ?? {}).toSorted(), appliedFields: Object.keys(selected ?? {}).toSorted(),
        topLevelMode: value?.permissionMode ?? null, configuredDefaultMode: asRecord(asRecord(value?.effective)?.permissions)?.defaultMode ?? null });
      applied = { permissionMode: selected?.permissionMode ?? null, model: selected?.model ?? null };
      if (requestId === "settings") { ready.resolve(); } else { afterSettings.resolve(); }
      return;
    }
    frames.push({ ms: Date.now() - started, message });
    if (message.type === "result") { result = message; done.resolve("result"); }
    const request = asRecord(message.request);
    if (message.type === "control_request" && request?.subtype === "can_use_tool") {
      permissions.push({ tool: request.tool_name, input: request.input, ms: Date.now() - started });
      if (scenario.answer === undefined) {
        permissionTimer ??= setTimeout(() => { done.resolve("unanswered_for_4000ms"); }, 4000);
      } else {
        child.write(`${JSON.stringify({ type: "control_response", response: { subtype: "success", request_id: message.request_id,
          response: scenario.answer === "allow" ? { behavior: "allow", updatedInput: request.input } : { behavior: "deny", message: "probe host denied" } } })}\n`);
      }
    }
  });
  let ended = "not_started";
  try {
    await child.spawned;
    child.write(`${JSON.stringify({ type: "control_request", request_id: "settings", request: { subtype: "get_settings" } })}\n`);
    await ready.promise;
    child.write(`${JSON.stringify({ type: "user", uuid: randomUUID(), message: { role: "user", content: `Run the requested probe ${scenario.label}.` } })}\n`);
    ended = await done.promise;
    if (ended === "result") {
      child.write(`${JSON.stringify({ type: "control_request", request_id: "after-settings", request: { subtype: "get_settings" } })}\n`);
      await afterSettings.promise;
    }
  } finally {
    clearTimeout(timer);
    clearTimeout(permissionTimer);
    child.kill();
    await child.exited;
    await provider.stop();
  }
  const wrote = await readFile(marker, "utf8").then((value) => value === scenario.label, () => false);
  const init = asRecordList(frames.map((frame) => asRecord(frame)?.message)).find((frame) => frame.type === "system" && frame.subtype === "init");
  const report = { ...scenario, resume, id, ended, wrote, calls, classifierCalls, applied, settingsEvidence, initPermissionMode: init?.permissionMode ?? null,
    nativeSessionId: asRecord(result)?.session_id ?? init?.session_id ?? null, permissions,
    result: result === null ? null : { subtype: asRecord(result)?.subtype, is_error: asRecord(result)?.is_error,
      permission_denials: asRecord(result)?.permission_denials }, ms: Date.now() - started };
  await writeFile(path.join(output, `${scenario.label}.json`), `${JSON.stringify({ report, frames, requests: provider.raw, diagnostics: child.diagnostics() }, null, 2)}\n`);
  reports.push(report);
  console.log(JSON.stringify(report));
  return report;
}

const scenarios: Scenario[] = [{ label: "bypass-bash", tool: "Bash", bypass: true }];
for (const mode of ["dontAsk", "default", "acceptEdits", "plan"]) {
  for (const tool of ["Bash", "Write"] as const) {
    scenarios.push({ label: `${mode}-${tool}`, mode, tool }, { label: `${mode}-${tool}-none`, mode, tool, none: true });
  }
}
for (const mode of ["dontAsk", "default", "acceptEdits", "plan"]) {
  scenarios.push({ label: `${mode}-stdio`, mode, tool: "Bash", stdio: true }, { label: `${mode}-stdio-none`, mode, tool: "Bash", stdio: true, none: true });
}
scenarios.push({ label: "settings-configured-acceptEdits-flag-plan", configuredMode: "acceptEdits", mode: "plan", tool: "Write", none: true },
  { label: "plan-stdio-high-severity", mode: "plan", tool: "Bash", stdio: true, classifierSeverity: 90 },
  { label: "default-stdio-allow", mode: "default", tool: "Bash", stdio: true, answer: "allow" },
  { label: "default-stdio-deny", mode: "default", tool: "Bash", stdio: true, answer: "deny" });
try {
  for (const scenario of scenarios.filter((entry) => process.env.OAR_PERMISSION_CASE === undefined || new RegExp(process.env.OAR_PERMISSION_CASE, "u").test(entry.label))) {
    const home = path.join(root, scenario.label, "home");
    const cwd = path.join(root, scenario.label, "work");
    await mkdir(home, { recursive: true });
    await mkdir(cwd, { recursive: true });
    await run(scenario, { home, cwd, id: randomUUID() });
  }
  if (process.env.OAR_PERMISSION_CASE === undefined || process.env.OAR_PERMISSION_CASE === "resume") {
    const home = path.join(root, "resume", "home");
    const cwd = path.join(root, "resume", "work");
    await mkdir(home, { recursive: true });
    await mkdir(cwd, { recursive: true });
    const id = randomUUID();
    await run({ label: "resume-1-acceptEdits", mode: "acceptEdits", tool: "Write", none: true }, { home, cwd, id });
    await run({ label: "resume-2-omitted", tool: "Write", none: true }, { home, cwd, id }, true);
    await run({ label: "resume-3-plan", mode: "plan", tool: "Write", none: true }, { home, cwd, id }, true);
    await run({ label: "resume-4-omitted-after-plan", tool: "Write", none: true }, { home, cwd, id }, true);
    await run({ label: "resume-5-acceptEdits", mode: "acceptEdits", tool: "Write", none: true }, { home, cwd, id }, true);
    const promptsId = randomUUID();
    await run({ label: "resume-prompts-1-none", mode: "default", tool: "Bash", stdio: true, none: true }, { home, cwd, id: promptsId });
    await run({ label: "resume-prompts-2-omitted", mode: "default", tool: "Bash", stdio: true }, { home, cwd, id: promptsId }, true);
  }
} finally {
  await writeFile(path.join(output, "report.json"), `${JSON.stringify(reports, null, 2)}\n`);
  await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}

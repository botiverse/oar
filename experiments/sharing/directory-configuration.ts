/** Observe project-file refresh separately from per-session MCP overrides. */
import { appendFile, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { asRecord, type JsonRecord } from "../../packages/oar/src/shared/json.js";

import { hookInputMatches, installDirectoryHook } from "./directory-hooks.js";

export interface DirectoryConfiguration {
  readonly setRevision: (revision: "A" | "B") => Promise<void>;
  readonly evidence: () => Promise<JsonRecord>;
}

function trustCondition(runtime: string): string {
  if (runtime === "codex") { return "Per-session bypass_hook_trust is supplied by the experiment, not persisted hook trust"; }
  if (runtime === "grok") { return "Disposable folder_trust.enabled=false before either native process starts; no persisted folder grant is tested"; }
  return "No additional trust override installed by this experiment";
}

export async function directoryConfiguration({ runtime, cwd, home, env = {} }: { runtime: string; cwd: string; home: string; env?: Readonly<Record<string, string>> | undefined }): Promise<DirectoryConfiguration> {
  if (runtime === "grok" && env.GROK_HOME !== undefined) {
    // Only this disposable home trusts the synthetic project instructions.
    await appendFile(path.join(env.GROK_HOME, "config.toml"), "\n[folder_trust]\nenabled = false\n");
  }
  const journal = path.join(home, "directory-hooks.jsonl");
  const script = path.join(home, "directory-hook.cjs");
  await writeFile(journal, "", { mode: 0o600 });
  await writeFile(script, [
    "const {appendFileSync}=require('node:fs');let raw='';process.stdin.setEncoding('utf8');process.stdin.on('data',part=>raw+=part);",
    "process.stdin.on('end',()=>{const event=JSON.parse(raw);",
    `appendFileSync(${JSON.stringify(journal)},JSON.stringify({revision:process.argv[2],cwd:process.cwd(),event})+'\\n');if(process.argv[3]==='antigravity')console.log('{"decision":"allow"}');});`,
  ].join("\n"), { mode: 0o600 });
  const projectRuleFile = runtime === "antigravity" ? "GEMINI.md" : "AGENTS.md";
  const revisions: JsonRecord[] = [];
  let hookScope = "not exercised";
  return {
    setRevision: async (revision) => {
      // The marker is never sent as a user prompt. Provider visibility therefore
      // shows a native project-file read, but an older marker can remain in history.
      await writeFile(path.join(cwd, projectRuleFile), `Project configuration observation marker: OAR_DIRECTORY_RULE_${revision}.\n`, { mode: 0o600 });
      const command = [process.execPath, script, revision, runtime].map((part) => JSON.stringify(part.replaceAll("\\", "/"))).join(" ");
      hookScope = await installDirectoryHook({ runtime, cwd, env, revision, command, journal });
      revisions.push({ revision, at: new Date().toISOString(), projectRuleFile });
    },
    evidence: async () => {
      const text = await readFile(journal, "utf8");
      return { revisions, hookScope,
      trustCondition: trustCondition(runtime),
      hooks: text.split("\n").filter(Boolean).map((line: string): unknown => JSON.parse(line)),
      limitation: "Markers in provider history do not prove the currently effective policy; absent markers or hook invocations do not prove unsupported configuration. Files in the same directory are intentionally shared, including with separate processes." };
    },
  };
}

export function directoryRuleMarkers(output: string): JsonRecord {
  return { initial: output.includes("OAR_DIRECTORY_RULE_A"), changed: output.includes("OAR_DIRECTORY_RULE_B") };
}

const configurationSnapshot = (row: JsonRecord, input: string): { markers: JsonRecord; hooks: string[] } => {
  const turns = Array.isArray(row.turns) ? row.turns.map(asRecord) : [];
  const markers = asRecord(turns.find((turn) => turn?.input === input)?.directoryRuleMarkers)
    ?? asRecord(asRecord(row.newSession)?.directoryRuleMarkers) ?? {};
  const configuration = asRecord(row.directoryConfiguration);
  const hooks = Array.isArray(configuration?.hooks) ? configuration.hooks.map(asRecord) : [];
  const revisions = hooks.filter((hook) => hookInputMatches(hook?.event, input))
    .map((hook) => String(hook?.revision));
  return { markers, hooks: revisions };
};

const hasMarker = (markers: JsonRecord): boolean => markers.initial === true || markers.changed === true;

/** Compare observations only; absent markers/hooks cannot establish freshness. */
export function compareDirectoryConfiguration(shared: JsonRecord, separate: JsonRecord, input = "B_mcpafter"): JsonRecord {
  const a = configurationSnapshot(shared, input); const b = configurationSnapshot(separate, input);
  const projectMarkersMatch = hasMarker(a.markers) || hasMarker(b.markers)
    ? a.markers.initial === b.markers.initial && a.markers.changed === b.markers.changed : null;
  const hookRevisionsMatch = a.hooks.length > 0 || b.hooks.length > 0 ? JSON.stringify(a.hooks) === JSON.stringify(b.hooks) : null;
  const missingEvidence = projectMarkersMatch === null || hookRevisionsMatch === null;
  return { projectMarkersMatch, hookRevisionsMatch, missingEvidence, passed: projectMarkersMatch === true && hookRevisionsMatch === true, differenceObserved: projectMarkersMatch === false || hookRevisionsMatch === false,
    limitation: "Only the later B session's observed project instruction markers and exercised hook revisions are compared. Null means missing evidence, not fresh configuration." };
}

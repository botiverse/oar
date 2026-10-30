/** Observe project-file refresh separately from per-session MCP overrides. */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { asRecord, type JsonRecord } from "../../packages/oar/src/shared/json.js";

export interface DirectoryConfiguration {
  readonly setRevision: (revision: "A" | "B") => Promise<void>;
  readonly evidence: () => Promise<JsonRecord>;
}

export async function directoryConfiguration({ runtime, cwd, home, kimiHome }: { runtime: string; cwd: string; home: string; kimiHome?: string | undefined }): Promise<DirectoryConfiguration> {
  const journal = path.join(home, "directory-hooks.jsonl");
  const script = path.join(home, "directory-hook.cjs");
  await writeFile(journal, "", { mode: 0o600 });
  await writeFile(script, [
    "const {appendFileSync}=require('node:fs');let raw='';process.stdin.setEncoding('utf8');process.stdin.on('data',part=>raw+=part);",
    "process.stdin.on('end',()=>{const event=JSON.parse(raw);",
    `appendFileSync(${JSON.stringify(journal)},JSON.stringify({revision:process.argv[2],cwd:process.cwd(),event})+'\\n');});`,
  ].join("\n"), { mode: 0o600 });
  const revisions: JsonRecord[] = [];
  return {
    setRevision: async (revision) => {
      // The marker is never sent as a user prompt. Provider visibility therefore
      // shows a native project-file read, but an older marker can remain in history.
      await writeFile(path.join(cwd, "AGENTS.md"), `Project configuration observation marker: OAR_DIRECTORY_RULE_${revision}.\n`, { mode: 0o600 });
      const command = [process.execPath, script, revision].map((part) => JSON.stringify(part.replaceAll("\\", "/"))).join(" ");
      if (runtime === "qoder") {
        await mkdir(path.join(cwd, ".qoder"), { recursive: true });
        await writeFile(path.join(cwd, ".qoder/settings.json"), JSON.stringify({ hooks: { PreToolUse: [{
          matcher: "mcp__scope__echo", hooks: [{ type: "command", command, timeout: 10 }],
        }] } }), { mode: 0o600 });
      }
      if (runtime === "kimi" && kimiHome !== undefined) {
        await writeFile(path.join(kimiHome, "config.toml"), `[[hooks]]\nevent = "PreToolUse"\nmatcher = "mcp__scope__echo"\ncommand = ${JSON.stringify(command)}\ntimeout = 10\n`, { mode: 0o600 });
      }
      revisions.push({ revision, at: new Date().toISOString(), projectRuleFile: "AGENTS.md" });
    },
    evidence: async () => {
      const text = await readFile(journal, "utf8");
      const scopes: Record<string, string> = { qoder: "project .qoder/settings.json", kimi: "disposable KIMI_CODE_HOME/config.toml" };
      return { revisions, hookScope: scopes[runtime] ?? "not exercised",
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
  const revisions = hooks.filter((hook) => asRecord(asRecord(hook?.event)?.tool_input)?.text === input)
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
    limitation: "Only the later B session's observed AGENTS.md markers and exercised hook revisions are compared. Null means missing evidence, not fresh configuration." };
}

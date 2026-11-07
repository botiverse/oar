/** Local-provider comparison of first/resumed prompts, directories and native snapshots. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { appendFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { awaitTurnEnd, opencodeInstallation, opencodeSession, type AvailableInstallation, type Session } from "../../packages/oar/src/index.js";
import { startOpencodeAimock, type AcpAimockEnv } from "../../sea-trial/harness/aimock-acp.js";
import { resolveRunDir } from "../../sea-trial/harness/trace.js";
import { echoFixtures, stdioEcho } from "../../sea-trial/vendor/support/echo-mcp.js";
import { retainOpencodeLogs } from "./opencode-evidence.js";

const output = resolveRunDir();

async function round(session: Session, meta: { readonly label: string; readonly attempt: number; readonly started: number }): Promise<void> {
  const { label, attempt, started } = meta;
  const prompted = Date.now();
  const response = await session.prompt(attempt === 1 ? "please echo first" : "please echo resumed");
  assert.equal(response.response.body.kind, "accepted");
  const deadline = Promise.withResolvers<never>();
  const timer = setTimeout(() => { deadline.reject(new Error("Probe turn exceeded 120 seconds")); }, 120_000);
  try {
    const outcome = await Promise.race([
      awaitTurnEnd(session, response.request.seq),
      deadline.promise,
    ]);
    assert.deepEqual(outcome, { kind: "completed" });
    const events = session.records().filter(entry => entry.seq > response.request.seq && entry.kind === "frame")
      .flatMap(entry => entry.kind === "frame" ? entry.body.events : []);
    assert.equal(events.filter(event => event.kind === "tool_call_ended" && event.result === "ok").length, 1);
    const result = { label, attempt, started, prompted, ended: Date.now(), outcome };
    await appendFile(path.join(output, "opencode-first-prompt.jsonl"), `${JSON.stringify(result)}\n`);
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } finally { clearTimeout(timer); }
}

interface Control {
  readonly label: string;
  readonly cwd: string;
  readonly config: Readonly<Record<string, unknown>>;
}

async function attempts(installation: AvailableInstallation, control: Control, fixture: AcpAimockEnv): Promise<void> {
  let resume: string | undefined = undefined;
  for (const attempt of [1, 2]) {
    const started = Date.now();
    // oxlint-disable-next-line no-await-in-loop -- The second launch resumes this exact session and HOME after disposal.
    const session = await opencodeSession(installation, {
      cwd: control.cwd, env: fixture.env, mcpServers: [stdioEcho("echo")],
      ...(resume === undefined ? {} : { resume }),
    });
    resume = session.id;
    try {
      // oxlint-disable-next-line no-await-in-loop -- Keep first and resumed turns causally ordered.
      await round(session, { label: control.label, attempt, started });
    } finally {
      // oxlint-disable-next-line no-await-in-loop -- Native processes end before the next attempt or fixture cleanup.
      await session.dispose();
      // oxlint-disable-next-line no-await-in-loop -- Raw records remain local evidence, separate from the published selection.
      await writeFile(path.join(output, `${control.label}-${String(attempt)}.json`), JSON.stringify(session.records(), null, 2));
    }
  }
}

async function probe(installation: AvailableInstallation, control: Control): Promise<void> {
  const fixture = await startOpencodeAimock(mock => {
    for (const marker of ["first", "resumed"]) {
      echoFixtures(mock, new RegExp(`please echo ${marker}`, "u"), [{ server: "echo", text: marker }],
        (server, text) => ({ name: `${server}_echo`, arguments: { text } }));
    }
  }, control.config);
  try { await attempts(installation, control, fixture); } finally {
    try {
      const dataHome = fixture.env.XDG_DATA_HOME;
      assert.ok(dataHome !== undefined);
      await retainOpencodeLogs(dataHome);
    } finally { await fixture.stop(); }
  }
}

const installation = await opencodeInstallation();
assert.equal(installation.kind, "available");
await appendFile(path.join(output, "opencode-first-prompt.jsonl"), `${JSON.stringify({ kind: "identity", version: installation.via === "executable" ? installation.version : undefined, node: process.version, platform: process.platform })}\n`);
const temporary = await mkdtemp(path.join(tmpdir(), "oar-opencode-first-prompt-"));
try {
  const git = path.join(temporary, "git");
  const plain = path.join(temporary, "plain");
  await Promise.all([mkdir(git), mkdir(plain)]);
  await writeFile(path.join(git, "README.md"), "Small fixture project\n");
  execFileSync("git", ["init", git], { stdio: "ignore" });
  execFileSync("git", ["-C", git, "add", "README.md"]);
  for (const control of [
    { label: "repository-default", cwd: process.cwd(), config: {} },
    { label: "repository-no-snapshot", cwd: process.cwd(), config: { snapshot: false } },
    { label: "small-git-default", cwd: git, config: {} },
    { label: "plain-default", cwd: plain, config: {} },
  ]) {
    // oxlint-disable-next-line no-await-in-loop -- Each control owns a fresh HOME and finishes before the next starts.
    await probe(installation, control);
  }
} finally { await rm(temporary, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 }); }

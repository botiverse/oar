import { describe, expect, test } from "vitest";
import { claudeInstallation, claudeSession, promptAndWait } from "../../packages/oar/src/index.js";
import { startClaudeAimock } from "../harness/aimock.js";

/*
 * PROBE, NOT FOR MERGE (draft PR): on Windows, claude installed by npm runs
 * behind a `.cmd` shim, which cmd.exe parses. Do launchArgs (and an
 * argv-carried SessionOptions field) with spaces, quotes, %, ^, &, |, <, >, !
 * and backslashes reach claude unchanged? Each value goes in through
 * `--append-system-prompt`; claude puts it into the system prompt of its
 * provider request, where aimock's raw capture reads it back.
 */

const VALUES = [
  "plain",
  "two words",
  'say "hi" there',
  "100%PATH% and %%",
  "caret^here ^^ end^",
  "amp & pipe | lt < gt >",
  "bang! and !PATH!",
  "trailing backslash\\",
  "C:\\dir with space\\",
  "quote at end\"",
  "parens (x) and [y]",
  "unicode é中文",
];
const wrap = (value: string): string => `[[LK:${value}:LK]]`;
const seen = (body: unknown): string | null => {
  const text = JSON.stringify(body);
  const match = /\[\[LK:(.*?):LK\]\]/su.exec(text);
  if (match?.[1] === undefined) { return null; }
  const decoded: unknown = JSON.parse(`"${match[1]}"`);
  return typeof decoded === "string" ? decoded : null;
};

describe.skipIf(process.env.OAR_TEST !== "claude-aimock" || process.platform !== "win32")("probe: Windows .cmd argv forwarding", () => {
  test("launchArgs and systemPrompt values reach claude unchanged", async () => {
    const installation = await claudeInstallation();
    if (installation.kind !== "available" || installation.via !== "executable") {
      throw new Error(`claude is ${installation.kind}`);
    }
    console.log(`PROBE claude command: ${installation.command} (version ${installation.version ?? "?"})`);
    const results: { path: string; sent: string; received: string | null; outcome: string }[] = [];
    const run = async (path: string, value: string, options: Record<string, unknown>): Promise<void> => {
      const env = await startClaudeAimock((mock) => { mock.onMessage(/[\s\S]*/u, { content: "ok" }); }, { captureRaw: true });
      try {
        const session = await claudeSession(installation, { cwd: process.cwd(), env: env.env, ...options });
        try {
          const turn = await promptAndWait(session, "probe", { timeoutMs: 60_000 });
          const received = env.raw.map((request) => seen(request.body)).find((found) => found !== null) ?? null;
          results.push({ path, sent: value, received, outcome: turn.kind === "rejected" ? `rejected ${turn.code}` : `${turn.kind}/${turn.outcome.kind}` });
        } finally { await session.dispose(); }
      } catch (error) {
        results.push({ path, sent: value, received: null, outcome: `threw ${error instanceof Error ? error.message.slice(0, 160) : String(error)}` });
      } finally { await env.stop(); }
    };
    for (const value of VALUES) {
      await run("launchArgs", value, { launchArgs: ["--append-system-prompt", wrap(value)] });
    }
    await run("appendSystemPrompt", VALUES.join(" | "), { appendSystemPrompt: wrap(VALUES.join(" | ")) });
    for (const result of results) {
      console.log(`PROBE ${result.received === result.sent ? "SAME" : "DIFF"} ${result.path} sent=${JSON.stringify(result.sent)} received=${JSON.stringify(result.received)} outcome=${result.outcome}`);
    }
    expect(results.filter((result) => result.received !== result.sent)).toEqual([]);
  }, 900_000);
});

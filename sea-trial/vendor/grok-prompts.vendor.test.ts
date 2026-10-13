import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "vitest";
import { grokInstallation, grokSession, promptAndWait, type Session } from "../../packages/oar/src/index.js";
import { asRecord } from "../../packages/oar/src/shared/json.js";
import { startGrokAimock } from "../harness/aimock-acp.js";

test.skipIf(process.env.OAR_TEST !== "grok-aimock")("Grok's native override and rules reach the provider on creation and resume", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "oar-grok-prompts-"));
  const provider = await startGrokAimock((mock) => { mock.onMessage(/[\s\S]*/u, { content: "ok" }); });
  let session: Session | undefined = undefined;
  try {
    const installation = await grokInstallation();
    if (installation.kind !== "available") { throw new Error("Grok unavailable"); }
    let id: string | undefined = undefined;
    for (const [systemPrompt, appendSystemPrompt] of [["base", "extra"], ["replacement", "changed"]] as const) {
      const offset = provider.raw.length;
      session = await grokSession(installation, { cwd: root, env: provider.env, ...(id === undefined ? {} : { resume: id }), systemPrompt, appendSystemPrompt });
      expect(await promptAndWait(session, "Hello", { timeoutMs: 30_000 })).toMatchObject({ kind: "ended", outcome: { kind: "completed" } });
      const systems = provider.raw.slice(offset).flatMap(({ body }) => {
        const request = asRecord(body);
        // The separate dashboard-summary call has no tools or session instructions.
        if (!Array.isArray(request?.tools) || request.tools.length === 0) { return []; }
        const messages = request.messages;
        return Array.isArray(messages) ? messages.map((message: unknown) => asRecord(message)).filter((message) => message?.role === "system").map((message) => message?.content) : [];
      });
      expect(systems).toEqual([`${systemPrompt}\n\n<human_rules>\n${appendSystemPrompt}\n</human_rules>`]);
      if (id !== undefined) { expect(session.id).toBe(id); }
      id = session.id;
      await session.dispose();
    }
    if (id === undefined) { throw new Error("No saved session"); }
    await expect(grokSession(installation, { cwd: root, env: provider.env, resume: id, appendSystemPrompt: "ignored" }))
      .rejects.toMatchObject({ name: "UnsupportedOptionError", option: "appendSystemPrompt" });
  } finally { await session?.dispose(); await provider.stop(); await rm(root, { recursive: true, force: true }); }
}, 120_000);

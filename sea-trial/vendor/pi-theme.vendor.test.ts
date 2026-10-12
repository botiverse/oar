import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { awaitTurnEnd, piInstallation, piSession } from "../../packages/oar/src/index.js";
import { startPiAimock } from "../harness/aimock.js";

// An extension tool that colors its result through `ctx.ui.theme`, as pi's own
// extensions do. pi's CLI initializes the theme in every mode; before OAR did
// the same, this tool threw "Theme not initialized. Call initTheme() first."
const COLORED_EXTENSION = `
export default function (pi) {
  pi.registerTool({
    name: "colored",
    label: "Colored",
    description: "Returns a colored word",
    parameters: { type: "object", properties: {} },
    async execute(_id, _params, _signal, _onUpdate, ctx) {
      return { content: [{ type: "text", text: ctx.ui.theme.fg("accent", "colored-ok") }], details: {} };
    },
  });
}
`;

describe.skipIf(process.env.OAR_TEST !== "pi-aimock")("pi theme for extension tools", () => {
  test("an extension tool that uses the theme runs as it does under pi's CLI", async () => {
    const env = await startPiAimock((mock) => {
      mock.on({ userMessage: /color it/u, hasToolResult: false }, { toolCalls: [{ name: "colored", arguments: "{}" }] });
      mock.on({ hasToolResult: true }, { content: "done" });
    });
    const cwd = await mkdtemp(path.join(tmpdir(), "oar-pi-theme-"));
    try {
      await mkdir(path.join(cwd, ".pi", "extensions"), { recursive: true });
      await writeFile(path.join(cwd, ".pi", "extensions", "colored.js"), COLORED_EXTENSION);
      const installation = await piInstallation();
      if (installation.kind !== "available") { throw new Error(`pi is not available: ${installation.kind}`); }
      const session = await piSession(installation, { cwd });
      try {
        const result = await session.prompt("color it");
        await expect(awaitTurnEnd(session, result.request.seq)).resolves.toEqual({ kind: "completed" });
        const toolResults = env.mock.journal.getAll().flatMap((entry) => JSON.stringify(entry.body?.messages ?? []));
        const last = toolResults.at(-1) ?? "";
        expect(last).toContain("colored-ok");
        expect(last).not.toContain("Theme not initialized");
      } finally {
        await session.dispose();
      }
    } finally {
      await env.stop();
      await rm(cwd, { recursive: true, force: true, maxRetries: 5 });
    }
  }, 120_000);
});

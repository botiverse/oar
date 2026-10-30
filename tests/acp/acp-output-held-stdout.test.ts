import { spawnSync } from "node:child_process";
import { expect, test } from "vitest";
import { asRecord } from "../../packages/oar/src/shared/json.js";
import { gone } from "../fixtures/process-tree.js";

// A naturally exiting root cannot identify an already reparented tool. Its
// inherited stdout must not keep the cancelled ACP reader or host alive.
// oxlint-disable-next-line eslint/max-statements -- Keep the host exit and surviving tool assertions together with unconditional cleanup.
test.skipIf(process.platform === "win32")("ACP host exits after final cleanup even when a surviving tool holds stdout", async () => {
  const source = `
    import { fileURLToPath } from "node:url";
    import { createAcpClient, startAcpProcess } from ${JSON.stringify(new URL("../../packages/oar/src/shared/acp/process.ts", import.meta.url).href)};
    const ready = Promise.withResolvers();
    const app = createAcpClient({ name: "held-pipe" }).onNotification("fixture/ready", value => value, ({ params }) => ready.resolve(params));
    const child = startAcpProcess(process.execPath, [fileURLToPath(${JSON.stringify(new URL("../fixtures/acp-output-tree.mjs", import.meta.url).href)})], app, { env: { ...process.env, OAR_ACP_HOLD_STDOUT: "1" } });
    const { root, tool } = await ready.promise;
    console.log(JSON.stringify({ tool }));
    process.kill(root, "SIGTERM");
    console.log(JSON.stringify({ code: await child.exited }));
  `;
  const host = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", source], { encoding: "utf8", timeout: 10_000 });
  const lines = host.stdout.trim().split("\n").map((line) => asRecord(JSON.parse(line)));
  const tool = lines[0]?.tool;
  try {
    expect(typeof tool, host.stderr).toBe("number");
    expect(host.error, host.stderr).toBeUndefined();
    expect(host.status, host.stderr).toBe(0);
    expect(lines[1]).toEqual({ code: 0 });
    if (typeof tool === "number") { expect(await gone(tool, 50)).toBe(false); }
  } finally {
    if (typeof tool === "number") { try { process.kill(tool, "SIGKILL"); } catch { /* Already gone. */ } }
  }
});

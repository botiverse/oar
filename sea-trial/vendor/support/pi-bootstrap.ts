import { writeFile } from "node:fs/promises";
import path from "node:path";
import { fixture, until } from "./pi-input-disposition.js";

/** Hold a real extension-owned run in settlement before the controller opens. */
export async function bootstrapCompaction(): Promise<Awaited<ReturnType<typeof fixture>> & {
  release: () => Promise<void>; compacted: () => Promise<boolean>;
}> {
  const opened = await fixture(`let settling = false; let first = true;
    pi.on("session_before_compact", async () => { note({text:"compaction-entered"}); await delay(300); });
    pi.on("agent_settled", async (_event, ctx) => {
      if (!first) return; first = false; settling = true; note({text:"bootstrap-settling"});
      const {existsSync} = await import("node:fs");
      while (!existsSync(process.env.OAR_PI_AGENT_DIR + "/release-bootstrap")) await delay(10);
      ctx.compact({onComplete: () => note({text:"compaction-complete"}), onError: error => note({text:"compaction-error:" + error.message})});
      await delay(30);
    });
    pi.on("session_start", async () => {
      pi.sendUserMessage("BOOT ${"history ".repeat(200)}");
      while (!settling) await delay(10);
    });`, null, 20, { compaction: { keepRecentTokens: 1 } });
  const dir = process.env.OAR_PI_AGENT_DIR;
  if (dir === undefined) { throw new Error("Missing isolated Pi agent directory"); }
  const release = async (): Promise<void> => { await writeFile(path.join(dir, "release-bootstrap"), "go"); };
  return {
    ...opened, release,
    compacted: async (): Promise<boolean> => {
      const completed = await until(async () => { const hooks = await opened.hooks(); return hooks.includes("compaction-complete"); }, 5000);
      return completed;
    },
    close: async (): Promise<void> => { await release(); await opened.close(); },
  };
}

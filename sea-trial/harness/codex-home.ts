import { codexInstallation } from "../../packages/oar/src/runtimes/codex/installation.js";
import { startAppServerClient } from "../../packages/oar/src/runtimes/codex/app-server-client.js";

/** Initialize a fresh test home before its sessions may start concurrently. */
export async function warmCodexHome(env: Readonly<Record<string, string>>): Promise<void> {
  // Share the session probe's override, PATH and desktop-bundle resolution.
  const installation = await codexInstallation();
  if (installation.kind !== "available" || installation.via !== "executable") { return; }
  const client = startAppServerClient(installation.command, env);
  // The old fixed sleep proved neither initialization nor process exit.
  // Await both; the calling tests retain their existing overall deadlines.
  try {
    await client.request("initialize", {
      clientInfo: { name: "oar-warmup", version: "0.0.0" },
      capabilities: { experimentalApi: true },
    });
    client.notify("initialized", {});
  } finally {
    client.kill();
    await client.exited;
  }
}

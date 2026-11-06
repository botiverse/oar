import { codexInstallation } from "../../packages/oar/src/runtimes/codex/installation.js";
import { startAppServerClient } from "../../packages/oar/src/runtimes/codex/app-server-client.js";
import { startCodexPhase } from "./codex-phases.js";

/** Initialize a fresh test home before its sessions may start concurrently. */
export async function warmCodexHome(env: Readonly<Record<string, string>>): Promise<void> {
  const probed = startCodexPhase("warmup.installation");
  // Share the session probe's override, PATH and desktop-bundle resolution.
  const installation = await codexInstallation();
  probed({ available: installation.kind === "available" });
  if (installation.kind !== "available" || installation.via !== "executable") { return; }
  const launched = startCodexPhase("warmup.launch");
  const client = startAppServerClient(installation.command, env);
  launched();
  // The old fixed sleep proved neither initialization nor process exit.
  // Await both; the calling tests retain their existing overall deadlines.
  try {
    const initialized = startCodexPhase("warmup.initialize");
    await client.request("initialize", {
      clientInfo: { name: "oar-warmup", version: "0.0.0" },
      capabilities: { experimentalApi: true },
    });
    client.notify("initialized", {});
    initialized();
  } finally {
    const exited = startCodexPhase("warmup.exit");
    client.kill();
    await client.exited;
    exited();
  }
}

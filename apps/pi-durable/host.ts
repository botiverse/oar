import { mkdtemp, copyFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { context } from "esbuild";

/** Serves only static demo assets on loopback; no credentials or model requests pass here. */
export async function startDemo(port = 0): Promise<{ readonly url: string; close(): Promise<void> }> {
  const directory = await mkdtemp(path.join(tmpdir(), "oar-durable-browser-"));
  const bundle = await context({
    entryPoints: [path.join(import.meta.dirname, "app.ts")], outfile: path.join(directory, "app.js"),
    bundle: true, platform: "browser", format: "esm", target: "es2024", sourcemap: true,
  });
  try {
    await copyFile(path.join(import.meta.dirname, "index.html"), path.join(directory, "index.html"));
    await bundle.rebuild();
    const server = await bundle.serve({ host: "127.0.0.1", port, servedir: directory });
    return { url: `http://127.0.0.1:${String(server.port)}`, close: async () => { await bundle.dispose(); await rm(directory, { recursive: true, force: true }); } };
  } catch (error) { await bundle.dispose(); await rm(directory, { recursive: true, force: true }); throw error; }
}

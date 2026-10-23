import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

export type PackageState = "none" | "installed" | "missing" | "mismatched";

interface PiProjectFixture {
  readonly home: string;
  readonly cwd: string;
  readonly agentDir: string;
  readonly installed: string;
  readonly loaded: string;
  readonly projectLoaded: string;
  readonly env: Readonly<Record<string, string>>;
  stop(this: void): Promise<void>;
}
const extension = (marker: string): string => `import { writeFileSync } from "node:fs"; export default function () { writeFileSync(${JSON.stringify(marker)}, "loaded"); }`;

/** A local npm substitute installs only the fixture package and never contacts a registry. */
export async function piProjectFixture(state: PackageState): Promise<PiProjectFixture> {
  const home = await mkdtemp(path.join(tmpdir(), "oar-pi-project-"));
  const cwd = path.join(home, "project");
  const agentDir = path.join(home, "agent");
  const installed = path.join(home, "npm-ran");
  const loaded = path.join(home, "package-loaded");
  const projectLoaded = path.join(home, "project-loaded");
  const packageDir = path.join(cwd, ".pi", "npm", "node_modules", "oar-fixture-package");
  const manifest = JSON.stringify({ name: "oar-fixture-package", version: "1.0.0", type: "module", pi: { extensions: ["extension.js"] } });
  await mkdir(path.join(cwd, ".pi", "extensions"), { recursive: true });
  await mkdir(agentDir);
  await writeFile(path.join(agentDir, "settings.json"), "{}");
  await writeFile(path.join(cwd, ".pi", "extensions", "fixture.js"), extension(projectLoaded));
  const npm = path.join(home, "npm-fixture.cjs");
  await writeFile(npm, `const fs = require("node:fs"); const path = require("node:path");
if (!process.argv.includes("install")) throw new Error("unexpected npm command");
fs.writeFileSync(${JSON.stringify(installed)}, "install");
fs.mkdirSync(${JSON.stringify(packageDir)}, { recursive: true });
fs.writeFileSync(path.join(${JSON.stringify(packageDir)}, "package.json"), ${JSON.stringify(manifest)});
fs.writeFileSync(path.join(${JSON.stringify(packageDir)}, "extension.js"), ${JSON.stringify(extension(loaded))});
`);
  await writeFile(path.join(cwd, ".pi", "settings.json"), JSON.stringify({
    packages: state === "none" ? [] : ["npm:oar-fixture-package@1.0.0"], npmCommand: [process.execPath, npm, "npm"],
  }));
  if (state === "installed" || state === "mismatched") {
    await mkdir(packageDir, { recursive: true });
    await writeFile(path.join(packageDir, "package.json"), state === "mismatched" ? manifest.replace("1.0.0", "0.9.0") : manifest);
    await writeFile(path.join(packageDir, "extension.js"), extension(loaded));
  }
  return { home, cwd, agentDir, installed, loaded, projectLoaded,
    env: { HOME: home, USERPROFILE: home, OAR_PI_AGENT_DIR: agentDir, PI_CODING_AGENT_DIR: agentDir },
    stop: async (): Promise<void> => { await rm(home, { recursive: true, force: true }); } };
}

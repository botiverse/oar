import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { SessionOptions } from "../../packages/oar/src/contracts/session.js";

export default async function qwenAuthHome() {
  const home = await mkdtemp(path.join(tmpdir(), "oar-qwen-auth-"));
  const env: NonNullable<SessionOptions["env"]> = {
    ...Object.fromEntries(Object.keys(process.env).map((key) => [key, null])),
    HOME: home, USERPROFILE: home, APPDATA: path.join(home, "AppData"),
    QWEN_CODE_SYSTEM_SETTINGS_PATH: path.join(home, "system", "settings.json"),
    QWEN_CODE_SYSTEM_DEFAULTS_PATH: path.join(home, "system", "system-defaults.json"),
  };
  return {
    home, env,
    async write(relative: string, value: string | object) {
      const file = path.join(home, relative);
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, typeof value === "string" ? value : JSON.stringify(value));
      return file;
    },
    async snapshot() {
      const files = await readdir(home, { recursive: true, withFileTypes: true });
      return Promise.all(files.filter((entry) => entry.isFile()).map(async (entry) => [path.relative(home, path.join(entry.parentPath, entry.name)), await readFile(path.join(entry.parentPath, entry.name), "utf8")]));
    },
    async dispose() { await rm(home, { recursive: true, force: true }); },
  };
}

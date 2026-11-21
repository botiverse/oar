// This preload runs only in the test fixture and its Node descendants.
import { readFileSync } from "node:fs";
import path from "node:path";
// @ts-expect-error TS5097 -- Node loads this fixture directly from its TypeScript source.
import { alive, reportedProcess, writeProcessReport } from "./process-tree.ts";

const directory = new URL(import.meta.url).searchParams.get("directory");
if (directory === null) { throw new Error("Missing test fixture directory"); }
const ownerFile = path.join(directory, "owner");
const owner = reportedProcess(JSON.parse(readFileSync(ownerFile, "utf8")));
writeProcessReport(path.join(directory, `${String(process.pid)}.json`), process.pid);
const preload = `--import=${import.meta.url}`;
if (!(process.env.NODE_OPTIONS ?? "").includes(preload)) {
  process.env.NODE_OPTIONS = [process.env.NODE_OPTIONS, preload].filter(Boolean).join(" ");
}
// A runner terminated mid-test cannot execute its teardown.
setInterval(() => { if (!alive(owner)) { process.exit(1); } }, 5000).unref();

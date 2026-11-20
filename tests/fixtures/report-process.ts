// A shell fixture calls this immediately after spawning a long-lived child.
// @ts-expect-error TS5097 -- Plain Node executes this fixture directly and needs its source extension.
import { captureProcess, writeProcessReport } from "./process-tree.ts";

const [file, pid, root] = process.argv.slice(2);
if (file === undefined) { throw new Error("Missing process report file"); }
if (file === "-") {
  const identity = captureProcess(Number(pid));
  console.log(JSON.stringify({ ...identity, root: Number(root) }));
}
else { writeProcessReport(file, Number(pid)); }

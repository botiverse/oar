/* oxlint-disable typescript/no-unsafe-assignment, typescript/no-unsafe-member-access, typescript/no-unsafe-argument, typescript/no-unsafe-call -- Standalone native hook fixture receives vendor JSON on stdin. */
import { appendFileSync } from "node:fs";

const [file, delay] = process.argv.slice(2);
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { input += chunk; });
process.stdin.on("end", () => {
  const { source } = JSON.parse(input);
  const mark = (phase) => { appendFileSync(file, `${JSON.stringify({ phase, source, pid: process.pid, time: Date.now() })}\n`); };
  mark("start");
  setTimeout(() => { mark("end"); }, Number(delay));
});

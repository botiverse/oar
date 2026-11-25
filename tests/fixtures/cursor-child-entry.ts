import { runCursorChild } from "../../packages/oar/src/runtimes/cursor/index.js";

const markerIndex = process.argv.indexOf("--cursor-child");
const spec = markerIndex === -1 ? "" : (process.argv[markerIndex + 1] ?? "");
runCursorChild(spec);

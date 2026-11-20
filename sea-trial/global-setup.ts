import { prepareProcessStart } from "../tests/fixtures/process-tree.js";
import { prepareWindowsProcessTable } from "./windows-process-table.js";

export default function setup(): void {
  prepareProcessStart();
  prepareWindowsProcessTable("oar-trial-run/windows-process-table-preparation.jsonl");
}

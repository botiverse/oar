import { prepareWindowsProcessTable } from "./windows-process-table.js";

export default function setup(): void {
  prepareWindowsProcessTable("oar-trial-run/windows-process-table-preparation.jsonl");
}

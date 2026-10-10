import { asRecord, parseJson } from "../shared/json.js";

/** The keys that name a file, in the order `classifyTool`'s `detail` reads them (tool-activity.ts). */
const PATH_KEYS = ["path", "file_path", "filePath", "file"];

/** A file tool's one path: the first non-empty `PATH_KEYS` string, as `detail` reads it. */
function inputPath(inputJson: string): readonly string[] {
  const input = asRecord(parseJson(inputJson));
  for (const key of PATH_KEYS) {
    const value = input?.[key];
    if (typeof value === "string" && value.length > 0) {
      return [value];
    }
  }
  return [];
}

/**
 * A codex `fileChange`'s paths. Its input is the item's `changes` array
 * (codex/item-detail.ts), recorded on 0.160.1
 * (tests/replay/fixtures/codex-file-change.raw.jsonl) as
 * `[{path, kind: {type: "add" | "delete" | "update", move_path?}, diff}]`:
 * absolute paths, sorted by path whatever the patch's order, and `move_path`
 * (snake case, `null` on an update that does not rename) the rename's target.
 */
function fileChangePaths(inputJson: string): readonly string[] {
  const changes = parseJson(inputJson);
  const paths: string[] = [];
  for (const raw of Array.isArray(changes) ? changes : []) {
    const change = asRecord(raw);
    for (const value of [change?.path, asRecord(change?.kind)?.move_path]) {
      if (typeof value === "string" && value.length > 0) {
        paths.push(value);
      }
    }
  }
  return paths;
}

/** A tool whose one path is under `key`, a key `PATH_KEYS` does not list. */
function pathUnder(key: string): (inputJson: string) => readonly string[] {
  return (inputJson) => {
    const value = asRecord(parseJson(inputJson))?.[key];
    return typeof value === "string" && value.length > 0 ? [value] : [];
  };
}

/** Where a runtime's file tool keeps its paths, when not under one of `PATH_KEYS`. */
const PATHS: Record<string, Record<string, (input: string) => readonly string[]>> = {
  // The notebook it edits; never a `detail` before `paths`, now the first of them.
  claude: { NotebookEdit: pathUnder("notebook_path") },
  codex: { fileChange: fileChangePaths },
};

/** The file paths a file tool's call involves, each once, in the runtime's order. */
export function filePathsOf(runtime: string, tool: string, inputJson: string): readonly string[] {
  return [...new Set((PATHS[runtime]?.[tool] ?? inputPath)(inputJson))];
}

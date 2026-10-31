/** Observe the actual child, without supplying a cwd or environment override to it. */
import assert from "node:assert/strict";
import { readFile, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { asRecord, type JsonRecord } from "../../packages/oar/src/shared/json.js";
import type { AcpFixture } from "./acp-fixture.js";

export const executionMarker = "oar-execution-fixture";
export async function instrumentTool(f: AcpFixture): Promise<() => Promise<readonly JsonRecord[]>> {
  const journal = path.join(f.home, "execution-tools.jsonl"); await writeFile(journal, "");
  await writeFile(path.join(f.home, "tool.cjs"), [
    "const {appendFileSync}=require('node:fs');const path=require('node:path');",
    `appendFileSync(${JSON.stringify(journal)},JSON.stringify({label:path.basename(process.argv[3],'.json'),cwd:process.cwd(),environmentMarker:process.env.OAR_EXECUTION_ENV_MARKER??null})+'\\n');`,
    "console.log('CWD_RESULT='+process.cwd());",
  ].join("\n"));
  return async () => {
    const text = await readFile(journal, "utf8");
    const rows = text.split("\n").filter(Boolean).map(line => asRecord(JSON.parse(line)));
    assert.equal(rows.length, 2, "Missing or duplicated actual tool executions");
    return Promise.all(rows.map(async row => {
      assert.ok(row !== null && typeof row.cwd === "string");
      const expected = f.cwds[["A", "B"].indexOf(String(row.label))]; assert.ok(expected !== undefined);
      assert.equal(await realpath(row.cwd), await realpath(expected), "Tool cwd differs from its session");
      assert.equal(row.environmentMarker, executionMarker, "Tool did not inherit the environment marker");
      return row;
    }));
  };
}

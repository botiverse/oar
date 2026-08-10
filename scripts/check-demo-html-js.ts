/**
 * Extract inline <script> bodies from demo HTML and run node --check.
 * Exit non-zero if any script fails to parse.
 */
import { readFileSync, writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const files = process.argv.slice(2);
if (files.length === 0) {
  console.error("usage: tsx scripts/check-demo-html-js.ts <html>...");
  process.exit(2);
}

let failed = 0;
for (const file of files) {
  const html = readFileSync(file, "utf8");
  const scripts: string[] = [];
  const re = /<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    const body = m[1]!.trim();
    if (body.length === 0) continue; // external src only
    if (/^\s*src\s*=/i.test(m[0])) continue;
    scripts.push(body);
  }
  if (scripts.length === 0) {
    console.error(`FAIL ${file}: no inline scripts`);
    failed++;
    continue;
  }
  const dir = mkdtempSync(join(tmpdir(), "oar-html-js-"));
  for (const [i, body] of scripts.entries()) {
    const p = join(dir, `script-${i}.js`);
    writeFileSync(p, body);
    const r = spawnSync(process.execPath, ["--check", p], { encoding: "utf8" });
    if (r.status !== 0) {
      console.error(`FAIL ${file} script#${i}:`);
      console.error(r.stderr || r.stdout);
      failed++;
    } else {
      console.log(`PASS ${file} script#${i} (${body.length} bytes)`);
    }
  }
}
process.exit(failed > 0 ? 1 : 0);

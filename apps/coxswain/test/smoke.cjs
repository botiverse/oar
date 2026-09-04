// Keep this entrypoint CommonJS: bare .mjs Electron entrypoints have hung on
// the headless Linux runner. The app itself captures after the renderer says
// its deterministic smoke fixture is ready; Xvfb supplies the display.
const { execFileSync } = require("node:child_process");
const path = require("node:path");

const repositoryDirectory = path.resolve(__dirname, "..", "..");
try {
  process.env.COXSWAIN_COMMIT ??= execFileSync(
    "git",
    ["rev-parse", "HEAD"],
    { cwd: repositoryDirectory, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
  ).trim();
} catch {
  // A source archive may not carry .git; the manifest will use its explicit
  // CI-provided commit when one exists, or honestly retain "unknown".
}

process.env.TZ ??= "UTC";
process.env.LANG ??= "en_US.UTF-8";
process.env.COXSWAIN_SMOKE_SCREENSHOT ??= path.join(
  __dirname,
  "..",
  "artifacts",
  "coxswain-smoke.png",
);
process.env.COXSWAIN_SMOKE_MANIFEST ??= `${process.env.COXSWAIN_SMOKE_SCREENSHOT}.manifest.json`;

require("../out/main/index.cjs");

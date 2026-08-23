// Keep this entrypoint CommonJS: bare .mjs Electron entrypoints have hung on
// the headless Linux runner. The app itself captures after the renderer says
// its deterministic smoke fixture is ready; Xvfb supplies the display.
const path = require("node:path");

process.env.COXSWAIN_SMOKE_SCREENSHOT = path.join(
  __dirname,
  "..",
  "artifacts",
  "coxswain-smoke.png",
);

require("../out/main/index.cjs");

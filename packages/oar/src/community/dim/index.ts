import type { RuntimeBrand } from "../../contracts/brand.js";
import { defineRuntime, type Runtime } from "../../contracts/runtime.js";
import { onFirstCall } from "../../shared/lazy.js";
import { dimInstall, dimInstallPlan } from "./install.js";
import { dimInstallation } from "./installation.js";
import { dimRefusedSessionOptions } from "./options.js";

/**
 * The DimAgent mark, `assets/brands/dim.svg` (see `assets/brands/NOTICE.md`),
 * inline so a host shows it without a file read. It carries its own green
 * tile, so one asset serves both themes.
 */
const dimBrand: RuntimeBrand = {
  name: "Dim",
  icon: `data:image/svg+xml,${encodeURIComponent("<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 64 64\">\n  <!-- Official DimAgent mark (45:32) on the brand-green tile; matches the supplied artwork. -->\n  <rect width=\"64\" height=\"64\" rx=\"15.75\" fill=\"#70C70E\" />\n  <g transform=\"translate(8.75 14.75) scale(1.0456487519676188 1.0784620193810566)\">\n    <path fill=\"#FFFFFF\" d=\"M30.5753 0.061063C24.084 -0.350713 17.6572 1.3463 12.0353 4.35976C5.50548 7.916 -1.94527 14.9536 0.463184 22.9957C2.3951 28.848 9.11815 30.9755 14.8817 30.9755C17.8697 31.0254 18.1981 26.8827 15.223 26.5021C14.3923 26.4085 13.2267 26.3523 12.4088 26.1839C6.3362 25.1045 3.08415 21.1802 6.96729 15.6524C11.0179 10.1808 18.1273 7.04878 24.889 6.15036C32.3526 5.07724 42.463 8.11566 35.7206 16.6569C34.1557 18.5723 32.1079 20.1944 29.8926 21.5046C29.2487 21.8852 28.4244 21.4422 28.4244 20.7123V16.8378C28.4244 15.2718 27.1171 14.0053 25.5008 14.0053C23.8844 14.0053 22.5771 15.2718 22.5771 16.8378V29.1599C22.5771 30.7259 23.8844 31.9924 25.5008 31.9924C26.8145 31.9924 27.9221 31.1564 28.2892 30.0022C28.4308 29.5654 28.7335 29.1973 29.1714 29.0164C29.6544 28.8168 30.1309 28.6046 30.6075 28.3863C36.5835 25.4976 42.4114 20.9868 44.1502 14.3297C46.1336 5.66371 38.6249 0.52899 30.5753 0.061063Z\" />\n  </g>\n</svg>\n")}`,
};

/** A dim runtime: its probe, installer and refusals are always there. */
export type DimRuntime = Runtime & Required<Pick<Runtime, "installation" | "install" | "installPlan" | "refusedSessionOptions">>;

/**
 * Dim, driven through its ACP gateway (`dima acp`, docs/runtimes/dim.md). A
 * community runtime: not in the built-in `runtimes` registry; a host adds it
 * with `createRuntimeRegistry([...defaultRuntimes.list(), createDimRuntime()])`.
 */
export function createDimRuntime(): DimRuntime {
  return defineRuntime({
    id: "dim",
    sessionCapabilities: () => ({ taskEventTypes: [], steer: false, stopTask: false }),
    manualCompaction: { kind: "unsupported", reason: "Dim's ACP gateway offers a /compact command, but OAR has not verified its completion signal." },
    brand: dimBrand,
    installation: dimInstallation,
    installPlan: dimInstallPlan,
    install: dimInstall,
    session: onFirstCall(async () => {
      const { dimSession } = await import("./session.js");
      return dimSession;
    }),
    refusedSessionOptions: dimRefusedSessionOptions,
  }, { execution: "process" });
}

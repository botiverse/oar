import type { SettingsManager } from "@earendil-works/pi-coding-agent";

export type PiThemeSettings = Pick<SettingsManager, "getTheme">;

/**
 * pi's theme, set up as pi's own print and rpc modes set it up. pi's CLI calls
 * `initTheme(<settings theme>, interactive)` in every mode before anything
 * runs (pi-coding-agent 1.1.0 main.js), and only interactive mode adds the
 * file watcher. The theme is a process-wide global that extensions read
 * through `ctx.ui.theme`; without it an extension tool that colors its output
 * throws "Theme not initialized. Call initTheme() first." OAR loads pi in this
 * process, so it makes the same call wherever it loads extensions, from that
 * load's settings, as each pi start does. A theme pi cannot load falls back
 * to pi's system theme.
 */
export function initPiTheme(
  initTheme: (themeName?: string, enableWatcher?: boolean) => void,
  settings: PiThemeSettings,
): void {
  initTheme(settings.getTheme(), false);
}

export async function preparePiTheme(settings: PiThemeSettings): Promise<void> {
  const { initTheme } = await import("@earendil-works/pi-coding-agent");
  initPiTheme(initTheme, settings);
}

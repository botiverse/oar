import path from "node:path";
import type { AvailableInstallation } from "../../contracts/installation.js";
import type { AuthStatus, AuthStatusOptions, AuthStatusReader } from "../../contracts/login.js";
import { environmentValue, sessionEnvironment } from "../../shared/environment.js";
import { asRecord, asRecordList } from "../../shared/json.js";
import { qwenCredentialFileExists, readQwenAuthFiles, type QwenAuthFiles } from "./auth-files.js";

const SOURCE = "Qwen user/system credential configuration";
const SCOPE = "Project settings, workspace .env files and launch arguments may still supply credentials.";
// Native auth protocols plus the provider presets shipped in Qwen 0.26.2.
const KEY_NAMES = ["OPENAI_API_KEY", "ANTHROPIC_API_KEY", "GEMINI_API_KEY", "GOOGLE_API_KEY", "BAILIAN_CODING_PLAN_API_KEY", "BAILIAN_TOKEN_PLAN_API_KEY", "OPENROUTER_API_KEY", "REQUESTY_API_KEY", "DASHSCOPE_API_KEY", "QWENCLOUD_API_KEY", "QWENCLOUD_TOKEN_PLAN_API_KEY", "MOONSHOT_API_KEY", "IDEALAB_API_KEY", "MODELSCOPE_API_KEY", "MINIMAX_API_KEY", "ZAI_API_KEY", "DEEPSEEK_API_KEY", "XAI_API_KEY"];
const AUTH_TYPES = new Set(["openai", "openai-responses", "anthropic", "gemini", "vertex-ai", "qwen-oauth"]);
const present = (value: unknown): value is string => typeof value === "string" && value.length > 0;
const unknown = (detail: string): AuthStatus => ({ kind: "unknown", source: SOURCE, detail });

function configuredSources(env: Readonly<NodeJS.ProcessEnv>, files: QwenAuthFiles): { readonly sources: readonly string[]; readonly value: (name: string) => string | undefined } {
  // This is a presence audit, not a second native credential resolver. A
  // configured source stays unknown even if another layer shadows it.
  const keys = new Set(KEY_NAMES);
  const sources = new Set<string>();
  const settingsEnv: Readonly<NodeJS.ProcessEnv>[] = [];
  for (const { source, value } of files.layers) {
    const auth = asRecord(asRecord(value.security)?.auth);
    const selected = auth?.selectedType ?? value.selectedAuthType;
    const type = typeof selected === "string" && AUTH_TYPES.has(selected) ? ` (${selected})` : "";
    if (present(auth?.apiKey)) { sources.add(`${source}: security.auth.apiKey${type}`); }
    if (selected === "vertex-ai" || selected === "qwen-oauth") { sources.add(`${source}: selectedType${type}; cached or external credentials are not validated`); }
    else if (present(selected) && type === "") { sources.add(`${source}: unrecognized selectedType`); }
    if (auth?.useExternal === true || value.useExternalAuth === true) { sources.add(`${source}: external authentication configured`); }
    const entries = Object.entries(asRecord(value.env) ?? {});
    settingsEnv.push(Object.fromEntries(entries.filter((entry): entry is [string, string] => typeof entry[1] === "string")));
    for (const models of Object.values(asRecord(value.modelProviders) ?? {})) {
      for (const model of asRecordList(models)) {
        if (present(model.envKey)) { keys.add(model.envKey); }
      }
    }
  }
  const value = (name: string): string | undefined => {
    for (const map of [env, ...files.dotenv, ...settingsEnv.toReversed()]) {
      const found = environmentValue(map, name);
      if (present(found)) { return found; }
    }
    return undefined;
  };
  for (const name of keys) {
    if (!present(value(name))) { continue; }
    const label = /^[A-Za-z_][\w]{0,127}$/u.test(name) ? name : "custom modelProviders envKey";
    const origin = present(environmentValue(env, name)) ? "environment" : "user .env or settings.env";
    sources.add(`${origin}: ${label}`);
  }
  return { sources: [...sources], value };
}

async function inspectCredentials(env: Readonly<NodeJS.ProcessEnv>, signal: AbortSignal): Promise<AuthStatus> {
  const files = await readQwenAuthFiles(env, signal);
  const { sources, value } = configuredSources(env, files);
  const observed = [...sources];
  // ADC may come from a file, federation executable or metadata service.
  // Inspect only file presence; never load the Google client or read a token.
  const explicitAdc = value("GOOGLE_APPLICATION_CREDENTIALS");
  if (explicitAdc !== undefined) {
    const exists = await qwenCredentialFileExists(explicitAdc, signal);
    observed.push(`GOOGLE_APPLICATION_CREDENTIALS file ${exists ? "exists" : "not found"}; contents and validity were not read`);
  }
  if (present(value("QWEN_OAUTH"))) { observed.push("QWEN_OAUTH requests legacy OAuth; cached credentials were not validated"); }
  if (present(value("GOOGLE_CLOUD_PROJECT"))) { observed.push("GOOGLE_CLOUD_PROJECT: Vertex ADC may use external credentials"); }
  const appData = value("APPDATA");
  const adc = process.platform === "win32"
    ? (appData === undefined ? undefined : path.join(appData, "gcloud", "application_default_credentials.json"))
    : path.join(files.home, ".config", "gcloud", "application_default_credentials.json");
  if (adc !== undefined && await qwenCredentialFileExists(adc, signal)) { observed.push("Vertex ADC file exists; contents and validity were not read"); }
  if (await qwenCredentialFileExists(path.join(files.qwenHome, "oauth_creds.json"), signal)) { observed.push("legacy Qwen OAuth credential file exists; free tier discontinued 2026-04-15"); }
  signal.throwIfAborted();
  return observed.length > 0
    ? { kind: "unknown", source: SOURCE, configured: observed, detail: `Configured sources: ${observed.join("; ")}. No credential was validated. ${SCOPE}` }
    : { kind: "logged_out", source: SOURCE, detail: `No user/system provider credential found. Configure OPENAI_API_KEY + OPENAI_BASE_URL + OPENAI_MODEL, or BAILIAN_CODING_PLAN_API_KEY / BAILIAN_TOKEN_PLAN_API_KEY with the region's plan URL, or OPENROUTER_API_KEY / REQUESTY_API_KEY with its provider URL. ${SCOPE}` };
}

/** Presence only. Never starts Qwen, sends requests, refreshes or reads token contents. */
export const qwenAuthStatus: AuthStatusReader = Object.assign(async (
  _installation: AvailableInstallation, options: AuthStatusOptions = {},
): Promise<AuthStatus> => {
  const abort = new AbortController();
  const deadline = Promise.withResolvers<never>();
  const timer = setTimeout(() => {
    abort.abort();
    deadline.reject(new Error("Qwen credential inspection timed out"));
  }, options.timeoutMs ?? 20_000);
  timer.unref();
  try {
    return await Promise.race([inspectCredentials(sessionEnvironment(options.env), abort.signal), deadline.promise]);
  } catch {
    return unknown(abort.signal.aborted ? "Qwen local credential inspection timed out" : "Qwen user/system configuration could not be completely inspected; credentials may be configured");
  } finally {
    clearTimeout(timer);
  }
}, { localOnly: true as const });

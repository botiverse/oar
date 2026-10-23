export interface PiProjectOptions {
  /** Trust this cwd for this open only. False disables native project configuration and extensions. */
  readonly projectTrusted?: boolean;
  /** Allow native package installation. False conservatively guards the complete project/user package list. Defaults to false. */
  readonly allowProjectPackageInstall?: boolean;
}

/** Options shared by the Pi factory and its session, model-list and inventory operations. */
export interface PiRuntimeOptions extends PiProjectOptions {
  /** One bundled native RPC process per session, or the embedded SDK (default). */
  readonly execution?: "in-process" | "subprocess";
}

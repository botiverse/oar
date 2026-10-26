export interface PiProjectOptions {
  /** Trust this cwd for this open only. False disables native project configuration and extensions. */
  readonly projectTrusted?: boolean;
  /** Allow native package installation. False guards the complete project/user package list and keeps RPC startup offline. Defaults to false. */
  readonly allowProjectPackageInstall?: boolean;
}

/** Execution placement and project policy share one factory configuration. */
export type PiRuntimeOptions = PiProjectOptions & ({
  /** The embedded SDK remains the default. */
  readonly execution?: "in-process";
  readonly command?: never;
  readonly args?: never;
} | {
  /** One native RPC process per session. */
  readonly execution: "subprocess";
  /** A Pi CLI executable, as a path or PATH command, never a shell expression. */
  readonly command?: string;
  /** Prefix arguments, for example a host binary's Pi subcommand. Requires command. */
  readonly args?: readonly string[];
});

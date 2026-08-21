export type InstallationSnapshot =
  | {
      readonly kind: "available";
      readonly version?: string;
    }
  | {
      readonly kind: "not_found";
    }
  | {
      readonly kind: "unsupported";
      readonly reason: string;
    };

/** A local-only installation observation. Implementations must not perform account or usage I/O. */
export interface Installation {
  probe(): Promise<InstallationSnapshot>;
}

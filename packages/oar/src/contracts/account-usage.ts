export interface AccountUsageWindow {
  readonly label: string;
  readonly usedRatio: number;
  readonly resetsAt?: string;
}

export type AccountUsageSnapshot =
  | {
      readonly kind: "available";
      readonly plan?: string;
      readonly rateLimited: boolean;
      readonly windows: readonly AccountUsageWindow[];
    }
  | { readonly kind: "reauth_required" }
  | { readonly kind: "unsupported" };

export interface AccountUsageReadOptions {
  readonly timeoutMs?: number;
}

export interface AccountUsage {
  read(options?: AccountUsageReadOptions): Promise<AccountUsageSnapshot>;
}

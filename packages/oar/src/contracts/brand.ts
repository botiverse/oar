export interface RuntimeBrand {
  readonly name: string;
  /** Self-contained SVG data URI; null when no icon is provided. */
  readonly icon: string | null;
  /** Optional SVG data URIs for the host's background, not the icon's color.
   * Hosts should fall back to icon when their theme has no variant. */
  readonly icons?: {
    readonly light?: string;
    readonly dark?: string;
  };
}


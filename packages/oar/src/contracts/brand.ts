export interface RuntimeBrand {
  readonly name: string;
  /** Self-contained SVG data URI; null when no icon is provided. */
  readonly icon: string | null;
}


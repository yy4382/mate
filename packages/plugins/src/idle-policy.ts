/** The numbers idle compaction works with, for one model. */
export type IdlePolicy = {
  /** How long the provider keeps a prompt-cache prefix after the request that wrote it, in minutes. */
  readonly cacheTtlMinutes: number;
  /** An idle conversation is compacted once this share of the cache lifetime has passed. */
  readonly compactAfterShare: number;
  /** The last request must have read this share of Durable's background compaction line... */
  readonly thresholdShare: number;
  /** ...or this many tokens, whichever is fewer. */
  readonly maxThresholdTokens: number;
};

type Layers = {
  readonly default: IdlePolicy;
  /** By provider, e.g. `openai`. */
  readonly providers: Readonly<Record<string, Partial<IdlePolicy>>>;
  /** By `provider/modelId`. */
  readonly models: Readonly<Record<string, Partial<IdlePolicy>>>;
};

/**
 * Idle compaction's data. A model's policy is `default`, then its provider's entry, then its own; a later layer replaces
 * only the fields it names.
 */
export const IDLE_POLICY: Layers = {
  default: {
    cacheTtlMinutes: 30,
    compactAfterShare: 5 / 6,
    thresholdShare: 2 / 3,
    maxThresholdTokens: 200_000,
  },
  providers: {
    openai: { cacheTtlMinutes: 30 },
    deepseek: { cacheTtlMinutes: 72 * 60 },
  },
  models: {},
};

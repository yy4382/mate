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
 * only the fields it names. The logic lives in `idle-compaction.ts`, which names no provider or model.
 */
export const IDLE_POLICY: Layers = {
  default: {
    cacheTtlMinutes: 30,
    // A margin before the cache goes, for a slow model to read the prefix while it is still there: 25 of 30 minutes.
    compactAfterShare: 5 / 6,
    // Below Durable's own compaction line with room to spare; about 150k of gpt-6.1-sol's 223k, all 200k on a 1M window.
    thresholdShare: 2 / 3,
    maxThresholdTokens: 200_000,
  },
  providers: {
    // OpenAI keeps an eligible prefix at least 30 minutes.
    openai: { cacheTtlMinutes: 30 },
    // DeepSeek caches on disk; its V4.1 Flash paper guarantees global KV at least 72 hours.
    deepseek: { cacheTtlMinutes: 72 * 60 },
  },
  models: {},
};

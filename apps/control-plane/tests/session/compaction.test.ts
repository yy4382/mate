import { it } from "vitest";

import { exerciseCompaction } from "./compaction-scenario.js";

it(
  "compacts a long tool loop through the control plane and resumes from its confirmed checkpoint",
  () => exerciseCompaction("success"),
  30_000,
);

it(
  "rejects summary tool calls without executing them or retrying forever",
  () => exerciseCompaction("toolCall"),
  30_000,
);

it(
  "folds a prior checkpoint into a second compaction during the same tool loop",
  () => exerciseCompaction("repeat"),
  30_000,
);

it(
  "rejects a truncated summary without installing a checkpoint",
  () => exerciseCompaction("length"),
  30_000,
);

it(
  "does not count an incomplete summary stream after HTTP headers",
  () => exerciseCompaction("network"),
  30_000,
);

it(
  "counts complete failed summaries without usage as missing data",
  () => exerciseCompaction("failureWithoutUsage"),
  30_000,
);

it(
  "reports an uncuttable context without discarding its original messages",
  () => exerciseCompaction("uncuttable"),
  30_000,
);

it(
  "recovers once from a provider context overflow using a confirmed checkpoint",
  () => exerciseCompaction("overflow"),
  30_000,
);

it(
  "keeps original context when the control plane exits before checkpoint submission, then retries",
  () => exerciseCompaction("interrupt"),
  30_000,
);

it(
  "replays a missing tool result before pending new input after a control-plane restart",
  () => exerciseCompaction("recoveryOrder"),
  30_000,
);

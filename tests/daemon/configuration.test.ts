import { expect, it } from "vitest";
import {
  daemonConfigSchema,
  sameConfiguration,
  slackRuntimeConfig,
  assertConfigurationEvolution,
  slackHumanId,
} from "../../src/daemon/config.js";
import { slackPrincipal, slackUserForPrincipal } from "../../src/slack/principals.js";
import { configFixture } from "../helpers/config.js";
import { daemonFixture } from "../helpers/daemon-config.js";
const current = () => daemonFixture("/synthetic/mate");
it("keeps pure Agent definitions separate from Slack installation bindings", () => {
  const c = daemonConfigSchema.parse(current());
  expect(daemonConfigSchema.parse(c)).toEqual(c);
  expect(sameConfiguration(c, daemonConfigSchema.parse(current()))).toBe(true);
  expect(c.mate.agents[0]).not.toHaveProperty("slackAppId");
  expect(c.mate.ownerUserIds).toEqual([slackHumanId(configFixture.teamId, "UOWNER")]);
  expect(slackPrincipal(slackRuntimeConfig(c)!, "UOWNER")).toEqual(
    slackPrincipal(configFixture, "UOWNER"),
  );
  expect(c.runtime.limits).toEqual({
    maxActiveRuns: 1,
    maxBackendOperations: 1,
    workerIdleMs: 300000,
  });
});
it("owner removal retains human author identity and cannot implicitly rebind previously observed humans", () => {
  const before = daemonConfigSchema.parse(current()),
    after = structuredClone(before);
  after.mate.ownerUserIds = ["local-owner"];
  assertConfigurationEvolution(before, after);
  expect(slackRuntimeConfig(after)!.ownerUserIds).toEqual([]);
  expect(slackPrincipal(slackRuntimeConfig(after)!, "UOWNER")).toEqual(
    slackPrincipal(slackRuntimeConfig(before)!, "UOWNER"),
  );
  delete after.adapters.slack!.principals.UOWNER;
  expect(() => assertConfigurationEvolution(before, after)).toThrow("mapping");
  const rebound = structuredClone(before);
  rebound.adapters.slack!.principals.UOTHER = "new-author";
  expect(() => assertConfigurationEvolution(before, rebound)).toThrow("rebound");
  const stable = structuredClone(before);
  stable.adapters.slack!.principals.UOTHER = slackHumanId(configFixture.teamId, "UOTHER");
  assertConfigurationEvolution(before, stable);
});
it("local-only teams need no synthetic Slack identity; mixed teams bind a subset of members", () => {
  const mixed = daemonConfigSchema.parse(current());
  mixed.mate.agents.push({ ...mixed.mate.agents[0]!, id: "peer" });
  expect(daemonConfigSchema.parse(mixed).mate.agents).toHaveLength(2);
  expect(slackRuntimeConfig(mixed)!.agents).toHaveLength(1);
  const local = {
    ...mixed,
    adapters: {
      local: {
        humans: ["owner"],
        rooms: [{ id: "room", agents: ["research", "peer"], humans: ["owner"] }],
      },
    },
  };
  expect(slackRuntimeConfig(daemonConfigSchema.parse(local))).toBeUndefined();
  expect(() =>
    daemonConfigSchema.parse({
      ...local,
      adapters: {
        local: {
          ...local.adapters.local,
          rooms: [{ id: "room", agents: ["unknown"], humans: ["owner"] }],
        },
      },
    }),
  ).toThrow("Unknown local room");
});
it("rejects conflicting installations, human/bot identities, removed bindings and unknown fields", () => {
  const c = daemonConfigSchema.parse(current());
  const duplicate = structuredClone(c);
  duplicate.adapters.slack!.bindings.push(duplicate.adapters.slack!.bindings[0]!);
  expect(() => daemonConfigSchema.parse(duplicate)).toThrow("Duplicate");
  const bot = structuredClone(c);
  bot.adapters.slack!.principals[bot.adapters.slack!.bindings[0]!.slackUserId] = "owner";
  expect(() => daemonConfigSchema.parse(bot)).toThrow("bot identity");
  const removed = structuredClone(c);
  delete removed.adapters.slack;
  expect(() => assertConfigurationEvolution(c, removed)).toThrow("Workspace");
  expect(() => daemonConfigSchema.parse({ ...current(), misspelled: true })).toThrow();
});

it("friendly human mappings round-trip for DM and cannot alias a default Slack identity", () => {
  const c = daemonConfigSchema.parse(current());
  c.adapters.slack!.principals.UOWNER = "owner";
  const adapter = slackRuntimeConfig(daemonConfigSchema.parse(c))!;
  expect(slackUserForPrincipal(adapter, { kind: "human", id: "owner" })).toBe("UOWNER");
  expect(() =>
    slackUserForPrincipal(adapter, {
      kind: "human",
      id: slackHumanId(configFixture.teamId, "UOWNER"),
    }),
  ).toThrow("mismatch");
  c.adapters.slack!.principals.UOTHER = slackHumanId(configFixture.teamId, "UOWNER");
  expect(() => daemonConfigSchema.parse(c)).toThrow("aliases");
});
it("rejects removed container and workspace-grant configuration", () => {
  const input = current();
  for (const field of [
    {
      docker: {
        binary: "/usr/bin/docker",
        host: "unix:///var/run/docker.sock",
        image: `sha256:${"a".repeat(64)}`,
      },
    },
    { workspaceGrants: [] },
    { workspaceManifest: "/old/manifest.json" },
  ]) {
    expect(() =>
      daemonConfigSchema.parse({ ...input, runtime: { ...input.runtime, ...field } }),
    ).toThrow();
  }
  expect(() =>
    daemonConfigSchema.parse({ mate: configFixture, runtime: { dataDir: "/synthetic/mate" } }),
  ).toThrow();
});

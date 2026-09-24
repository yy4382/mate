import { afterEach, expect, it } from "vitest";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Store } from "../../src/storage/store.js";
import { Messages, Output, fixtureTarget } from "../helpers/canonical-slack.js";
import { Collaboration } from "../../src/collaboration/service.js";
import { Broker } from "../../src/policy/broker.js";
import { ToolRouter } from "../../src/runtime/tools.js";
import {
  EnvironmentCapabilities,
  environmentReportSchema,
} from "../../src/capabilities/environment.js";
import { configFixture } from "../helpers/config.js";

const cleanup: (() => void)[] = [];
afterEach(() => cleanup.splice(0).forEach((stop) => stop()));
function harness() {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "mate-environment-")));
  const home = join(base, "private"),
    sharedRoot = join(base, "shared");
  const store = new Store(":memory:");
  cleanup.push(() => {
    store.close();
    rmSync(base, { recursive: true, force: true });
  });
  store.register("research", "v1", []);
  const messages = new Messages(store, configFixture);
  messages.membership("research", "CTEST", true);
  const collaboration = new Collaboration(
    store,
    messages,
    new Output(messages, { post: async () => ({ ts: "200.000001" }) }),
    configFixture,
  );
  const work = collaboration.createWork("environment", fixtureTarget("CTEST", "100.000001"));
  collaboration.enqueue("research", work, "start", {});
  const run = store.beginRun("research")!;
  store.input(run, {});
  const broker = new Broker(
    store,
    collaboration,
    { execute: async () => ({ code: 0, stdout: "", stderr: "", truncated: false }) },
    { research: home },
  );
  const environment = new EnvironmentCapabilities(collaboration, {
    homes: { research: home },
    sharedRoot,
    attachmentConfigured: () => true,
    artifactConfigured: () => true,
    artifactSupported: () => true,
  });
  const router = new ToolRouter(collaboration, broker, {
    environment: (token, selected) => environment.read(token, selected),
    publish: async () => ({}),
  });
  return { store, collaboration, work, run, router, home, sharedRoot };
}

it("reports familiar host paths and network without exposing a separate file-grant mechanism", async () => {
  const h = harness();
  const value = (
    await h.router.call(
      h.run,
      h.work,
      "environment",
      "environment.info",
      {},
      new AbortController().signal,
    )
  ).value;
  expect(environmentReportSchema.parse(value)).toMatchObject({
    format: "mate.environment.v3",
    workId: h.work,
    filesystem: { home: h.home, sharedRoot: h.sharedRoot, access: "linux_user_permissions" },
    execution: { status: "configured", network: "host" },
    attachmentInput: { status: "configured" },
    artifactOutput: { status: "configured" },
  });
  expect(JSON.stringify(value)).not.toContain("grant");
});

it("reports the selected work without changing the Agent filesystem identity", async () => {
  const h = harness(),
    other = h.collaboration.createWork("other", fixtureTarget("CTEST", "100.000001"));
  await h.router.call(
    h.run,
    h.work,
    "select",
    "works.select",
    { workId: other },
    new AbortController().signal,
  );
  const value = (
    await h.router.call(
      h.run,
      h.work,
      "environment-after-select",
      "environment.info",
      {},
      new AbortController().signal,
    )
  ).value;
  expect(value).toMatchObject({
    workId: other,
    filesystem: { home: h.home, sharedRoot: h.sharedRoot },
  });
});

it("still reports the Agent environment after the attributed work pauses", async () => {
  const h = harness();
  h.store.db.prepare("UPDATE works SET state='paused' WHERE id=?").run(h.work);
  const value = (
    await h.router.call(
      h.run,
      h.work,
      "environment-paused",
      "environment.info",
      {},
      new AbortController().signal,
    )
  ).value;
  expect(value).toMatchObject({
    workId: h.work,
    filesystem: { home: h.home },
    execution: { status: "configured" },
  });
});

it("keeps ordinary execution available under the reviewer identity while withholding external adapters", async () => {
  const h = harness();
  h.store.db
    .prepare("INSERT INTO review_seats VALUES(?,?,?,?,1)")
    .run("research", JSON.stringify(fixtureTarget("CTEST", "100.000001")), "brief", h.home);
  const value = (
    await h.router.call(
      h.run,
      h.work,
      "review-environment",
      "environment.info",
      {},
      new AbortController().signal,
    )
  ).value;
  expect(value).toMatchObject({
    execution: { status: "configured", network: "host" },
    attachmentInput: { status: "unavailable" },
    artifactOutput: { status: "unavailable" },
  });
});

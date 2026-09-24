import { fixtureTarget, migrateCurrentRuntime } from "../helpers/canonical-slack.js";
import { afterEach, expect, it, vi } from "vitest";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { Store } from "../../src/storage/store.js";
import { configSchema } from "../../src/config.js";
import { configFixture } from "../helpers/config.js";
import { Messages, Output } from "../helpers/canonical-slack.js";
import { Collaboration } from "../../src/collaboration/service.js";
import { Broker } from "../../src/policy/broker.js";
import { ToolRouter } from "../../src/runtime/tools.js";

const cleanups: (() => void)[] = [];
afterEach(() => cleanups.splice(0).forEach((stop) => stop()));
function setup() {
  const home = realpathSync(mkdtempSync(`${tmpdir()}/mate-policy-`));
  const store = new Store(":memory:");
  cleanups.push(() => {
    store.close();
    rmSync(home, { recursive: true, force: true });
  });
  const config = configSchema.parse(configFixture);
  store.register("research", "v1", []);
  const messages = new Messages(store, config);
  migrateCurrentRuntime(store);
  messages.membership("research", "CTEST", true);
  const collaboration = new Collaboration(
    store,
    messages,
    new Output(messages, { post: async () => ({ ts: "101.000001" }) }),
    config,
  );
  const work = collaboration.createWork("human:one", fixtureTarget("CTEST", "100.000001"));
  collaboration.enqueue("research", work, "one", {});
  const run = store.beginRun("research")!;
  store.input(run, {});
  const execute = vi.fn(async (_request: unknown) => ({
    code: 0,
    stdout: "ok",
    stderr: "",
    truncated: false,
  }));
  const broker = new Broker(store, collaboration, { execute }, { research: home });
  return { home, store, collaboration, run, broker, work, execute };
}

it("runs an ordinary command as the Agent identity without a file grant or human review", async () => {
  const { home, store, run, broker, work, execute } = setup();
  const command = { kind: "exec", cwd: home, command: "printf safe" };
  await broker.execute(run, work, "once", command);
  await broker.execute(run, work, "once", command);
  expect(execute).toHaveBeenCalledOnce();
  expect(execute.mock.calls[0]![0]).toMatchObject({
    agentId: "research",
    root: home,
    operation: command,
  });
  expect(store.action("once")?.state).toBe("succeeded");
});

it("keeps ordinary Linux tools available when the attributed work is paused", async () => {
  const { collaboration, run, broker, work, execute } = setup();
  const router = new ToolRouter(collaboration, broker);
  collaboration.store.db.prepare("UPDATE works SET state='paused' WHERE id=?").run(work);
  const result = await router.call(
    run,
    work,
    "paused-read",
    "file.read",
    { path: "MEMORY.md" },
    new AbortController().signal,
  );
  expect(result.value).toMatchObject({ code: 0, stdout: "ok" });
  expect(execute).toHaveBeenCalledOnce();
});

it("keeps one action identity immutable and returns an uncertain result for a lost receipt", async () => {
  const { store, run, broker, work, execute } = setup();
  execute.mockRejectedValueOnce(new Error("lost receipt"));
  const command = { kind: "exec", cwd: ".", command: "printf first" };
  await expect(broker.execute(run, work, "first", command)).rejects.toThrow("lost receipt");
  expect(store.action("first")?.state).toBe("unknown");
  expect(await broker.execute(run, work, "first", command)).toMatchObject({
    status: "action_unknown",
  });
  await expect(
    broker.execute(run, work, "first", { ...command, command: "changed" }),
  ).rejects.toThrow("identity conflict");
  expect(execute).toHaveBeenCalledOnce();
});

it("lets the Agent inspect or continue after an uncertain command without a global lock", async () => {
  const { run, broker, work, execute } = setup();
  execute.mockRejectedValueOnce(new Error("lost receipt"));
  await expect(
    broker.execute(run, work, "uncertain", { kind: "exec", cwd: ".", command: "true" }),
  ).rejects.toThrow("lost receipt");
  expect(
    await broker.execute(run, work, "inspect", { kind: "exec", cwd: ".", command: "pwd" }),
  ).toMatchObject({ code: 0 });
  expect(execute).toHaveBeenCalledTimes(2);
});

it("checks run, current work and cancellation before execution", async () => {
  const { collaboration, run, broker, work, execute } = setup();
  const command = { kind: "exec", cwd: ".", command: "true" };
  await expect(
    broker.execute({ ...run, agentId: "other" }, work, "foreign", command),
  ).rejects.toThrow("Stale");
  const other = collaboration.createWork("human:other", fixtureTarget("CTEST", "100.000001"));
  await expect(broker.execute(run, other, "other", command)).rejects.toThrow("mismatch");
  const abort = new AbortController();
  abort.abort();
  await expect(broker.execute(run, work, "aborted", command, abort.signal)).rejects.toThrow(
    "aborted",
  );
  expect(execute).not.toHaveBeenCalled();
});

it("runs an independent reviewer under that reviewer Agent identity", async () => {
  const { home, store, run, broker, work, execute } = setup();
  store.db
    .prepare("INSERT INTO review_seats VALUES(?,?,?,?,1)")
    .run("research", JSON.stringify(fixtureTarget("CTEST", "100.000001")), "clean brief", home);
  expect(
    await broker.execute(run, work, "review-command", { kind: "exec", cwd: home, command: "pwd" }),
  ).toMatchObject({ code: 0 });
  expect(execute.mock.calls[0]![0]).toMatchObject({ agentId: "research", root: home });
});

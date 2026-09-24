import { afterEach, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, chmodSync, chownSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { configSchema } from "../../src/config.js";
import { Store } from "../../src/storage/store.js";
import { Messages, Output, fixtureTarget } from "../helpers/canonical-slack.js";
import { Collaboration } from "../../src/collaboration/service.js";
import { Broker } from "../../src/policy/broker.js";
import { ToolRouter } from "../../src/runtime/tools.js";
import { LinuxUserBackend } from "../../src/execution/linux-user.js";
import {
  LinuxProcessManager,
  ProcessStopRejectedError,
} from "../../src/execution/linux-processes.js";
import { configFixture } from "../helpers/config.js";

const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const stop of cleanup.splice(0).reverse()) stop();
});

it("runs two Agents through direct file/exec calls and tools.call with stable host paths and receipts", async () => {
  const native =
    process.platform === "linux" &&
    process.getuid?.() === 0 &&
    process.env.MATE_NATIVE_UID_TEST === "1";
  const base = realpathSync(mkdtempSync(join(tmpdir(), "mate-linux-tools-")));
  cleanup.push(() => rmSync(base, { recursive: true, force: true }));
  const alice = join(base, "alice"),
    bob = join(base, "bob");
  mkdirSync(alice, { mode: 0o700 });
  mkdirSync(bob, { mode: 0o700 });
  if (native) {
    chmodSync(base, 0o755);
    chownSync(alice, 65534, 65534);
    chownSync(bob, 1, 1);
  }
  const second = {
    ...configFixture.agents[0]!,
    id: "bob",
    name: "Bob",
    slackAppId: "ATWO",
    slackUserId: "UTWO",
    slackBotId: "BTWO",
    botTokenEnv: "BOB_BOT",
    appTokenEnv: "BOB_APP",
  };
  const config = configSchema.parse({
    ...configFixture,
    agents: [configFixture.agents[0], second],
  });
  const store = new Store(":memory:");
  cleanup.push(() => store.close());
  const messages = new Messages(store, config);
  const collaboration = new Collaboration(
    store,
    messages,
    new Output(messages, { post: async () => ({ ts: "200.000001" }) }),
    config,
  );
  const identities = {
    research: native
      ? { uid: 65534, gid: 65534, home: alice }
      : { uid: process.getuid!(), gid: process.getgid!(), home: homedir() },
    bob: native
      ? { uid: 1, gid: 1, home: bob }
      : { uid: process.getuid!(), gid: process.getgid!(), home: homedir() },
  };
  const backend = new LinuxUserBackend(identities);
  const manager = native ? new LinuxProcessManager({ research: 65534, bob: 1 }) : undefined;
  const broker = new Broker(store, collaboration, backend, { research: alice, bob }),
    router = new ToolRouter(
      collaboration,
      broker,
      manager
        ? { processes: manager, research: async () => ({}), publish: async () => ({}) }
        : undefined,
    );
  const runs = new Map<string, { run: ReturnType<Store["beginRun"]>; work: string }>();
  for (const [agentId, root] of [
    ["research", alice],
    ["bob", bob],
  ] as const) {
    store.register(agentId, "v1", []);
    messages.membership(agentId, "CTEST", true);
    const work = collaboration.createWork(`linux-${agentId}`, fixtureTarget("CTEST", "100.000001"));
    collaboration.enqueue(agentId, work, "start", {});
    const run = store.beginRun(agentId)!;
    store.input(run, {});
    runs.set(agentId, { run, work });
    const signal = new AbortController().signal;
    const saved = await router.call(
      run,
      work,
      `${agentId}-write`,
      "file.write",
      { path: join(root, "note.txt"), content: agentId },
      signal,
    );
    expect(saved.value).toMatchObject({ code: 0, stderr: "" });
    const command = await router.call(
      run,
      work,
      `${agentId}-exec`,
      "exec",
      { cwd: root, command: 'printf "%s:%s:%s" "$HOME" "$PWD" "$(cat note.txt)"' },
      signal,
    );
    expect((command.value as { stdout: string }).stdout).toBe(
      `${identities[agentId].home}:${root}:${agentId}`,
    );
    const read = await router.call(
      run,
      work,
      `${agentId}-read`,
      "tools.call",
      { name: "file.read", input: { path: join(root, "note.txt") } },
      signal,
    );
    expect((read.value as { stdout: string }).stdout).toBe(agentId);
    expect(store.action(`${run.sessionId}:${agentId}-exec`)?.state).toBe("succeeded");
  }
  if (native) {
    const shared = join(base, "shared"),
      own = join(shared, "research");
    mkdirSync(shared, { mode: 0o755 });
    chmodSync(shared, 0o755);
    mkdirSync(own, { mode: 0o755 });
    chmodSync(own, 0o755);
    chownSync(own, 65534, 65534);
    const aliceRun = runs.get("research")!,
      bobRun = runs.get("bob")!,
      signal = new AbortController().signal;
    expect(
      (
        await router.call(
          aliceRun.run!,
          aliceRun.work,
          "shared-write",
          "file.write",
          { path: join(own, "result.txt"), content: "visible" },
          signal,
        )
      ).value,
    ).toMatchObject({ code: 0 });
    expect(
      (
        await router.call(
          bobRun.run!,
          bobRun.work,
          "shared-read",
          "tools.call",
          { name: "file.read", input: { path: join(own, "result.txt") } },
          signal,
        )
      ).value,
    ).toMatchObject({ code: 0, stdout: "visible" });
    expect(
      (
        await router.call(
          bobRun.run!,
          bobRun.work,
          "shared-no-write",
          "file.write",
          { path: join(own, "result.txt"), content: "overwrite" },
          signal,
        )
      ).value,
    ).toMatchObject({ code: 1 });
    expect(
      (
        await router.call(
          bobRun.run!,
          bobRun.work,
          "private-denied",
          "exec",
          { cwd: shared, command: `cat ${alice}/note.txt` },
          signal,
        )
      ).value,
    ).toMatchObject({ code: 1 });
    const background = await router.call(
      aliceRun.run!,
      aliceRun.work,
      "background",
      "exec",
      { cwd: own, command: "sleep 30 &" },
      signal,
    );
    expect((background.value as { code: number }).code).toBe(0);
    try {
      const old = (
        (
          await router.call(
            aliceRun.run!,
            aliceRun.work,
            "background-list",
            "processes.list",
            {},
            signal,
          )
        ).value as { unit: string; pids: number[] }[]
      ).filter((scope) => scope.pids.length);
      expect(old).toHaveLength(1);
      expect(old[0]!.pids.length).toBeGreaterThan(0);
      expect(await new LinuxProcessManager({ research: 65534 }).list("research")).toEqual(old);
      // Ownership is rechecked on the changed (asynchronous) path before any stop is sent:
      // another Agent's UID refuses, and a wait cancelled during the check refuses too.
      await expect(manager!.stop("bob", old[0]!.unit)).rejects.toBeInstanceOf(
        ProcessStopRejectedError,
      );
      expect(await manager!.list("research")).toEqual(old);
      const cancelled = new AbortController();
      const stopping = manager!.stop("research", old[0]!.unit, cancelled.signal);
      cancelled.abort();
      await expect(stopping).rejects.toBeInstanceOf(ProcessStopRejectedError);
      expect(await manager!.list("research")).toEqual(old);
      expect(
        (
          await router.call(
            aliceRun.run!,
            aliceRun.work,
            "background-stop",
            "tools.call",
            { name: "processes.stop", input: { unit: old[0]!.unit } },
            signal,
          )
        ).value,
      ).toEqual({ unit: old[0]!.unit, stopped: true });
      expect(await manager!.list("research")).toEqual([]);
      // A timed-out ordinary command inside a real scope is killed and its scope stopped without
      // blocking the daemon, leaving nothing behind and an unknown outcome for the caller.
      await expect(
        backend.execute({
          agentId: "research",
          root: own,
          timeoutMs: 200,
          operation: { kind: "exec", cwd: own, command: "sleep 30" },
        }),
      ).rejects.toThrow("outcome may be unknown");
      await expect
        .poll(async () => (await manager!.list("research")).length, { timeout: 5000 })
        .toBe(0);
    } finally {
      for (const scope of await manager!.list("research"))
        try {
          await manager!.stop("research", scope.unit);
        } catch {
          /* Synthetic scope expires shortly if cleanup cannot complete. */
        }
    }
  }
});

it("keeps another Agent's real command running while a slow systemctl stop is awaited", async () => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "mate-linux-slow-")));
  cleanup.push(() => rmSync(base, { recursive: true, force: true }));
  const alice = join(base, "alice"),
    bob = join(base, "bob");
  mkdirSync(alice, { mode: 0o700 });
  mkdirSync(bob, { mode: 0o700 });
  const config = configSchema.parse({
    ...configFixture,
    agents: [
      configFixture.agents[0],
      {
        ...configFixture.agents[0],
        id: "bob",
        name: "Bob",
        slackAppId: "ATWO",
        slackUserId: "UTWO",
        slackBotId: "BTWO",
        botTokenEnv: "BOB_BOT",
        appTokenEnv: "BOB_APP",
      },
    ],
  });
  const store = new Store(":memory:");
  cleanup.push(() => store.close());
  const messages = new Messages(store, config);
  const collaboration = new Collaboration(
    store,
    messages,
    new Output(messages, { post: async () => ({ ts: "200.000001" }) }),
    config,
  );
  const identity = { uid: process.getuid!(), gid: process.getgid!(), home: homedir() };
  const broker = new Broker(
    store,
    collaboration,
    new LinuxUserBackend({ research: identity, bob: identity }),
    { research: alice, bob },
  );
  const unit = `mate-agent-${identity.uid}-123e4567-e89b-42d3-a456-426614174000.scope`,
    group = `/mate-agent-${identity.uid}.slice/${unit}`,
    scope = `Id=${unit}\nActiveState=active\nSlice=mate-agent-${identity.uid}.slice\nControlGroup=${group}\n`;
  let release = () => {},
    stopStarted = false,
    stopSettled = false;
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  const manager = new LinuxProcessManager(
    { research: identity.uid, bob: identity.uid },
    async (args) => {
      if (args[0] === "show") return { code: 0, stdout: scope, stderr: "" };
      stopStarted = true;
      await blocked;
      return { code: 0, stdout: "", stderr: "" };
    },
    () => [],
    () => identity.uid,
  );
  const router = new ToolRouter(collaboration, broker, {
    processes: manager,
    research: async () => ({}),
    publish: async () => ({}),
  });
  const runs = new Map<string, { run: ReturnType<Store["beginRun"]>; work: string }>();
  for (const agentId of ["research", "bob"]) {
    store.register(agentId, "v1", []);
    messages.membership(agentId, "CTEST", true);
    const work = collaboration.createWork(`slow-${agentId}`, fixtureTarget("CTEST", "100.000001"));
    collaboration.enqueue(agentId, work, "start", {});
    const run = store.beginRun(agentId)!;
    store.input(run, {});
    runs.set(agentId, { run, work });
  }
  const signal = new AbortController().signal;
  const stopping = router
    .call(
      runs.get("research")!.run!,
      runs.get("research")!.work,
      "slow-stop",
      "processes.stop",
      { unit },
      signal,
    )
    .then((value) => {
      stopSettled = true;
      return value;
    });
  await vi.waitFor(() => expect(stopStarted).toBe(true));
  const other = await router.call(
    runs.get("bob")!.run!,
    runs.get("bob")!.work,
    "other-agent-exec",
    "exec",
    { cwd: bob, command: "printf alive" },
    signal,
  );
  expect(other.value).toMatchObject({ code: 0, stdout: "alive" });
  expect(store.action(`${runs.get("bob")!.run!.sessionId}:other-agent-exec`)?.state).toBe(
    "succeeded",
  );
  expect(stopSettled).toBe(false);
  release();
  await expect(stopping).resolves.toMatchObject({ value: { unit, stopped: true } });
});

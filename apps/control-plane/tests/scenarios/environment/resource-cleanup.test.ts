import { existsSync } from "node:fs";

import { expect, it } from "vitest";

import { eventually } from "../../support/environment/run-services.js";
import { createServer } from "node:http";
import { createScenarioEnvironment } from "../../support/environment/scenario-environment.js";

it("waits for a timed-out release still finishing cancellation instead of invoking it concurrently", async () => {
  const environment = await createScenarioEnvironment({
    provider: () => {},
    cleanupTimeoutMs: 1000,
  });
  const { promise: releaseFinishing, resolve: finishRelease } = Promise.withResolvers<void>();
  const { promise: releaseFinished, resolve: finishObserved } = Promise.withResolvers<void>();
  let attempts = 0;
  let active = 0;
  let abortObserved = false;
  try {
    environment.registerCleanup("finishing cancellation", (signal) => {
      attempts++;
      active++;
      signal.addEventListener(
        "abort",
        () => {
          abortObserved = true;
        },
        { once: true },
      );
      return releaseFinishing.finally(() => {
        active--;
        finishObserved();
      });
    });
    for (let close = 0; close < 2; close++) {
      const report = await environment.close();
      expect(report.failures.map((failure) => failure.resource)).toEqual([
        "finishing cancellation",
      ]);
      expect(environment.resources).toEqual(["finishing cancellation"]);
    }
    expect(abortObserved).toBe(true);
    expect(attempts).toBe(1);
    expect(active).toBe(1);
    finishRelease();
    await releaseFinished;
    expect(await environment.close()).toEqual({
      released: ["finishing cancellation"],
      failures: [],
    });
    expect(attempts).toBe(1);
    expect(active).toBe(0);
  } finally {
    finishRelease();
    await releaseFinished;
    await environment.close();
  }
}, 30_000);

it("bounds stalled evidence and resource callbacks, cleans other services, and retries the unreleased resource", async () => {
  const environment = await createScenarioEnvironment({
    provider: () => {},
    cleanupTimeoutMs: 1000,
  });
  let attempts = 0;
  let evidenceCancelled = false;
  try {
    environment.beforeClose(
      "stalled evidence",
      (signal) =>
        new Promise<void>((_resolve, reject) => {
          signal.addEventListener(
            "abort",
            () => {
              evidenceCancelled = true;
              reject(signal.reason);
            },
            { once: true },
          );
        }),
    );
    environment.registerCleanup("stalled release", (signal) => {
      if (++attempts > 1) return;
      return new Promise<void>((_resolve, reject) =>
        signal.addEventListener("abort", () => reject(signal.reason), { once: true }),
      );
    });
    const report = await environment.close();
    expect(report.failures.map((failure) => failure.resource)).toEqual([
      "before close: stalled evidence",
      "stalled release",
    ]);
    expect(evidenceCancelled).toBe(true);
    expect(environment.processes.every((output) => output.exitStatus !== undefined)).toBe(true);
    expect(existsSync(environment.directory)).toBe(false);
    expect(environment.resources).toEqual(["stalled release"]);
    expect(await environment.close()).toEqual({ released: ["stalled release"], failures: [] });
    expect(attempts).toBe(2);
  } finally {
    await environment.close();
  }
}, 30_000);

it.each(["SIGINT", "SIGTERM"])(
  "releases its real services on driver %s cancellation",
  async (signal) => {
    const environment = await createScenarioEnvironment({ provider: () => {} });
    let received = false;
    const guard = () => {
      received = true;
    };
    // Keep a failing test alive so its finally can clean up the actual services.
    process.on(signal, guard);
    try {
      process.kill(process.pid, signal);
      await eventually(
        () =>
          received &&
          environment.processes.every((output) => output.exitStatus !== undefined) &&
          !existsSync(environment.directory)
            ? true
            : undefined,
        `${signal} cleanup`,
        2000,
      );
      expect(environment.cleanupReports.at(-1)?.failures).toEqual([]);
      expect(environment.resources).toEqual([]);
    } finally {
      await environment.close();
      process.removeListener(signal, guard);
    }
  },
  30_000,
);

it("records a release failure separately, still closes all other resources, and retries it on repeated close", async () => {
  const environment = await createScenarioEnvironment({ provider: () => {} });
  const extra = createServer((_request, response) => response.end("registered-resource"));
  let releaseAttempts = 0;
  await new Promise<void>((done) => extra.listen(0, "127.0.0.1", done));
  const address = extra.address();
  if (!address || typeof address === "string") throw new Error("Extra test server has no port");
  const url = `http://127.0.0.1:${address.port}`;
  try {
    environment.registerCleanup("extra server", async () => {
      if (++releaseAttempts === 1) throw new Error("Synthetic single release failure");
      extra.closeAllConnections();
      await new Promise<void>((done, reject) =>
        extra.close((error) => (error ? reject(error) : done())),
      );
    });
    let observedBeforeRelease = false;
    environment.beforeClose("observe resources", async () => {
      observedBeforeRelease =
        existsSync(environment.directory) &&
        environment.processes.every((output) => output.exitStatus === undefined);
      expect((await environment.request("/api/status")).ok).toBe(true);
    });
    const first = await environment.close();
    expect(observedBeforeRelease).toBe(true);
    expect(first.failures).toEqual([
      {
        resource: "extra server",
        error: expect.objectContaining({ message: "Synthetic single release failure" }),
      },
    ]);
    expect(first.released).toEqual(
      expect.arrayContaining(["local provider", "synthetic directory"]),
    );
    expect(environment.processes.every((output) => output.exitStatus !== undefined)).toBe(true);
    expect(existsSync(environment.directory)).toBe(false);
    expect(await (await fetch(url)).text()).toBe("registered-resource");
    expect(await environment.close()).toEqual({ released: ["extra server"], failures: [] });
    expect(await environment.close()).toEqual({ released: [], failures: [] });
    expect(releaseAttempts).toBe(2);
  } finally {
    await environment.close();
    extra.closeAllConnections();
    if (extra.listening) await new Promise<void>((done) => extra.close(() => done()));
  }
}, 30_000);

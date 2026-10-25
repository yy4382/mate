import type { ScriptedRequest } from "@mate/testkit";
import { describe, expect, it } from "vitest";
import { testAgent, text } from "./support.ts";

const bash = (
  command: string,
  options: { background?: boolean; timeout?: number; node?: string } = {},
) => ({
  name: "bash",
  arguments: { command, ...options },
});
const background = (command: string, node?: string) =>
  bash(command, { background: true, ...(node === undefined ? {} : { node }) });
const bashStop = (id: number) => ({ name: "bash_stop", arguments: { id } });

/** The command ID in the output of the `bash` call `callId`, which started a background command. */
function commandId(request: ScriptedRequest, callId: string | undefined): number {
  const match = /background command (\d+)/.exec(request.toolOutput(callId ?? "") ?? "");
  if (match?.[1] === undefined) throw new Error(`call ${callId} started no background command`);
  return Number(match[1]);
}

/** How many of a request's user messages report on background command `id`. */
const reports = (request: ScriptedRequest | undefined, id: number) =>
  request?.userTexts().filter((value) => value.startsWith(`[background command ${id} `)).length ??
  0;

/** Claims the conversation whose first message is `message`: the assistant spawned with it. */
const openedWith = (message: string) => (request: { userTexts(): string[] }) =>
  request.userTexts()[0] === message;

describe("background commands", () => {
  it("returns a command ID at once, and the conversation works and goes idle while the command runs", async () => {
    const agent = await testAgent();
    let started: string[] = [];
    agent.provider
      .step("starts the build", (request) => {
        started = request.call([background("make")]);
      })
      .step("keeps working", (request) => {
        expect(request.toolOutput(started[0] ?? ""), "bash returned a command ID").toMatch(
          /background command \d+/,
        );
        request.call([bash("ls")]);
      })
      .step("answers", (request) => request.text("started the build and looked around"));
    const { runtime } = await agent.open();

    const input = await runtime.submit("build it", { requestId: "m1" });
    const build = await agent.workspace.nextCall();
    const ls = await agent.workspace.nextCall();
    expect(ls.request.arguments["command"], "a second command ran beside the first").toBe("ls");
    ls.resolve(text("Makefile"));

    expect(await input.settled(), "the run ended while the command still runs").toBe("done");
    await runtime.idle();
    expect(build.signal.aborted, "the background command was not stopped").toBe(false);
    agent.provider.assertComplete();
  });

  it("reports the command's result once, as an input to the conversation that started it", async () => {
    const agent = await testAgent();
    const finished = Promise.withResolvers<void>();
    let started: string[] = [];
    let id = 0;
    agent.provider
      .step("starts the build", (request) => {
        started = request.call([background("make")]);
      })
      .step("acknowledges", (request) => {
        id = commandId(request, started[0]);
        request.text("started");
      })
      .step("reads the result", (request) => {
        expect(reports(request, id), "one report").toBe(1);
        const report = request.userTexts().find((value) => value.includes(`command ${id}`));
        expect(report, "the report carries the command's output").toContain("built 3 targets");
        request.text("the build is done");
        finished.resolve();
      });
    const { runtime } = await agent.open();

    await (await runtime.submit("build it", { requestId: "m1" })).settled();
    const build = await agent.workspace.nextCall();
    build.resolve(text("built 3 targets"));
    await finished.promise;
    await runtime.idle();

    expect(
      await runtime.withdraw(`command:${id}`),
      "the report was admitted under the request ID command:<ID>",
    ).toBe("settled");
    expect(agent.workspace.calls, "the command ran once").toHaveLength(1);
    agent.provider.assertComplete();
  });

  it("reports the result once when the process dies while the model reads it", async () => {
    const agent = await testAgent();
    const first = await agent.open();
    let started: string[] = [];
    let id = 0;
    agent.provider
      .step("starts the build", (request) => {
        started = request.call([background("make")]);
      })
      .step("acknowledges", (request) => {
        id = commandId(request, started[0]);
        request.text("started");
      })
      .step("reads the result as the process dies", (request) => {
        first.database().freeze();
        void request.hang();
      });
    await (await first.runtime.submit("build it", { requestId: "m1" })).settled();
    (await agent.workspace.nextCall()).resolve(text("built"));
    await agent.provider.received(3);
    // A dead process drops its open requests.
    await first.runtime.close().catch(() => undefined);

    const finished = Promise.withResolvers<void>();
    agent.provider.step("reads the result after the restart", (request) => {
      expect(reports(request, id), "the report is neither lost nor repeated").toBe(1);
      request.text("the build is done");
      finished.resolve();
    });
    const second = await agent.open();
    await finished.promise;
    await second.runtime.idle();

    expect(agent.workspace.calls, "the command ran once").toHaveLength(1);
    agent.provider.assertComplete();
  });

  it("reports a command interrupted by a crash once, as interrupted, and never reruns it", async () => {
    const agent = await testAgent();
    let started: string[] = [];
    let id = 0;
    agent.provider
      .step("starts the deploy", (request) => {
        started = request.call([background("deploy")]);
      })
      .step("acknowledges", (request) => {
        id = commandId(request, started[0]);
        request.text("deploying");
      });
    const first = await agent.open();
    await (await first.runtime.submit("deploy it", { requestId: "m1" })).settled();
    const deploy = await agent.workspace.nextCall();

    first.database().freeze();
    deploy.resolve(text("deployed"));

    const finished = Promise.withResolvers<void>();
    agent.provider.step("reads the interruption", (request) => {
      expect(reports(request, id), "one report").toBe(1);
      expect(request.userTexts().join("\n")).toContain(`[background command ${id} interrupted]`);
      expect(
        request.userTexts().join("\n"),
        "the dead process's late result is not reported",
      ).not.toContain("deployed");
      expect(
        request.userTexts().join("\n"),
        "the report does not claim the command was stopped: it had finished",
      ).not.toMatch(/which stopped it/);
      expect(request.userTexts().join("\n"), "it admits the command may have finished").toContain(
        "may have finished",
      );
      request.text("I will check whether the deploy happened");
      finished.resolve();
    });
    const second = await agent.open();
    await finished.promise;
    await second.runtime.idle();

    expect(agent.workspace.calls, "the deploy was not rerun").toHaveLength(1);
    agent.provider.assertComplete();
  });

  it("stops a command on a named node on close and reports it interrupted once after reopening without rerunning it", async () => {
    const agent = await testAgent();
    let started: string[] = [];
    let id = 0;
    agent.provider
      .step("starts the server", (request) => {
        started = request.call([background("serve", "laptop")]);
      })
      .step("acknowledges", (request) => {
        id = commandId(request, started[0]);
        request.text("serving");
      });
    const first = await agent.open();
    await (await first.runtime.submit("serve it", { requestId: "m1" })).settled();
    const serve = await agent.workspace.nextCall();
    expect(serve.request.node).toBe("laptop");

    await first.runtime.close();
    expect(serve.signal.aborted, "closing stopped the node call").toBe(true);

    const finished = Promise.withResolvers<void>();
    agent.provider.step("reads the interruption", (request) => {
      expect(reports(request, id), "one report").toBe(1);
      expect(request.userTexts().join("\n")).toContain(
        `[background command ${id} interrupted on node laptop]`,
      );
      request.text("the server stopped");
      finished.resolve();
    });
    const second = await agent.open();
    await finished.promise;
    await second.runtime.idle();
    await second.runtime.close();

    const third = await agent.open();
    await third.runtime.idle();
    expect(agent.workspace.calls, "the server was not restarted").toHaveLength(1);
    agent.provider.assertComplete();
  });

  it("stops a background command with bash_stop: the node call is aborted and no result is reported", async () => {
    const agent = await testAgent();
    let started: string[] = [];
    let stops: string[] = [];
    let serve: Awaited<ReturnType<typeof agent.workspace.nextCall>> | undefined;
    let id = 0;
    agent.provider
      .step("starts the server", (request) => {
        started = request.call([background("serve")]);
      })
      .step("stops it", async (request) => {
        id = commandId(request, started[0]);
        serve = await agent.workspace.nextCall();
        stops = request.call([bashStop(id), bashStop(id)]);
      })
      .step("continues", (request) => {
        expect(request.toolOutput(stops[0] ?? "")).toBe(`Stopped background command ${id}.`);
        expect(request.toolOutput(stops[1] ?? ""), "stopping again changes nothing").toBe(
          `Stopped background command ${id}.`,
        );
        request.text("stopped the server");
      });
    const { runtime } = await agent.open();

    await (await runtime.submit("start and stop a server", { requestId: "m1" })).settled();
    expect(serve?.signal.aborted, "the node call was stopped").toBe(true);
    serve?.resolve(text("late output"));
    await runtime.idle();

    expect(await runtime.withdraw(`command:${id}`), "no result was reported").toBe("not_found");
    expect(agent.workspace.calls).toHaveLength(1);
    agent.provider.assertComplete();
  });

  it("answers bash_stop for a command that already ended, or that it does not know, without stopping anything", async () => {
    const agent = await testAgent();
    const finished = Promise.withResolvers<void>();
    let started: string[] = [];
    let stops: string[] = [];
    let id = 0;
    agent.provider
      .step("starts the build and a server", (request) => {
        started = request.call([background("make"), background("serve")]);
      })
      .step("acknowledges", (request) => {
        id = commandId(request, started[0]);
        request.text("started");
      })
      .step("stops it after its result arrived", (request) => {
        expect(reports(request, id)).toBe(1);
        stops = request.call([bashStop(id), bashStop(id + 1000)]);
      })
      .step("reads the answers", (request) => {
        expect(request.toolOutput(stops[0] ?? ""), "an ended command has nothing to stop").toMatch(
          /already ended/,
        );
        expect(request.toolOutput(stops[1] ?? ""), "an unknown ID is named").toContain(
          `no background command ${id + 1000}`,
        );
        request.text("nothing to stop");
        finished.resolve();
      });
    const { runtime } = await agent.open();

    await (await runtime.submit("build it", { requestId: "m1" })).settled();
    const calls = [await agent.workspace.nextCall(), await agent.workspace.nextCall()];
    const build = calls.find(({ request }) => request.arguments["command"] === "make");
    const serve = calls.find(({ request }) => request.arguments["command"] === "serve");
    build?.resolve(text("built"));
    await finished.promise;
    await runtime.idle();

    expect(serve?.signal.aborted, "neither stop touched the command still running").toBe(false);
    expect(agent.workspace.calls, "nothing was started again").toHaveLength(2);
    agent.provider.assertComplete();
  });

  it("reports an assistant's background command to the assistant, and only the assistant can stop it", async () => {
    const agent = await testAgent();
    const assistantDone = Promise.withResolvers<void>();
    const primaryRead = Promise.withResolvers<void>();
    const primaryDone = Promise.withResolvers<void>();
    let started: string[] = [];
    let stops: string[] = [];
    let id = 0;
    agent.provider
      .step("primary spawns", (request) => {
        request.call([
          {
            name: "assistant",
            arguments: { action: "spawn", name: "builder", message: "build it" },
          },
        ]);
      })
      .step("primary acknowledges", (request) => request.text("asked the builder"))
      .step("primary tries to stop the assistant's command", (request) => {
        stops = request.call([bashStop(id)]);
      })
      .step("primary reads the refusal", (request) => {
        expect(request.toolOutput(stops[0] ?? ""), "it is not the primary's command").toContain(
          `no background command ${id}`,
        );
        request.text("noted");
        primaryRead.resolve();
      })
      .step("primary reads the assistant's answer to the report", (request) => {
        request.text("good");
        primaryDone.resolve();
      });
    agent.provider
      .lane("builder", openedWith("build it"))
      .step("assistant starts the build", (request) => {
        started = request.call([background("make")]);
      })
      .step("assistant answers", (request) => {
        id = commandId(request, started[0]);
        request.text(`build started as command ${id}`);
      })
      .step("assistant reads the result", (request) => {
        expect(reports(request, id), "the assistant gets the report once").toBe(1);
        request.text("the build is done");
        assistantDone.resolve();
      });
    const { runtime } = await agent.open();

    await runtime.submit("get it built", { requestId: "m1" });
    const build = await agent.workspace.nextCall();
    await primaryRead.promise;
    expect(build.signal.aborted, "the assistant's command still runs").toBe(false);
    build.resolve(text("built"));
    await assistantDone.promise;
    await primaryDone.promise;
    await runtime.idle();

    const primary = agent.provider.requests.filter((request) => request.lane === "default");
    expect(
      primary
        .flatMap((request) => request.userTexts())
        .filter((value) => value.startsWith("[background command")),
      "the primary conversation never sees the report",
    ).toEqual([]);
    expect(await runtime.withdraw(`command:${id}`), "nor is it admitted there").toBe("not_found");
    agent.provider.assertComplete();
  });
  it("reports an assistant's answer to its background command's result to the primary conversation once", async () => {
    const agent = await testAgent();
    const finished = Promise.withResolvers<void>();
    let started: string[] = [];
    let id = 0;
    agent.provider
      .step("primary spawns", (request) => {
        request.call([
          {
            name: "assistant",
            arguments: { action: "spawn", name: "builder", message: "build it" },
          },
        ]);
      })
      .step("primary acknowledges", (request) => request.text("asked the builder"))
      .step("primary reads that the build started", (request) => {
        expect(request.userTexts()).toContain(
          `[assistant builder answered] build started as command ${id}`,
        );
        request.text("waiting");
      })
      .step("primary reads the assistant's answer to the result", (request) => {
        const answers = request
          .userTexts()
          .filter((value) => value === "[assistant builder answered] built 3 targets");
        expect(answers, "the answer to the command's result is reported once").toHaveLength(1);
        request.text("the build is done");
        finished.resolve();
      });
    agent.provider
      .lane("builder", openedWith("build it"))
      .step("assistant starts the build", (request) => {
        started = request.call([background("make")]);
      })
      .step("assistant answers", (request) => {
        id = commandId(request, started[0]);
        request.text(`build started as command ${id}`);
      })
      .step("assistant answers the result", (request) => {
        expect(reports(request, id), "the assistant gets the report once").toBe(1);
        request.text("built 3 targets");
      });
    const { runtime } = await agent.open();

    await runtime.submit("get it built", { requestId: "m1" });
    const build = await agent.workspace.nextCall();
    await agent.provider.received(5);
    build.resolve(text("built 3 targets"));
    await finished.promise;
    await runtime.idle();

    agent.provider.assertComplete();
  });
  it("reports an assistant's answer to its background command's result once when the process dies while the assistant reads the result", async () => {
    const agent = await testAgent();
    const first = await agent.open();
    const primaryWaits = Promise.withResolvers<void>();
    let started: string[] = [];
    let id = 0;
    agent.provider
      .step("primary spawns", (request) => {
        request.call([
          {
            name: "assistant",
            arguments: { action: "spawn", name: "builder", message: "build it" },
          },
        ]);
      })
      .step("primary acknowledges", (request) => request.text("asked the builder"))
      .step("primary reads that the build started", (request) => {
        request.text("waiting");
        primaryWaits.resolve();
      });
    const builder = agent.provider.lane("builder", openedWith("build it"));
    builder
      .step("assistant starts the build", (request) => {
        started = request.call([background("make")]);
      })
      .step("assistant answers", (request) => {
        id = commandId(request, started[0]);
        request.text(`build started as command ${id}`);
      })
      .step("assistant reads the result as the process dies", (request) => {
        first.database().freeze();
        void request.hang();
      });
    await first.runtime.submit("get it built", { requestId: "m1" });
    const build = await agent.workspace.nextCall();
    await primaryWaits.promise;
    await first.runtime.idle();
    build.resolve(text("built 3 targets"));
    await builder.received(3);
    // A dead process drops its open requests.
    await first.runtime.close().catch(() => undefined);

    const finished = Promise.withResolvers<void>();
    builder.step("assistant answers the result after the restart", (request) => {
      expect(reports(request, id), "the assistant gets the report once").toBe(1);
      request.text("built 3 targets");
    });
    agent.provider.step("primary reads the assistant's answer to the result", (request) => {
      const answers = request
        .userTexts()
        .filter((value) => value === "[assistant builder answered] built 3 targets");
      expect(answers, "the answer is neither lost nor repeated").toHaveLength(1);
      request.text("the build is done");
      finished.resolve();
    });
    const second = await agent.open();
    await finished.promise;
    await second.runtime.idle();

    expect(agent.workspace.calls, "the command ran once").toHaveLength(1);
    agent.provider.assertComplete();
  });
});

describe("bash timeouts", () => {
  it("gives a foreground command ten minutes unless it names a timeout, and a background command none", async () => {
    const agent = await testAgent();
    agent.provider
      .step("runs three commands", (request) => {
        request.call([bash("make"), bash("make", { timeout: 3600 }), background("serve")]);
      })
      .step("answers", (request) => request.text("ran them"));
    const { runtime } = await agent.open();

    const input = await runtime.submit("run them", { requestId: "m1" });
    (await agent.workspace.nextCall()).resolve(text("built"));
    (await agent.workspace.nextCall()).resolve(text("built"));
    await agent.workspace.nextCall();
    await input.settled();

    expect(agent.workspace.calls.map((call) => call.arguments)).toEqual([
      { command: "make", background: false, timeout: 600 },
      { command: "make", background: false, timeout: 3600 },
      { command: "serve", background: true },
    ]);
    agent.provider.assertComplete();
  });

  it("refuses a timeout past an hour in the foreground or past a day in the background, sending nothing to the node", async () => {
    const agent = await testAgent();
    let calls: string[] = [];
    agent.provider
      .step("asks for too long", (request) => {
        calls = request.call([
          bash("make", { timeout: 3601 }),
          bash("serve", { background: true, timeout: 86_401 }),
        ]);
      })
      .step("reads the refusals", (request) => {
        expect(request.toolOutput(calls[0] ?? ""), "the foreground limit is named").toMatch(/3600/);
        expect(request.toolOutput(calls[1] ?? ""), "the background limit is named").toMatch(
          /86400/,
        );
        request.text("too long");
      });
    const { runtime } = await agent.open();

    await (await runtime.submit("run them", { requestId: "m1" })).settled();

    expect(agent.workspace.calls, "the node received nothing").toEqual([]);
    agent.provider.assertComplete();
  });
});

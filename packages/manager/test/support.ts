import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import { ChatApp, type TimelineRef } from "@mate/chat";
import type { AgentSettings, ModelResolver, WorkspacePort } from "@mate/runtime";
import { FakeClock, FakeWorkspace, ScriptedProvider, temporaryDirectory } from "@mate/testkit";
import { join } from "node:path";
import { onTestFinished } from "vitest";
import {
  openAgentManager,
  type AgentManager,
  type AgentSpec,
  type WorkspaceHost,
} from "../src/index.ts";

export { FakeWorkspace, toolText as text } from "@mate/testkit";

export const settings: AgentSettings = { model: { provider: "openai", modelId: "gpt-4.1" } };

/** Stands in for the node: workspaces are prepared on request, and each Agent has one fake workspace. */
export class FakeWorkspaces implements WorkspaceHost {
  readonly prepared = new Set<string>();
  readonly #workspaces = new Map<string, FakeWorkspace>();
  /** Runs at the start of the next `prepare` and is then forgotten: a test makes a preparation fail with it. */
  beforeNextPrepare: ((agentId: string) => void) | undefined;
  /** Called whenever a runtime is opened, before it is: a test checks what holds at that moment. */
  onOpen: ((agentId: string) => void) | undefined;

  async prepare(agentId: string): Promise<void> {
    this.prepared.add(agentId);
    const hook = this.beforeNextPrepare;
    this.beforeNextPrepare = undefined;
    hook?.(agentId);
  }

  port(agentId: string): WorkspacePort {
    this.onOpen?.(agentId);
    return this.workspace(agentId);
  }

  workspace(agentId: string): FakeWorkspace {
    let workspace = this.#workspaces.get(agentId);
    if (workspace === undefined) {
      workspace = new FakeWorkspace();
      this.#workspaces.set(agentId, workspace);
    }
    return workspace;
  }
}

/** The real chat app, with a hook that runs inside the next send by a given account, before the send is checked. */
export class InterceptedChat extends ChatApp {
  #beforeSend: { account: number; run: () => void } | undefined;

  beforeNextSendBy(account: number, run: () => void): void {
    this.#beforeSend = { account, run };
  }

  override send(...args: Parameters<ChatApp["send"]>): ReturnType<ChatApp["send"]> {
    const hook = this.#beforeSend;
    if (hook?.account === args[0]) {
      this.#beforeSend = undefined;
      hook.run();
    }
    return super.send(...args);
  }
}

export type Environment = Awaited<ReturnType<typeof environment>>;

/**
 * Everything around an Agent Manager: a data directory, the real chat app with the owner and #general, a scripted
 * provider, fake workspaces and a fake clock. Managers opened here are closed after the test, before the rest.
 */
export async function environment() {
  const data = temporaryDirectory();
  const chat = new InterceptedChat(join(data, "chat.sqlite"));
  const provider = await ScriptedProvider.start();
  const workspaces = new FakeWorkspaces();
  const clock = new FakeClock(Date.UTC(2026, 0, 1, 9, 30, 5));
  const reports: { agentId: string; error: unknown }[] = [];
  const managers: AgentManager[] = [];
  onTestFinished(async () => {
    await Promise.all(managers.map((manager) => manager.close().catch(() => undefined)));
    await provider.close();
    chat.close();
  });
  const catalog = builtinModels();
  const resolveModel: ModelResolver = ({ provider: name, modelId }) => {
    const model = catalog.getModel(name, modelId);
    return model === undefined ? undefined : { ...model, baseUrl: provider.baseUrl };
  };
  const owner = chat.ensureAccount({
    externalId: "owner",
    displayName: "Owner",
    handle: "owner",
    role: "owner",
  });
  const general = chat.createChannel(owner, {
    requestId: "setup:general",
    name: "general",
    visibility: "public",
  }).conversationId;
  let posts = 0;

  return {
    data,
    directory: join(data, "agents"),
    chat,
    provider,
    workspaces,
    clock,
    reports,
    owner,
    general,
    /** Open a manager on the data directory, as a control plane start would. */
    async open(): Promise<AgentManager> {
      const manager = await openAgentManager({
        directory: join(data, "agents"),
        chat,
        workspaces,
        apiKey: () => "test-key",
        resolveModel,
        clock,
        report: (error, agentId) => reports.push({ agentId, error }),
      });
      managers.push(manager);
      return manager;
    },
    /** Create an Agent and have the owner invite it to #general. Returns its ID and chat account. */
    async hire(manager: AgentManager, spec: Partial<AgentSpec> = {}) {
      const handle = spec.handle ?? "richard";
      const agentId = await manager.create({
        displayName: spec.displayName ?? "Richard",
        handle,
        settings,
        ...(spec.agentId === undefined ? {} : { agentId: spec.agentId }),
      });
      const account = chat.findAccount(agentId);
      if (account === undefined) throw new Error("the created Agent has no account");
      chat.invite(owner, {
        requestId: `invite:${agentId}`,
        conversationId: general,
        invitee: account,
      });
      return { agentId, account };
    },
    /** The owner posts, as the web client does: without the freshness check. */
    post(body: string, options: { mentions?: number[]; timeline?: TimelineRef } = {}) {
      return chat.send(owner, options.timeline ?? { conversation: general }, {
        requestId: `owner:${++posts}`,
        body,
        freshness: false,
        ...(options.mentions === undefined ? {} : { mentions: options.mentions }),
      });
    },
    /** The messages in #general, oldest first. */
    messages() {
      return chat
        .readHistory(owner, { conversation: general })
        .flatMap((entry) =>
          entry.kind === "message" ? [{ author: entry.author, body: entry.body }] : [],
        )
        .reverse();
    },
  };
}

/** The notices among a request's user texts. */
export function notices(texts: readonly string[]): string[] {
  return texts.filter((each) => each.startsWith("截至 "));
}

/** Let every callback already due run: timers, I/O and the promises they settle. */
export function settle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 50));
}

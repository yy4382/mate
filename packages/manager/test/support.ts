import { ChatApp, type TimelineRef } from "@mate/chat";
import type { AgentSettings, WorkspacePort } from "@mate/runtime";
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

/** The node Agents are created on unless a test chooses another. */
export const nodeId = "node-a";

/** Stands in for the nodes: workspaces are prepared on request, and each Agent has a fake workspace on each node. */
export class FakeWorkspaces implements WorkspaceHost {
  /** The node each Agent's workspace was last prepared on. */
  readonly prepared = new Map<string, string>();
  /** Every port handed out, in order: the node each opened runtime runs its workspace tools on. */
  readonly ports: { agentId: string; nodeId: string }[] = [];
  readonly #workspaces = new Map<string, FakeWorkspace>();
  /** Runs at the start of the next `prepare` and is then forgotten: a test makes a preparation fail with it. */
  beforeNextPrepare: ((agentId: string) => void) | undefined;
  /** Called whenever a runtime is opened, before it is: a test checks what holds at that moment. */
  onOpen: ((agentId: string) => void) | undefined;

  async prepare(node: string, agentId: string): Promise<void> {
    this.prepared.set(agentId, node);
    const hook = this.beforeNextPrepare;
    this.beforeNextPrepare = undefined;
    hook?.(agentId);
  }

  port(node: string, agentId: string): WorkspacePort {
    this.onOpen?.(agentId);
    this.ports.push({ agentId, nodeId: node });
    return this.workspace(agentId, node);
  }

  /** The Agent's workspace on `node`. */
  workspace(agentId: string, node = nodeId): FakeWorkspace {
    const key = `${node}/${agentId}`;
    let workspace = this.#workspaces.get(key);
    if (workspace === undefined) {
      workspace = new FakeWorkspace();
      this.#workspaces.set(key, workspace);
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
        credentials: () => ({ apiKey: "test-key", baseUrl: provider.baseUrl }),
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
        nodeId: spec.nodeId ?? nodeId,
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

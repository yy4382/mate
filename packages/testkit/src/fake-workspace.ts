import type { ToolName, ToolResult } from "@mate/node-protocol";

/**
 * A whole workspace tool call as the runtime forwards it. Declared here rather than imported from @mate/runtime, so
 * the test kit does not depend on the package whose tests use it. A FakeWorkspace still has to type-check as the
 * runtime's `WorkspacePort` wherever a test passes one in.
 */
export type WorkspaceToolRequest = {
  readonly tool: ToolName;
  readonly arguments: Readonly<Record<string, unknown>>;
  readonly node?: string;
  readonly conversationId: number;
};
type WorkspaceToolResult = ToolResult;

type WorkspaceNode = {
  readonly name: string;
  readonly online: boolean;
  readonly platform: string | null;
  readonly home: boolean;
};

export type PendingWorkspaceCall = {
  readonly request: WorkspaceToolRequest;
  readonly signal: AbortSignal;
  resolve(result: WorkspaceToolResult): void;
};

/** One Agent's workspace on a stand-in node: records each forwarded call and lets the test answer it. */
export class FakeWorkspace {
  readonly calls: WorkspaceToolRequest[] = [];
  readonly #pending: PendingWorkspaceCall[] = [];
  readonly #arrivals: (() => void)[] = [];
  #nodes: WorkspaceNode[] = [];
  #autoAnswer: ((request: WorkspaceToolRequest) => WorkspaceToolResult) | undefined;

  setNodes(nodes: readonly WorkspaceNode[]): void {
    this.#nodes = [...nodes];
  }

  async nodes(): Promise<WorkspaceNode[]> {
    return [...this.#nodes];
  }

  /** Answer every call from now on at once, instead of leaving it for `nextCall`. */
  answerAll(answer: (request: WorkspaceToolRequest) => WorkspaceToolResult): void {
    this.#autoAnswer = answer;
  }

  run(
    request: WorkspaceToolRequest,
    _output: (chunk: string) => void,
    signal: AbortSignal,
  ): Promise<WorkspaceToolResult> {
    this.calls.push(request);
    for (const arrived of this.#arrivals.splice(0)) arrived();
    if (this.#autoAnswer !== undefined) return Promise.resolve(this.#autoAnswer(request));
    const { promise, resolve } = Promise.withResolvers<WorkspaceToolResult>();
    this.#pending.push({ request, signal, resolve });
    return promise;
  }

  /** Wait until a call is in flight and return it, unanswered. */
  async nextCall(): Promise<PendingWorkspaceCall> {
    while (this.#pending.length === 0)
      await new Promise<void>((resolve) => this.#arrivals.push(resolve));
    const call = this.#pending.shift();
    if (call === undefined) throw new Error("no pending workspace call");
    return call;
  }
}

/** A successful (or, with `isError`, failed) tool result carrying one text. */
export function toolText(value: string, isError = false): WorkspaceToolResult {
  return { content: [{ type: "text", text: value }], isError };
}

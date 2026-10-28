import { createContext, useContext, type Dispatch, type SetStateAction } from "react";
import { randomUUID } from "expo-crypto";
import type { ManagementClient } from "./client";
import { emptySettings, type SettingsDraft } from "./settings";

type CreationInput = Parameters<ManagementClient["createAgent"]>[0];
type Attempt =
  | { kind: "new"; agentId: string }
  | { kind: "pending" | "interrupted" | "succeeded"; agentId: string; input: CreationInput };
type Draft = {
  displayName: string;
  handle: string;
  nodeId: string;
  settings: SettingsDraft;
  attempt: Attempt;
};
export function newAgentDraft(): Draft {
  return {
    displayName: "",
    handle: "",
    nodeId: "",
    settings: emptySettings,
    attempt: { kind: "new", agentId: randomUUID() },
  };
}
/** Held by each login's management `Session`, so a new client starts with a new draft. */
export const Creation = createContext<readonly [Draft, Dispatch<SetStateAction<Draft>>] | null>(
  null,
);

export function useAgentCreationDraft() {
  const draft = useContext(Creation);
  if (!draft) throw new Error("Agent creation requires a management session");
  return draft;
}

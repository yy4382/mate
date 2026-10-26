import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { randomUUID } from "expo-crypto";
import { auth } from "../auth-native";
import type { SignedIn } from "./client";
import { emptySettings, type SettingsDraft } from "./settings";

type Draft = {
  displayName: string;
  handle: string;
  nodeId: string;
  settings: SettingsDraft;
  attempt: { kind: "new" | "pending" | "interrupted"; agentId: string };
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
type Update = (change: (draft: Draft) => Draft) => void;
const Creation = createContext<readonly [Draft, Update] | null>(null);

export function AgentCreationProvider({ children }: { children: ReactNode }) {
  const [draft, setDraft] = useState(newAgentDraft);
  const generation = useRef(0);
  useEffect(() => {
    let owner: SignedIn | undefined;
    const reset = () => {
      generation.current++;
      setDraft(newAgentDraft());
    };
    const update = () => {
      const state = auth.getSnapshot();
      if (state.kind === "signed-in") {
        if (
          !owner ||
          state.server !== owner.server ||
          state.human.accountId !== owner.human.accountId ||
          state.human.role !== owner.human.role
        )
          reset();
        owner = state;
      } else if (
        (state.kind === "checking" || state.kind === "unavailable") &&
        state.server === owner?.server
      ) {
        return;
      } else {
        owner = undefined;
        reset();
      }
    };
    const stop = auth.subscribe(update);
    update();
    return stop;
  }, []);
  const version = generation.current;
  const update: Update = (change) =>
    setDraft((current) => (generation.current === version ? change(current) : current));
  return <Creation.Provider value={[draft, update]}>{children}</Creation.Provider>;
}

export function useAgentCreationDraft() {
  const draft = useContext(Creation);
  if (!draft) throw new Error("Agent creation requires its login-scoped draft provider");
  return draft;
}

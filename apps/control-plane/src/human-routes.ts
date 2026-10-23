import { AccountNames, type ChatApp } from "@mate/chat";
import { z } from "zod";
import { NewPassword, Role, type HumanRecord, type Humans } from "./humans.ts";
import { HttpError, parseBody } from "./http.ts";
import { adminOnly, type Route, type RouteInput } from "./routes.ts";

/** A human as a client renders them: the chat account's names and the shell's role. */
export type HumanView = {
  readonly accountId: number;
  readonly handle: string;
  readonly displayName: string;
  readonly role: Role;
  readonly active: boolean;
};

const RequestId = z.string().min(1).max(128);
const ChangePassword = z.object({ current: z.string().max(1024), next: NewPassword });
const AddHuman = AccountNames.extend({
  requestId: RequestId,
  password: NewPassword,
  role: Role,
});

/** The external ID of the human an admin added with `requestId`. */
const addedHuman = (requestId: string) => `human:request:${requestId}`;

/** The requesting human's own profile and password, and the admin's management of every human. */
export function humanRoutes(chat: ChatApp, humans: Humans): Route[] {
  function view(externalId: string): HumanView {
    const record = humans.get(externalId);
    const accountId = chat.findAccount(externalId);
    const account = chat.listAccounts().find((candidate) => candidate.accountId === accountId);
    if (record === undefined || account === undefined)
      throw new Error(`human ${externalId} has no chat account`);
    return {
      accountId: account.accountId,
      handle: account.handle,
      displayName: account.displayName,
      role: record.role,
      active: record.active,
    };
  }

  function target({ params }: RouteInput): HumanRecord & { accountId: number } {
    const accountId = Number(params.accountId);
    for (const record of humans.list()) {
      if (chat.findAccount(record.externalId) === accountId) return { ...record, accountId };
    }
    throw new HttpError(404, "unknown-account", `account ${params.accountId} is not a human`);
  }

  const own: Route[] = [
    { method: "GET", path: "/api/me", json: ({ human }) => view(human.externalId) },
    {
      method: "PATCH",
      path: "/api/me",
      json: ({ human, body }) => {
        const names = parseBody(AccountNames, body);
        chat.ensureAccount({ externalId: human.externalId, kind: "human", ...names });
        return view(human.externalId);
      },
    },
    {
      method: "POST",
      path: "/api/me/password",
      json: async ({ human, body }) => {
        const { current, next } = parseBody(ChangePassword, body);
        const result = await humans.changeOwnPassword(human.externalId, current, next, human.token);
        if (result === "wrong")
          throw new HttpError(403, "wrong-password", "the current password is wrong");
        if (result === "limited") throw new HttpError(429, "too-many-attempts");
      },
    },
  ];

  const managed: Route[] = [
    {
      method: "GET",
      path: "/api/humans",
      json: () => humans.list().map((record) => view(record.externalId)),
    },
    {
      method: "POST",
      path: "/api/humans",
      json: async ({ body }) => {
        const { requestId, password, role, ...names } = parseBody(AddHuman, body);
        const externalId = addedHuman(requestId);
        if (humans.get(externalId) === undefined) {
          chat.ensureAccount({ externalId, kind: "human", ...names });
          await humans.add(externalId, role, password);
        }
        return view(externalId);
      },
    },
    {
      method: "POST",
      path: "/api/humans/:accountId/role",
      json: (input) => {
        const { role } = parseBody(z.object({ role: Role }), input.body);
        const { externalId } = target(input);
        humans.setRole(externalId, role);
        return view(externalId);
      },
    },
    {
      method: "POST",
      path: "/api/humans/:accountId/password",
      json: async (input) => {
        const { password } = parseBody(z.object({ password: NewPassword }), input.body);
        await humans.setPassword(target(input).externalId, password);
      },
    },
    {
      method: "POST",
      path: "/api/humans/:accountId/deactivate",
      json: (input) => {
        const { externalId, accountId } = target(input);
        humans.deactivate(externalId);
        chat.deactivateAccount(accountId, { requestId: "deactivate" });
      },
    },
  ];

  return [...own, ...adminOnly(managed)];
}

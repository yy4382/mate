import { randomUUID } from "node:crypto";
import { describe, expect, it, onTestFinished } from "vitest";
import type { AgentView } from "@mate/admin";
import { HumanView } from "@mate/control-plane/contracts";
import { MobileAuth } from "../src/auth";
import { ManagementClient } from "../src/admin/client";
import { environment, PASSWORD } from "../../control-plane/test/support.ts";

async function mobile(
  receive: (response: Response, init?: RequestInit) => Promise<Response> = async (response) =>
    response,
) {
  const site = await environment().start();
  const server = "https://mate.example.com";
  let cookie = "";
  const network: typeof fetch = async (url, init) => {
    const response = await fetch(String(url).replace(server, site.url), {
      ...init,
      headers: { ...Object.fromEntries(new Headers(init?.headers)), cookie },
    });
    const setCookie = response.headers.get("set-cookie");
    if (setCookie) cookie = setCookie.split(";")[0] ?? "";
    return receive(response, init);
  };
  const auth = new MobileAuth({
    read: () => ({ server, restore: false }),
    write: () => undefined,
    clearCookies: async () => {
      cookie = "";
    },
    fetch: network,
  });
  await auth.start();
  await auth.login("admin", PASSWORD);
  const session = auth.getSnapshot();
  if (session.kind !== "signed-in") throw new Error("native session failed to log in");
  const client = new ManagementClient(auth, session, network, network);
  onTestFinished(() => client.close());
  return { auth, client, site };
}

describe("native management against the control plane HTTP interface", () => {
  it.each([false, true])(
    "retries the same creation after foreground cancellation with preparation succeeding=%s",
    async (succeeds) => {
      const held = Promise.withResolvers<void>();
      const deliver = Promise.withResolvers<void>();
      let hold = true;
      const { client, auth, site } = await mobile(async (response, init) => {
        if (
          hold &&
          response.url.endsWith("/api/admin/agents") &&
          init?.method === "POST" &&
          response.headers.get("content-type")?.includes("application/json")
        ) {
          hold = false;
          held.resolve();
          await deliver.promise;
        }
        return response;
      });
      const admin = site.browser();
      await admin.logInAdmin();
      let broken = !succeeds;
      const nodeId = await site.pairNode(admin, {
        onPrepareWorkspace: async () => {
          if (broken) throw new Error("disposable workspace failure");
        },
      });
      await admin.request("PUT", "/api/admin/providers/openai/credentials", {
        apiKey: "disposable-test-key",
      });
      const input = {
        agentId: randomUUID(),
        nodeId,
        displayName: "Foreground recovery",
        handle: "foreground-recovery",
        settings: { model: { provider: "openai", modelId: "gpt-4.1" } },
      };
      const pending = client.createAgent(input);
      const cancelled = expect(pending).rejects.toMatchObject({ name: "AbortError" });
      await held.promise;
      await auth.revalidate();
      deliver.resolve();
      await cancelled;
      broken = false;
      await client.createAgent(input);
      expect(await client.request<AgentView[]>("/api/admin/agents")).toEqual([
        expect.objectContaining({ agentId: input.agentId, handle: input.handle, state: "open" }),
      ]);
    },
  );

  it("does not report recovery success after the existing Agent disappears", async () => {
    const held = Promise.withResolvers<void>();
    const deliver = Promise.withResolvers<void>();
    onTestFinished(() => deliver.resolve());
    const { client, site } = await mobile(async (response) => {
      if (response.status === 409 && response.url.endsWith("/api/admin/agents")) {
        held.resolve();
        await deliver.promise;
      }
      return response;
    });
    const admin = site.browser();
    await admin.logInAdmin();
    const nodeId = await site.pairNode(admin);
    await admin.request("PUT", "/api/admin/providers/openai/credentials", {
      apiKey: "disposable-test-key",
    });
    const input = {
      agentId: randomUUID(),
      nodeId,
      displayName: "Disappearing",
      handle: "disappearing",
      settings: { model: { provider: "openai", modelId: "gpt-4.1" } },
    };
    await client.createAgent(input);
    const retry = expect(client.createAgent(input)).rejects.toMatchObject({
      reason: "agent-exists",
    });
    await held.promise;
    await admin.request("DELETE", `/api/admin/agents/${input.agentId}`);
    deliver.resolve();
    await retry;
    expect(await client.request("/api/admin/agents")).toEqual([]);
  });

  it("persists native profile and password changes while preserving the current cookie session", async () => {
    const { auth, client } = await mobile();
    await client.saveProfile("Native Name", "native-admin");
    expect(auth.getSnapshot()).toMatchObject({
      kind: "signed-in",
      human: { displayName: "Native Name", handle: "native-admin" },
    });
    expect(HumanView.parse(await client.request("/api/me"))).toMatchObject({
      displayName: "Native Name",
      handle: "native-admin",
    });
    await client.request("/api/me/password", "POST", {
      current: PASSWORD,
      next: "changed native password",
    });
    expect(HumanView.parse(await client.request("/api/me"))).toMatchObject({
      handle: "native-admin",
    });
    await auth.logout();
    await auth.login("native-admin", "changed native password");
    expect(auth.getSnapshot()).toMatchObject({
      kind: "signed-in",
      human: { displayName: "Native Name", handle: "native-admin" },
    });
  });
});

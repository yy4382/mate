import { describe, expect, it, onTestFinished } from "vitest";
import { HumanView } from "@mate/auth";
import { MobileAuth } from "../src/auth";
import { ManagementClient } from "../src/admin/client";
import { environment, PASSWORD } from "../../control-plane/test/support.ts";

async function mobile() {
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
    return response;
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
  return { auth, client, session };
}

describe("native management against the control plane HTTP interface", () => {
  it("keeps server refusal codes available to the native forms", async () => {
    const { client, session } = await mobile();
    await expect(
      client.request(`/api/humans/${session.human.accountId}/role`, "POST", { role: "member" }),
    ).rejects.toMatchObject({ status: 409, reason: "last-admin" });
    await expect(
      client.request("/api/me/password", "POST", {
        current: "wrong",
        next: "new disposable password",
      }),
    ).rejects.toMatchObject({ status: 403, reason: "wrong-password" });
    await expect(client.request("/api/admin/agents", "POST", {})).rejects.toMatchObject({
      status: 400,
      reason: "invalid-input",
    });
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

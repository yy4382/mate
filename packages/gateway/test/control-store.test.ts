import { readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createNodeGateway } from "@mate/gateway";
import {
  ControlStoreIncompatible,
  openControlTables,
  type ControlTables,
} from "@mate/control-store";
import { FakeNode, temporaryDirectory } from "@mate/testkit";
import { startGateway } from "./support.ts";

const webShell: ControlTables = {
  module: "web-shell",
  version: 5,
  ddl: "CREATE TABLE web_sessions (id TEXT PRIMARY KEY) STRICT",
};

function refusal(open: () => unknown): ControlStoreIncompatible {
  try {
    open();
  } catch (error) {
    if (error instanceof ControlStoreIncompatible) return error;
    throw error;
  }
  throw new Error("expected the store to be refused");
}

describe("node gateway registry in control.sqlite (MODULE_TESTS 7)", () => {
  it("keeps its node registry in control.sqlite beside another module's tables, and both reopen at their own versions", async () => {
    const under = await startGateway();
    const paired = await under.pairedNode();
    paired.close();
    await paired.closed();

    const shell = openControlTables(under.dataDirectory, webShell);
    shell.prepare("INSERT INTO web_sessions (id) VALUES ('session-1')").run();
    shell.close();

    under.reopen();
    const again = new FakeNode({ gatewayUrl: under.url, nodeId: paired.nodeId, sign: paired.sign });
    await again.connect();
    expect(again.isAuthenticated, "the paired node is still known after the restart").toBe(true);
    again.close();

    const reopened = openControlTables(under.dataDirectory, webShell);
    expect(
      reopened.prepare("SELECT id FROM web_sessions").all(),
      "the other module's rows are untouched",
    ).toEqual([{ id: "session-1" }]);
    reopened.close();

    const files = readdirSync(under.dataDirectory);
    expect(
      files.every((name) => name.startsWith("control.sqlite")),
      `the gateway writes nothing but control.sqlite: ${files.join(", ")}`,
    ).toBe(true);
  });

  it("pairs a node while another module holds a read transaction open on control.sqlite", async () => {
    const under = await startGateway();
    const shell = openControlTables(under.dataDirectory, webShell);
    shell.exec("BEGIN");
    shell.prepare("SELECT id FROM web_sessions").all();

    const node = await under.pairedNode();
    expect(node.isAuthenticated, "the gateway's write commits beside an open reader").toBe(true);
    expect(under.gateway.nodes().map((n) => n.nodeId)).toEqual([node.nodeId]);

    shell.exec("COMMIT");
    shell.close();
  });

  it("refuses to start, naming control.sqlite, when its own tables are at another schema version, and other modules still open", () => {
    const dataDirectory = temporaryDirectory();
    openControlTables(dataDirectory, webShell).close();
    // What a later gateway build, one that renamed its tables, would have left in the store.
    openControlTables(dataDirectory, {
      module: "gateway",
      version: 2,
      ddl: "CREATE TABLE paired_nodes (id TEXT PRIMARY KEY)",
    }).close();

    const error = refusal(() => createNodeGateway({ dataDirectory }));
    const file = join(dataDirectory, "control.sqlite");
    expect(error.file).toBe(file);
    expect(error.message, "the refusal names the file").toContain(file);

    expect(
      () => openControlTables(dataDirectory, webShell).close(),
      "the gateway's mismatch does not stop another module",
    ).not.toThrow();
  });

  it("refuses to start, naming control.sqlite, when another module already has a table by one of its names", () => {
    const dataDirectory = temporaryDirectory();
    openControlTables(dataDirectory, {
      module: "admin",
      version: 1,
      ddl: "CREATE TABLE nodes (name TEXT PRIMARY KEY)",
    }).close();

    const error = refusal(() => createNodeGateway({ dataDirectory }));
    expect(error.file).toBe(join(dataDirectory, "control.sqlite"));
  });
});

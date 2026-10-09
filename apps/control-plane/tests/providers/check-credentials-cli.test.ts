import { expect, it } from "vitest";

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { resolve } from "node:path";

import { checkProviderProtocol } from "../../src/providers/active-check.js";
import { withProvider } from "../support/provider/protocol-fixture.js";

it("an owner check without an explicitly supplied credential remains unverified", async () => {
  const result = await checkProviderProtocol({ provider: "openai", modelId: "gpt-4o-mini" });
  expect(result.status).toBe("unverified");
  expect(result.reason).toBe("credential_missing");
  expect(result.observed).toEqual({
    textStream: false,
    textCompleted: false,
    toolExecuted: false,
    toolCallAssociated: false,
    continuationCompleted: false,
    toolResultAcknowledged: false,
  });
});

it("HTTP rejection records its status without retaining provider prose or credentials", async () => {
  await withProvider(
    (_request, response) => {
      response.writeHead(401, { "content-type": "application/json" });
      response.end(
        JSON.stringify({ error: { message: "private provider prose and synthetic-secret" } }),
      );
    },
    async (baseUrl, requests) => {
      const result = await checkProviderProtocol(
        { provider: "openai", modelId: "gpt-4o-mini", apiKey: "synthetic-secret" },
        { modelForCheck: (model) => ({ ...model, baseUrl }) },
      );
      expect(result).toMatchObject({
        status: "failed",
        reason: "provider_error",
        stage: "text",
        httpStatus: 401,
      });
      expect(requests).toHaveLength(1);
      expect(JSON.stringify(result)).not.toMatch(/private provider prose|synthetic-secret/);
    },
  );
});

it("the owner CLI without a credential file ignores ambient API keys and reports a real check as unverified", async () => {
  const { stdout, stderr } = await promisify(execFile)(
    process.execPath,
    [
      resolve("dist/providers/active-check-cli.js"),
      "--provider",
      "openai",
      "--model",
      "gpt-4o-mini",
    ],
    { env: { PATH: process.env.PATH, OPENAI_API_KEY: "ambient-secret-must-not-be-used" } },
  );
  expect(stderr).toBe("");
  expect(JSON.parse(stdout)).toMatchObject({
    connection: "real",
    status: "unverified",
    reason: "credential_missing",
    stage: "configuration",
  });
  expect(stdout).not.toContain("ambient-secret-must-not-be-used");
});

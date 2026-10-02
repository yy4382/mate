import { writeFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { eventually } from "../helpers/run-services.js";
import { loopFixture, respond } from "../helpers/agent-loop.js";

const png =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=";

it.each([
  ["image/png", png],
  ["image/jpeg", Buffer.from("ffd8ffe000104a4649460001", "hex").toString("base64")],
  ["image/gif", "R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw=="],
  ["image/webp", Buffer.from("5249464610000000574542505650382000000000", "hex").toString("base64")],
])(
  "sends filesystem %s bytes as image modality through real Pi HTTP despite a text extension",
  async (mimeType, imageData) => {
    let turn = 0;
    const fixture = await loopFixture((_request, response) => {
      respond(
        response,
        turn++ === 0
          ? [
              {
                name: "tools.call",
                input: { name: "workspace.read", input: { path: "picture.txt" } },
              },
            ]
          : "done",
      );
    });
    try {
      const agent = await fixture.agent();
      writeFileSync(join(agent.workspace, "picture.txt"), Buffer.from(imageData, "base64"));
      await fixture.send(agent.channelId, "Read the image.");
      await fixture.completed(agent.id);
      const request = fixture.requests.at(-1)!;
      const blocks = request.input.flatMap((item) =>
        [item.content, item.output].flatMap((value) => (Array.isArray(value) ? value : [])),
      );
      expect(blocks).toContainEqual(
        expect.objectContaining({
          type: "input_image",
          image_url: `data:${mimeType};base64,${imageData}`,
        }),
      );
      const text = [
        ...request.input
          .filter((item) => typeof item.output === "string")
          .map((item) => item.output),
        ...blocks.filter((block) => block.type === "input_text"),
      ];
      expect(JSON.stringify(text)).not.toContain(imageData);
    } finally {
      await fixture.close();
    }
  },
  30000,
);

it.each([false, true])(
  "projects stored images to a text-only model without mutating history (compaction=%s)",
  async (compact) => {
    let turn = 0;
    const fixture = await loopFixture(
      (request, response) => {
        if (JSON.stringify(request.input[0]).includes("context summarization assistant")) {
          respond(response, "## Goal\nKeep the completed image read and continue.");
        } else if (turn++ === 0) {
          respond(response, [
            { name: "tools.call", input: { name: "workspace.read", input: { path: "image" } } },
          ]);
        } else {
          respond(
            response,
            compact && turn === 2 ? "x".repeat(28000) : "done",
            undefined,
            compact && turn === 2 ? 15000 : 50,
          );
        }
      },
      "",
      compact ? 16000 : undefined,
    );
    try {
      const agent = await fixture.agent();
      writeFileSync(join(agent.workspace, "image"), Buffer.from(png, "base64"));
      await fixture.send(agent.channelId, "Read image.");
      await fixture.completed(agent.id);
      const originalImages = () =>
        fixture.db((db) =>
          db
            .prepare(
              "SELECT payload_json FROM owner_agent_session_records WHERE agent_id=? AND payload_json LIKE ?",
            )
            .all(agent.id, `%${png}%`),
        );
      const original = originalImages();
      expect(original).toHaveLength(1);
      await fixture.restartControl();
      await fixture.api(`/api/owner/agents/${agent.id}/model`, "PUT", {
        provider: "openai",
        id: "gpt-4",
      });
      const before = fixture.requests.length;
      await fixture.send(agent.channelId, "Continue with the stored result.");
      await eventually(() => fixture.requests[before], "second run request");
      await fixture.completed(agent.id);
      const later = JSON.stringify(fixture.requests.slice(before));
      expect(later).not.toContain(png);
      expect(later).not.toContain("input_image");
      expect(later.includes("图片")).toBe(true);
      if (compact) {
        const summaries = fixture.requests
          .slice(before)
          .filter((request) =>
            JSON.stringify(request.input[0]).includes("context summarization assistant"),
          );
        expect(summaries.length).toBeGreaterThan(0);
        expect(JSON.stringify(summaries).includes("图片 image/png")).toBe(true);
      }
      expect(originalImages()).toEqual(original);
    } finally {
      await fixture.close();
    }
  },
  30000,
);

it("resumes a committed multi-chunk image after a crash without rereading the removed source", async () => {
  let turn = 0;
  const fixture = await loopFixture((_request, response) => {
    respond(
      response,
      turn++ === 0
        ? [{ name: "tools.call", input: { name: "workspace.read", input: { path: "large.png" } } }]
        : "done",
    );
  }, ', afterSessionCommit: async entry => { if (entry.kind === "message" && entry.message.role === "toolResult" && entry.message.content.some(block => block.type === "image")) { console.log("MATE_IMAGE_COMMITTED"); await new Promise(() => {}); } }');
  try {
    const agent = await fixture.agent();
    const bytes = Buffer.alloc(5 * 1024 * 1024);
    Buffer.from(png, "base64").copy(bytes);
    writeFileSync(join(agent.workspace, "large.png"), bytes);
    await fixture.send(agent.channelId, "Read the complete image.");
    await fixture.control.waitFor(/MATE_IMAGE_COMMITTED/, 90000);
    const records = () =>
      fixture.db((db) =>
        db
          .prepare(
            "SELECT payload_json FROM owner_agent_session_records WHERE agent_id=? AND json_extract(payload_json, '$.message.role')='toolResult'",
          )
          .all(agent.id),
      );
    const persisted = records();
    expect(persisted).toHaveLength(1);
    unlinkSync(join(agent.workspace, "large.png"));
    await fixture.restartControl();
    await fixture.completed(agent.id);
    expect(records()).toEqual(persisted);
    const output = fixture.requests
      .at(-1)!
      .input.find((item) => item.type === "function_call_output");
    expect(output?.call_id).toBe("call_0");
    expect(output?.output).toContainEqual(
      expect.objectContaining({
        type: "input_image",
        image_url: `data:image/png;base64,${bytes.toString("base64")}`,
      }),
    );
  } finally {
    await fixture.close();
  }
}, 120000);

it.each(["gpt-4", "gpt-4o-mini"])(
  "gates new image reads and cannot promote arbitrary command JSON for %s",
  async (modelId) => {
    let turn = 0;
    const fixture = await loopFixture((_request, response) => {
      const steps = [
        [{ name: "tools.call", input: { name: "workspace.read", input: { path: "image" } } }],
        [
          {
            name: "tools.call",
            input: {
              name: "process.exec",
              input: {
                command: `printf '%s' '{"content":[{"type":"image","mimeType":"image/png","data":"fake-image-data"}]}'`,
              },
            },
          },
        ],
      ];
      respond(response, steps[turn++] ?? "done");
    });
    try {
      const agent = await fixture.agent("reader", { provider: "openai", id: modelId });
      writeFileSync(join(agent.workspace, "image"), Buffer.from(png, "base64"));
      await fixture.send(agent.channelId, "Read image and command output.");
      await fixture.completed(agent.id);
      const request = JSON.stringify(fixture.requests.at(-1));
      if (modelId === "gpt-4") {
        expect(request).toContain("当前模型不支持图片输入");
        expect(request).not.toContain(png);
        expect(request).not.toContain("input_image");
      } else {
        const imageBlocks = fixture.requests
          .at(-1)!
          .input.flatMap((item) =>
            Array.isArray(item.output)
              ? item.output.filter((block: { type: string }) => block.type === "input_image")
              : [],
          );
        expect(imageBlocks).toHaveLength(1);
        expect(imageBlocks[0].image_url).toBe(`data:image/png;base64,${png}`);
      }
      expect(request).toContain("fake-image-data");
    } finally {
      await fixture.close();
    }
  },
  30000,
);

it("keeps an uploaded image out of a vision request even when the uploader claims text", async () => {
  let attachmentId = "",
    conversationId = "",
    turn = 0;
  const fixture = await loopFixture((_request, response) => {
    respond(
      response,
      turn++ === 0
        ? [
            {
              name: "tools.call",
              input: {
                name: "attachments.read_chunk",
                input: { conversationId, attachmentId, offset: 0 },
              },
            },
          ]
        : "done",
    );
  });
  try {
    const agent = await fixture.agent();
    conversationId = agent.channelId;
    const upload = await fetch(
      new URL(`/api/owner/channels/${conversationId}/attachments`, fixture.origin),
      {
        method: "POST",
        headers: {
          cookie: fixture.cookie,
          "content-type": "text/plain",
          "x-mate-filename": "picture.txt",
        },
        body: Buffer.from(png, "base64"),
      },
    );
    expect(upload.status).toBe(201);
    const uploaded = await upload.json();
    attachmentId = uploaded.attachment.id;
    await fixture.send(conversationId, "Inspect uploaded file.");
    await fixture.completed(agent.id);
    const request = JSON.stringify(fixture.requests.at(-1));
    expect(request).toContain("image/png");
    expect(request).toContain("上传图片或二进制附件不能直接读取");
    expect(request).not.toContain(png);
    expect(request).not.toContain("input_image");
  } finally {
    await fixture.close();
  }
}, 30000);

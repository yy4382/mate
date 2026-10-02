import { createRequire } from "node:module";
import { randomBytes, createPublicKey, verify } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// External protocol fixture, not a control plane or product management daemon.
const [bundle, stateDirectory] = process.argv.slice(2);
if (!bundle || !stateDirectory)
  throw new Error("Fixture requires bundle and private state directory");
const require = createRequire(join(bundle, "app/apps/node/package.json"));
const { WebSocketServer } = require("ws");
const stateFile = join(stateDirectory, "peer.json");
const token = "mate-service-synthetic-valid-token-0000000000";
let identity;
try {
  identity = JSON.parse(readFileSync(stateFile, "utf8"));
} catch {}
const server = new WebSocketServer({ host: "127.0.0.1", port: 18789 });
server.on("listening", () => console.log("MATE_TEST_PEER_READY"));
server.on("connection", (socket) => {
  const nonce = randomBytes(32).toString("base64url");
  socket.send(JSON.stringify({ type: "control.challenge", nonce }));
  socket.on("message", (data) => {
    const request = JSON.parse(data.toString());
    const send = (message) => socket.send(JSON.stringify(message));
    const signed = (key) =>
      verify(
        null,
        Buffer.from(nonce),
        createPublicKey(key),
        Buffer.from(request.signature, "base64url"),
      );
    if (request.type === "node.authenticate") {
      if (identity?.id === request.nodeId && signed(identity.publicKey))
        send({
          type: "control.authenticated",
          requestId: request.requestId,
          nodeId: request.nodeId,
        });
      else
        send({
          type: "control.error",
          requestId: request.requestId,
          code: "unknown_identity",
          message: "Unknown test identity",
        });
    } else if (request.type === "node.pair") {
      if (request.pairingToken !== token || !signed(request.publicKey))
        send({
          type: "control.error",
          requestId: request.requestId,
          code: "pairing_rejected",
          message: "Rejected synthetic test token",
        });
      else {
        identity = { id: request.nodeId, publicKey: request.publicKey };
        writeFileSync(stateFile, JSON.stringify(identity), { mode: 0o600 });
        send({ type: "control.paired", requestId: request.requestId, nodeId: request.nodeId });
      }
    } else if (request.type === "node.ping")
      send({ type: "control.pong", requestId: request.requestId, acceptedAt: Date.now() });
  });
});

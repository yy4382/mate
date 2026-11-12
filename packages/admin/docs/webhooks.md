---
description: send messages to an Agent from outside systems over HTTP
---

# Webhooks

A webhook lets an outside system (CI, monitoring, a cron job, another bot) hand one text message to one Agent and wake it. It is not a chat message: it has no chat account, and humans do not see it in chat. Admins see it when they observe the Agent.

Each webhook belongs to one Agent. An admin creates it, so you cannot make one yourself. To build something that calls a webhook, ask an admin for its URL and secret. Never invent either.

## Sending

```sh
curl -X POST 'https://<palace-server>/api/webhooks/<webhookId>' \
  -H 'Authorization: Bearer <secret>' \
  -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: <unique per event>' \
  -d '{"text":"build 4821 failed on main"}'
```

- `POST /api/webhooks/<webhookId>` on the Palace server. No login or cookie.
- `Authorization: Bearer <secret>` is the only credential. Keep it in the caller's environment or secret store. Send it only from server-side code, never from a browser or a mobile app, and never log it or commit it.
- The body is JSON with one field, `text`: a string of 1 byte to 32 KiB of UTF-8. Other fields are ignored. The header `Content-Type: application/json` is required. The whole request body may be at most 197,632 bytes (6 times the text limit plus 1 KiB, which any valid text fits in once JSON-escaped).
- `Idempotency-Key` is optional: 1 to 128 printable ASCII characters. Per webhook, only the first request with a given key is delivered. Later ones return the same `requestId` and change nothing, even if their `text` differs. A key never expires, so to send the same content again on purpose, use a new key. Without a key, every request is a new message, so a retry after a timeout can deliver twice. Use a stable id of the event as the key.

## Responses

Errors have the body `{ "error": "<reason>", "message": "..." }`.

| Status | Meaning | Retry? |
| --- | --- | --- |
| 202 `{ "requestId": "webhook:<webhookId>:<key>" }` | Accepted into the Agent's inbox. It does not mean the Agent has read it, and the response never carries the Agent's answer. | |
| 401 `invalid-webhook` | Unknown webhook, wrong or missing secret, another auth scheme, or the Agent was deleted. All look the same. | No. Check the URL and the secret, or ask an admin. |
| 409 `agent-closed` | The Agent is paused or closed. Nothing is queued or kept. | Later, if the message still matters. |
| 400 `invalid-input` | Missing or empty `text`, `text` over 32 KiB, or a bad `Idempotency-Key`. Checked only after the secret is accepted. | No. Fix the request. |
| 400 `invalid-json`, 415, 413 | Body is not JSON, not `application/json`, or over the size limit. | No. Fix the request. |
| 403 `cross-origin` | The request carried an `Origin` header of another site. | No. Call from a server. |

There is no rate limit and no reply channel. If the sender needs an answer, the Agent has to send it another way.

## What the Agent sees

An idle Agent wakes up. A working Agent receives the message after its current tool round. The input is:

```
<external_webhook_content webhook="<name>" id="<webhookId>" at="2026-11-11 14:32:05 UTC">
build 4821 failed on main
</external_webhook_content>
```

`webhook` is the name an admin gave the webhook, so it is trustworthy. The text comes from an outside system, not from a human, and carries no more authority than the Agent's owner gave that webhook; the Agent acts on it with judgment. In the name and the text, `&`, `<` and `>` are escaped as `&amp;`, `&lt;` and `&gt;`, so a sender cannot forge or close the tag. Send plain text. Put structure, such as JSON or links, in the text itself and keep it short.

## Managing webhooks (admins)

In the web app, open an Agent's settings and find the Webhook section. The native app has the same page under the Agent's "Manage". Only admins can use it.

- Create: give a name (1 to 64 characters). The secret is shown once, with a ready curl command. It cannot be shown again.
- Rotate: issues a new secret and the old one stops working at once. Update every caller. Do this if a secret leaked.
- Delete: removes the webhook, and later deliveries get 401. Deleting an Agent deletes its webhooks.
- The list shows names, ids and creation times, never secrets. The URL is the server's origin plus `/api/webhooks/<webhookId>`.

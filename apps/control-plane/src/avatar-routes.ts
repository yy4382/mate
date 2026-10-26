import type { ChatApp } from "@mate/chat";
import { forwarded, HttpError } from "./http.ts";
import type { Route } from "./routes.ts";

export function avatarRoutes(chat: ChatApp): Route[] {
  return [
    {
      method: "PUT",
      path: "/api/me/avatar",
      json: ({ human, body }) => chat.setAccountAvatar(human.account, forwarded(body)),
    },
    {
      method: "PUT",
      path: "/api/accounts/:accountId/avatar",
      admin: true,
      json: ({ params, body }) => chat.setAccountAvatar(Number(params.accountId), forwarded(body)),
    },
    {
      method: "GET",
      path: "/api/accounts/:accountId/avatar",
      binary: ({ params, query }) => {
        const avatar = chat.accountAvatar(Number(params.accountId));
        if (avatar === undefined || query.get("v") !== avatar.version)
          throw new HttpError(404, "not-found");
        return {
          bytes: avatar.png,
          contentType: "image/png",
          cacheControl: "private, max-age=31536000, immutable",
        };
      },
    },
  ];
}

import type { ChatApp } from "@mate/chat";
import type { ChatPort } from "@mate/runtime";

/** The chat app as one Agent's account: every method only adds the account. */
export function chatPort(chat: ChatApp, account: number): ChatPort {
  return {
    readUnread: (timeline, request) => chat.readUnread(account, timeline, request),
    readHistory: (timeline, query) => chat.readHistory(account, timeline, query),
    search: (query) => chat.search(account, query),
    send: (timeline, request) => chat.send(account, timeline, request),
    join: (request) => chat.join(account, request),
    leave: (request) => chat.leave(account, request),
    openDm: (request) => chat.openDm(account, request),
    listConversations: () => chat.listConversations(account),
    createTask: (request) => chat.createTask(account, request),
    changeTask: (request) => chat.changeTask(account, request),
  };
}

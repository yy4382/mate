import type { Channel } from "../conversation-responses.js";

type ConversationSidebarProps = {
  channels: Channel[];
  selectedId: string | null;
  error: string | null;
  busy: boolean;
  live: boolean;
  pushReady: boolean;
  pushState: string | null;
  enablePush: () => Promise<void>;
  logout: () => Promise<void>;
  onCreateChannel: () => void;
  onSelectChannel: (id: string) => void;
};

export function ConversationSidebar({
  channels,
  selectedId,
  error,
  busy,
  live,
  pushReady,
  pushState,
  enablePush,
  logout,
  onCreateChannel,
  onSelectChannel,
}: ConversationSidebarProps) {
  return (
    <aside className="channel-sidebar" aria-label="频道列表">
      <div className="sidebar-heading">
        <div>
          <p className="chat-eyebrow">工作空间</p>
          <h1>频道</h1>
        </div>
        <button
          className="icon-button create-channel-button"
          type="button"
          onClick={() => onCreateChannel()}
          aria-label="新建频道"
          title="新建频道"
        >
          <span aria-hidden="true">＋</span>
        </button>
      </div>
      <div className="mobile-owner-actions">
        <button type="button" onClick={() => void enablePush()} disabled={!pushReady}>
          开启通知
        </button>
        <a href="/app/nodes">节点</a>
        <a href="/app/agents">Agent</a>
        {pushState && <span role="status">{pushState}</span>}
      </div>
      {error && (
        <p className="chat-error" role="alert">
          {error}
        </p>
      )}
      <div className="channel-list" role="list">
        {channels.length === 0 ? (
          <div className="empty-list">
            <p>还没有频道</p>
            <span>创建一个频道，开始记录对话。</span>
          </div>
        ) : (
          channels.map((channel) => (
            <div className="channel-list-item" role="listitem" key={channel.id}>
              <button
                className={`channel-row${selectedId === channel.id ? " is-selected" : ""}${channel.archived ? " is-archived" : ""}`}
                type="button"
                onClick={() => {
                  onSelectChannel(channel.id);
                }}
              >
                <span className="channel-symbol" aria-hidden="true">
                  {channel.visibility === "private" ? "◈" : "#"}
                </span>
                <span className="channel-labels">
                  <span className="channel-name">{channel.name}</span>
                  {channel.archived && <span className="archived-label">已归档</span>}
                </span>
                {channel.visibility === "private" && <span className="private-label">私有</span>}
              </button>
            </div>
          ))
        )}
      </div>
      <div className="sidebar-footer">
        <button
          className="text-button"
          type="button"
          onClick={() => void enablePush()}
          disabled={!pushReady}
        >
          开启通知
        </button>
        {pushState && <span role="status">{pushState}</span>}
        <span className={`live-dot${live ? " is-live" : ""}`} aria-hidden="true" />
        <span>{live ? "实时连接正常" : "正在连接…"}</span>
        <a className="text-button owner-nodes-link" href="/app/nodes">
          节点管理
        </a>
        <a className="text-button owner-nodes-link" href="/app/agents">
          Agent 同事
        </a>
        <a className="text-button owner-nodes-link" href="/app/tasks">
          任务看板
        </a>
        <button className="text-button" type="button" onClick={logout} disabled={busy}>
          退出登录
        </button>
      </div>
    </aside>
  );
}

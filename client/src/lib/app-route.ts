/**
 * Deep-link / shareable-URL routing for the app shell.
 *
 * The desktop shell maps `pqp://…` → `/app/…` (see electron/main.js) and the web
 * client uses the same paths directly, so both entry points share this parser.
 *
 *   /app                                → null (default landing)
 *   /app/server/<serverId>              → { kind: "channel", serverId }
 *   /app/server/<sid>/channel/<cid>     → { kind: "channel", serverId, channelId }
 *   /app/server/<sid>/channel/<cid>/message/<mid>
 *                                       → …and highlight that message
 *   /app/dm                             → { kind: "conversation", channelId: null }
 *   /app/dm/<channelId>                 → { kind: "conversation", channelId }
 *   /app/dm/<cid>/message/<mid>         → …and highlight that message
 *   /app/invite/<code>                  → { kind: "invite", code }
 *
 * A conversation is addressed by channel id alone. It has no server to scope it
 * with, which is exactly why it needs a form of its own: `/app/server/<sid>/…`
 * cannot name it, and there is no id to put in place of `<sid>`.
 */

export type AppRouteTarget =
  | {
      kind: "channel";
      serverId: string;
      channelId: string | null;
      messageId: string | null;
    }
  | {
      kind: "conversation";
      /** Null for the conversation list with nothing open in it. */
      channelId: string | null;
      messageId: string | null;
    }
  | { kind: "invite"; code: string };

export function parseAppRoute(pathname: string): AppRouteTarget | null {
  const segments = pathname.replace(/^\/+|\/+$/g, "").split("/");
  if (segments[0] !== "app") {
    return null;
  }

  const [, section, first, nested, second, deeper, third] = segments;

  if (section === "invite" && first) {
    return { kind: "invite", code: decodeURIComponent(first) };
  }

  if (section === "dm") {
    const channelId = first ? decodeURIComponent(first) : null;
    return {
      kind: "conversation",
      channelId,
      messageId:
        channelId && nested === "message" && second
          ? decodeURIComponent(second)
          : null,
    };
  }

  if (section === "server" && first) {
    const channelId =
      nested === "channel" && second ? decodeURIComponent(second) : null;
    return {
      kind: "channel",
      serverId: decodeURIComponent(first),
      channelId,
      messageId:
        channelId && deeper === "message" && third
          ? decodeURIComponent(third)
          : null,
    };
  }

  return null;
}

/** Inverse of {@link parseAppRoute} for the channel case. */
export function channelRoutePath(
  serverId: string,
  channelId?: string | null,
): string {
  const base = `/app/server/${encodeURIComponent(serverId)}`;
  return channelId ? `${base}/channel/${encodeURIComponent(channelId)}` : base;
}

/** Inverse of {@link parseAppRoute} for the conversation case. */
export function conversationRoutePath(channelId?: string | null): string {
  return channelId ? `/app/dm/${encodeURIComponent(channelId)}` : "/app/dm";
}

/**
 * Permalink to one message. Carries the server id as well as the channel id:
 * without it the recipient has no way to load the channel, which is why the
 * `/app/channel/…` form this replaced resolved to nothing.
 *
 * A null `serverId` means a conversation, which is already addressable by its
 * channel id alone. Nullable rather than a second function so no caller has to
 * ask which kind of channel it is holding before it can link to a message in it.
 */
export function messageRoutePath(
  serverId: string | null,
  channelId: string,
  messageId: string,
): string {
  const base = serverId
    ? channelRoutePath(serverId, channelId)
    : conversationRoutePath(channelId);
  return `${base}/message/${encodeURIComponent(messageId)}`;
}

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
 *   /app/invite/<code>                  → { kind: "invite", code }
 */

export type AppRouteTarget =
  | {
      kind: "channel";
      serverId: string;
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

/**
 * Permalink to one message. Carries the server id as well as the channel id:
 * without it the recipient has no way to load the channel, which is why the
 * `/app/channel/…` form this replaced resolved to nothing.
 */
export function messageRoutePath(
  serverId: string,
  channelId: string,
  messageId: string,
): string {
  return `${channelRoutePath(serverId, channelId)}/message/${encodeURIComponent(messageId)}`;
}

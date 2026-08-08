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

/**
 * Where Clerk should drop somebody after they sign in or sign up, given the
 * `/app/…` URL they were trying to reach.
 *
 * THIS FIXES A LOST INVITE, which is the worst bug in the product's growth path.
 * The signed-out gate used to hand Clerk a hardcoded `/app`. So the one journey
 * that brings new people in — a friend sends `pqp.gg/app/invite/<code>`, they
 * click it, they have no account — ran: gate → Clerk sign-up → `/app`. The code
 * was in the URL and the URL was thrown away, so the new account arrived at the
 * emptiest screen in the app with no memory of why it came, and the friend who
 * sent the link had to be asked to send it again. Every invite to somebody who
 * was not already a user died here.
 *
 * Returning the path unchanged is the whole fix; it is a function rather than an
 * inline expression so that "does an invite survive sign-up" is a unit test
 * instead of something only a hosted Clerk round-trip can answer.
 *
 * Only ever returns a path under `/app`. It is interpolated into an auth
 * redirect, and a redirect target taken from the address bar is exactly the
 * shape an open-redirect wants to be — so anything that is not an `/app` path
 * this build recognises falls back to `/app` rather than being echoed back.
 * `parseAppRoute` returning non-null is that recognition: it means the string
 * matched one of the known route forms and nothing else got through.
 */
export function signedOutRedirectPath(pathname: string): string {
  const target = parseAppRoute(pathname);
  if (!target) {
    // `/app` itself parses to null, and so does anything unrecognised. Both
    // want the same answer, and it is the one that was always used.
    return "/app";
  }
  if (target.kind === "invite") {
    return `/app/invite/${encodeURIComponent(target.code)}`;
  }
  // Both remaining kinds can carry a message permalink, and that is the form
  // people actually paste at each other — dropping the message id here would
  // land them in the right channel at the wrong end of the scrollback.
  if (target.kind === "conversation") {
    return target.channelId && target.messageId
      ? messageRoutePath(null, target.channelId, target.messageId)
      : conversationRoutePath(target.channelId);
  }
  return target.channelId && target.messageId
    ? messageRoutePath(target.serverId, target.channelId, target.messageId)
    : channelRoutePath(target.serverId, target.channelId);
}

import {
  bauPostPath,
  customEmojiTokensAsText,
  FORWARD_DESTINATION_THREADS_MAX,
  FORWARD_EXCERPT_MAX,
  FORWARD_VERSION,
  forwardFallbackBody,
  forwardMessagePath,
  hasPermission,
  messageForwardSchema,
  MESSAGE_MAX_LENGTH,
  Permission,
  type CreateForwardRequest,
  type ForwardDestinations,
  type ForwardMediaKind,
  type ForwardRefusalReason,
  type ForwardResult,
  type ForwardTarget,
  type MessageForward,
} from "@pqp/shared";
import type { DbUser } from "../db.js";
import { getPool } from "../db.js";
import { isEnabled } from "../lib/flags.js";
import { postChannelMessage, takeMessageBudget } from "../ws/chat.js";
import {
  CommunityHomeError,
  getCommunityHomePost,
  isCommunityHomeEnabled,
} from "./community-home.js";
import { coverPath } from "./community-home-public.js";
import { DmRefusedError, openConversation } from "./dms.js";
import { findMessageByNonce, mapMessage } from "./messages.js";
import { computeMemberPermissionsForChannels } from "./permissions.js";
import { getChannel, listChannels } from "./servers.js";
import { listActiveThreadsByParent } from "./threads.js";
import { canAccessChannel, getMemberRole } from "./users.js";

/**
 * ENCAMINHAR. The contract is `packages/shared/src/forward.ts`; this is the
 * rule set behind `POST /api/forwards`.
 *
 * THE FLAG IS CHECKED PER REQUEST, not at boot: `forward_messages` off is a
 * 404, the same answer as a route that does not exist, so a stale client's
 * button fails closed. Cards already stored keep rendering (the flag gates
 * creation, never reads).
 *
 * A FORWARD GOES THROUGH THE CHAT'S OWN SEND (`postChannelMessage`), once per
 * target, so access, SEND_MESSAGES, blocks, slow mode, AutoMod, the closed-1:1
 * restore, mentions, unread, push and the broadcast are the chat's, not a
 * copy. Two things differ on purpose: nothing a snapshot says can mention
 * anybody (`@everyone` / `@here` never fire, names are read from the
 * forwarder's comment alone), and the fallback body is not unfurled.
 *
 * WHAT MAY LEAVE ITS SERVER. The forwarder must be able to read the source.
 * A members-only (VIP) Baú post and a message in a private channel are
 * `restricted`: they can only be forwarded into the SAME server, never into
 * another server or a conversation, and a restricted post's snapshot carries
 * only what the feed shows a locked reader (title, teaser, a public YouTube
 * poster), never the body, the media or the author, even when the forwarder
 * could unlock the post, because the card is read by people who cannot. A
 * conversation message (DM or group) is never a source: it belongs to the two
 * of you, not to the person who happens to read it.
 */

/** A refusal of the whole request: the HTTP status and a machine-readable message. */
export class ForwardError extends Error {
  constructor(
    readonly status: 404 | 422,
    message: string,
  ) {
    super(message);
    this.name = "ForwardError";
  }
}

/** Channel types whose chat takes a message: text, a voice room's chat, a watch party's. */
const FORWARD_CHANNEL_TYPES = new Set(["text", "voice", "watch_party"]);

/**
 * The channels of one server this person may forward into, for the picker, in
 * one pass. `listChannels` is the visibility answer (private channels and
 * overwrites already folded in); SEND_MESSAGES is resolved for the whole list
 * at once with the rule the send applies, so a listed channel is one the send
 * will not refuse for permission. The caller has already proved membership.
 */
export async function listForwardDestinations(
  serverId: string,
  userId: string,
): Promise<ForwardDestinations> {
  const channels = (await listChannels(serverId, userId)).filter(
    (channel) => channel.kind === "server" && FORWARD_CHANNEL_TYPES.has(channel.type),
  );
  // One membership read and one overwrite read for the whole list, not three
  // queries per channel; `computeMemberPermissionsForChannels` gives the same
  // bits `computeMemberPermissions` (the send's own call) would.
  const bits = await computeMemberPermissionsForChannels(serverId, userId, channels);
  const canSend = (map: Map<string, bigint>, id: string) =>
    hasPermission(map.get(id) ?? 0n, Permission.SEND_MESSAGES);
  const sendable = channels.filter((channel) => canSend(bits, channel.id));
  return {
    channels: sendable.map((channel) => ({
      id: channel.id,
      name: channel.name,
      type: channel.type as "text" | "voice" | "watch_party",
    })),
    threads: await listForwardThreads(serverId, userId, sendable),
  };
}

/** Threads a person is in, per text channel: enough to fill the picker, not the whole server. */
const FORWARD_THREADS_PER_CHANNEL = 5;

/**
 * The active threads this person is in (`listActiveThreadsByParent`: the set
 * their channel list nests, archived ones already left out in SQL), most
 * recently active first, capped for the picker, that they may post in.
 *
 * Only text channels the person can SPEAK in are asked about, so the caps
 * (five per channel, thirty in all) count threads that can be offered and a
 * read-only channel's busy threads never crowd out the rest. A thread has no
 * overwrites of its own, it answers with its parent's, so that is also the
 * thread's answer; it is still asked of the thread (the id the send asks about,
 * resolved through its parent) before it is listed, which costs one more
 * membership read and one more overwrite read, and keeps this list and the send
 * from ever disagreeing.
 */
async function listForwardThreads(
  serverId: string,
  userId: string,
  speakableChannels: readonly { id: string; name: string; type: string }[],
): Promise<ForwardDestinations["threads"]> {
  const parents = speakableChannels.filter((channel) => channel.type === "text");
  if (parents.length === 0) {
    return [];
  }
  const byParent = await listActiveThreadsByParent(
    serverId,
    parents.map((channel) => channel.id),
    FORWARD_THREADS_PER_CHANNEL,
    userId,
  );
  const recent = [...byParent.values()]
    .flat()
    .sort((a, b) => b.lastActivityAt.localeCompare(a.lastActivityAt))
    .slice(0, FORWARD_DESTINATION_THREADS_MAX);
  if (recent.length === 0) {
    return [];
  }
  const bits = await computeMemberPermissionsForChannels(
    serverId,
    userId,
    recent.map((thread) => ({
      id: thread.channelId,
      type: "thread",
      parent_id: thread.parentChannelId,
    })),
  );
  const parentName = new Map(parents.map((channel) => [channel.id, channel.name]));
  return recent
    .filter((thread) => hasPermission(bits.get(thread.channelId) ?? 0n, Permission.SEND_MESSAGES))
    .map((thread) => ({
      id: thread.channelId,
      name: thread.name,
      parentId: thread.parentChannelId,
      parentName: parentName.get(thread.parentChannelId) ?? "",
    }));
}

export function forwardMessagesEnabled(): boolean {
  return isEnabled("forward_messages");
}

/** Plain text for a card: markdown noise out, whitespace collapsed, cut to the contract. */
export function forwardExcerpt(text: string | null | undefined): string {
  if (!text) {
    return "";
  }
  const plain = customEmojiTokensAsText(text)
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/[*~`]+/g, "")
    .replace(/^\s*(?:>|#{1,6})\s+/gm, "")
    .replace(/\s+/g, " ")
    .trim();
  // The schema's `.max(500)` counts UTF-16 units, which is what every client
  // can count too, so the cut is made in the same unit. 251 emoji are 502
  // units and must be cut even though they are 251 characters.
  if (plain.length <= FORWARD_EXCERPT_MAX) {
    return plain;
  }
  let cut = plain.slice(0, FORWARD_EXCERPT_MAX - 3);
  // Never end on half a surrogate pair.
  const last = cut.charCodeAt(cut.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) {
    cut = cut.slice(0, -1);
  }
  const lastSpace = cut.lastIndexOf(" ");
  const base = lastSpace > FORWARD_EXCERPT_MAX * 0.6 ? cut.slice(0, lastSpace) : cut;
  return `${base.replace(/[\s.,;:!?-]+$/, "")}...`;
}

/** The one thumbnail a snapshot may hold: a YouTube poster, public and stable. */
export function isStableYoutubePoster(url: string | null | undefined): url is string {
  return (
    typeof url === "string" &&
    /^https:\/\/i\.ytimg\.com\/vi\/[\w-]{6,20}\/[\w]+\.jpg$/.test(url)
  );
}

/** A resolved source: the snapshot to store and where it may go. */
export interface ResolvedForwardSource {
  snapshot: MessageForward;
  /**
   * Set when the source may only be forwarded inside one server (members-only
   * post, private channel). Null when it may go anywhere the forwarder can send.
   */
  stayInServerId: string | null;
}

interface PostServerRow {
  name: string;
  icon_url: string | null;
  community_home_enabled: boolean | null;
  community_slug: string | null;
}

async function resolveBauPostSource(
  user: DbUser,
  serverId: string,
  postId: string,
  origin: string,
): Promise<ResolvedForwardSource> {
  if (!isCommunityHomeEnabled()) {
    throw new ForwardError(404, "Not found");
  }
  // A non-member cannot tell a post from a server that does not exist.
  if (!(await getMemberRole(serverId, user.id))) {
    throw new ForwardError(404, "Not found");
  }
  const server = await getPool().query<PostServerRow>(
    `SELECT name, icon_url, community_home_enabled, community_slug FROM servers WHERE id = $1`,
    [serverId],
  );
  const serverRow = server.rows[0];
  if (!serverRow || serverRow.community_home_enabled !== true) {
    throw new ForwardError(404, "Not found");
  }
  let post;
  try {
    post = await getCommunityHomePost(serverId, postId, user.id);
  } catch (error) {
    if (error instanceof CommunityHomeError) {
      throw new ForwardError(404, "Not found");
    }
    throw error;
  }
  // A draft or a scheduled post is not published yet, even to the staff who can open it.
  if (post.status !== "published") {
    throw new ForwardError(404, "Not found");
  }
  const restricted = post.visibility === "members";

  // A restricted post is drawn as the feed draws it to a reader who cannot
  // unlock it, whoever forwards it: the card is read by people who may not
  // be able to. Free posts get the body.
  const excerpt = restricted
    ? forwardExcerpt(post.teaser)
    : forwardExcerpt(post.teaser?.trim() || post.body);
  let mediaKind: ForwardMediaKind | undefined;
  let mediaThumbUrl: string | null | undefined;
  // A YouTube poster is stable and public; every other media url is a signed
  // GET that expires, and a snapshot must not store one (the public cover
  // route below is the one other thumbnail, and it is not signed). A locked
  // reader gets the poster too, so a restricted post may.
  if (
    isStableYoutubePoster(post.posterUrl) &&
    (post.media?.kind === "youtube" || (restricted && post.hasMedia))
  ) {
    mediaKind = "youtube";
    mediaThumbUrl = post.posterUrl;
  }
  if (!restricted && post.media) {
    switch (post.media.kind) {
      case "image":
        mediaKind = "image";
        break;
      case "video":
        mediaKind = "video";
        break;
      case "youtube":
        mediaKind = "youtube";
        break;
      case "twitch":
      case "tiktok":
      case "instagram":
        mediaKind = "embed";
        break;
      default:
        break;
    }
  }
  // A post with a PUBLIC PAGE has a public picture: the page's own cover
  // route, which answers anybody with no signature, and which re-proves on
  // every request that the post is still published, free and on a public
  // address (a post that stops qualifying 404s, and the URL stored here goes
  // dark with it). `publicUrl` is `bauPublicUrlFor`, the one definition of
  // "has a public page", and a cover exists exactly when the feed's own media
  // carries a signed picture (`buildMedia`, the function the route calls too:
  // an uploaded image, or a video's chosen cover), so this reads what the
  // loaded post already says instead of asking the database again, and has
  // no lookup that can fail. No page (a members-only post, the flag off, no
  // address) means no thumbnail, exactly as before. Root-relative, like the
  // server icon: the server does not know its own public origin, and every
  // client resolves it against the API's.
  if (
    !mediaThumbUrl &&
    !restricted &&
    post.publicUrl &&
    serverRow.community_slug &&
    ((post.media?.kind === "image" && post.media.url) ||
      (post.media?.kind === "video" && post.media.posterUrl))
  ) {
    mediaThumbUrl = coverPath(serverRow.community_slug, post.id);
  }
  const title = post.title?.trim();
  const snapshot: MessageForward = {
    v: FORWARD_VERSION,
    kind: "bau_post",
    sourceServerId: serverId,
    sourceServerName: serverRow.name,
    sourceServerIconUrl: serverRow.icon_url,
    sourceId: post.id,
    ...(!restricted && post.author.displayName
      ? { authorDisplayName: post.author.displayName }
      : {}),
    ...(title ? { title } : {}),
    excerpt,
    ...(mediaThumbUrl ? { mediaThumbUrl } : {}),
    ...(mediaKind ? { mediaKind } : {}),
    url: `${origin}${bauPostPath(serverId, post.id)}`,
    createdAt: post.publishedAt ?? post.createdAt,
    ...(restricted ? { restricted: true, restrictedToServerId: serverId } : {}),
  };
  if (!snapshot.title && !snapshot.excerpt && !snapshot.mediaKind) {
    throw new ForwardError(422, "source_empty");
  }
  return { snapshot, stayInServerId: restricted ? serverId : null };
}

interface MessageSourceRow {
  id: string;
  channel_id: string;
  body: string;
  created_at: Date;
  system_kind: string | null;
  forward: unknown;
  webhook_username: string | null;
  server_id: string | null;
  channel_name: string;
  channel_kind: "server" | "dm" | "group";
  is_private: boolean;
  parent_is_private: boolean | null;
  server_name: string | null;
  server_icon_url: string | null;
  author_name: string | null;
  attachment_type: string | null;
}

async function resolveMessageSource(
  user: DbUser,
  messageId: string,
  origin: string,
): Promise<ResolvedForwardSource> {
  const result = await getPool().query<MessageSourceRow>(
    `SELECT m.id, m.channel_id, m.body, m.created_at, m.system_kind, m.forward,
            m.webhook_username,
            c.server_id, c.name AS channel_name, c.kind AS channel_kind,
            c.is_private, pc.is_private AS parent_is_private,
            s.name AS server_name, s.icon_url AS server_icon_url,
            COALESCE(NULLIF(sm.nickname, ''), u.display_name) AS author_name,
            (SELECT a.content_type
               FROM message_attachments a
              WHERE a.message_id = m.id
                AND (a.content_type LIKE 'image/%' OR a.content_type LIKE 'video/%')
              ORDER BY a.position, a.created_at
              LIMIT 1) AS attachment_type
       FROM messages m
       JOIN channels c ON c.id = m.channel_id
       LEFT JOIN channels pc ON pc.id = c.parent_id
       LEFT JOIN servers s ON s.id = c.server_id
       JOIN users u ON u.id = m.author_id
       LEFT JOIN server_members sm
         ON sm.server_id = c.server_id AND sm.user_id = m.author_id
      WHERE m.id = $1`,
    [messageId],
  );
  const row = result.rows[0];
  // Missing and unreadable are one answer: an id must not be probeable.
  if (!row || !(await canAccessChannel(row.channel_id, user.id))) {
    throw new ForwardError(404, "Not found");
  }
  // A conversation is private to its people, and a forward needs a server to
  // say where it came from. A nudge is the server's sentence, not a message.
  if (row.channel_kind !== "server" || !row.server_id || row.system_kind) {
    throw new ForwardError(422, "source_not_forwardable");
  }
  const inPrivate = row.is_private || row.parent_is_private === true;

  // A forward of a forward carries the ORIGINAL snapshot on, so a chain of
  // forwards keeps pointing at the first source, and keeps its restriction.
  const earlier = messageForwardSchema.safeParse(row.forward);
  if (earlier.success) {
    const restricted = earlier.data.restricted === true || inPrivate;
    // The one server a restricted card may travel inside. A private channel
    // pins it to that channel's server (which can differ from the card's
    // `sourceServerId`); a card already restricted keeps the server it was
    // restricted to, and a restricted card that predates the field falls back
    // to its source server. The same answer goes on the snapshot, so a client
    // and this server never disagree about the boundary.
    const boundary = inPrivate
      ? row.server_id
      : (earlier.data.restrictedToServerId ?? earlier.data.sourceServerId);
    return {
      // Stamped, so a copy made from THIS message in a public channel is
      // still known to be restricted, and to which server.
      snapshot: restricted
        ? { ...earlier.data, restricted: true, restrictedToServerId: boundary }
        : earlier.data,
      stayInServerId: restricted ? boundary : null,
    };
  }

  const excerpt = forwardExcerpt(row.body);
  const mediaKind: ForwardMediaKind | undefined = row.attachment_type?.startsWith(
    "video/",
  )
    ? "video"
    : row.attachment_type
      ? "image"
      : undefined;
  if (!excerpt && !mediaKind) {
    throw new ForwardError(422, "source_empty");
  }
  const snapshot: MessageForward = {
    v: FORWARD_VERSION,
    kind: "message",
    sourceServerId: row.server_id,
    sourceServerName: row.server_name ?? "",
    sourceServerIconUrl: row.server_icon_url,
    sourceChannelName: row.channel_name,
    sourceId: row.id,
    ...(row.webhook_username || row.author_name
      ? { authorDisplayName: row.webhook_username ?? row.author_name ?? undefined }
      : {}),
    excerpt,
    ...(mediaKind ? { mediaKind } : {}),
    url: `${origin}${forwardMessagePath(row.server_id, row.channel_id, row.id)}`,
    createdAt: row.created_at.toISOString(),
    ...(inPrivate ? { restricted: true, restrictedToServerId: row.server_id } : {}),
  };
  return { snapshot, stayInServerId: inPrivate ? row.server_id : null };
}

export async function resolveForwardSource(
  user: DbUser,
  source: CreateForwardRequest["source"],
  origin: string,
): Promise<ResolvedForwardSource> {
  const resolved =
    source.kind === "bau_post"
      ? await resolveBauPostSource(user, source.serverId!, source.id, origin)
      : await resolveMessageSource(user, source.id, origin);
  return { ...resolved, snapshot: await defangSnapshot(resolved.snapshot) };
}

/**
 * THE ORIGIN OF A CARD'S URL. The deployment's own public address
 * (`PUBLIC_APP_URL`, the first entry), never the request's Origin header: that
 * header is whatever the caller's browser or script sent, and the URL is
 * stored on the message for everybody. Unset, production falls back to the
 * hosted address and development to the local Vite server, so a card is
 * always a link that opens somewhere sensible.
 */
export function forwardAppOrigin(): string {
  const configured = (process.env.PUBLIC_APP_URL ?? "")
    .split(",")
    .map((value) => value.trim().replace(/\/$/, ""))
    .find(Boolean);
  if (configured) {
    try {
      const url = new URL(configured);
      if (url.protocol === "https:" || url.protocol === "http:") {
        return url.origin;
      }
    } catch {
      // fall through to the default
    }
  }
  return process.env.NODE_ENV === "production"
    ? "https://pqp.gg"
    : "http://localhost:5173";
}

// ------------------------------------------------------------- no pings

// Any `<@..>`, `<@!..>`, `<@&..>`, `<#..>` token. Only a well-formed id is looked
// up; a malformed one (`<@123>`) is an unknown name, never leftover text.
const MARKUP = /<(@&|@!|@|#)([^<>\s]*)>/g;
const UUID = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

/**
 * A name (a display name, a server or channel name) made of readable text
 * only: every markup token is dropped whole, with its id, and stray angle
 * brackets go with it. What is left is what a person would read.
 */
function stripMarkup(name: string): string {
  return name.replace(MARKUP, "").replace(/[<>]/g, "").replace(/\s+/g, " ").trim();
}
const ZERO_WIDTH_SPACE = "\u200B";

/**
 * Mention markup (`<@id>`, `<@&id>`, `<#id>`) as the plain words a person
 * reads: `@Nome`, `@cargo`, `#canal`. Looked up here, once, so no client has
 * to know the markup and none can show it raw. A name that cannot be found
 * (gone, or a private channel whose name must not travel to another server)
 * is a neutral `@unknown` / `#unknown`.
 */
async function plainMarkup(texts: readonly string[]): Promise<Map<string, string>> {
  const users = new Set<string>();
  const roles = new Set<string>();
  const channels = new Set<string>();
  for (const text of texts) {
    for (const match of text.matchAll(MARKUP)) {
      const id = match[2]!.toLowerCase();
      if (!UUID.test(id)) {
        continue;
      }
      (match[1] === "#" ? channels : match[1] === "@&" ? roles : users).add(id);
    }
  }
  const lookup = (sql: string, ids: Set<string>) =>
    ids.size === 0
      ? Promise.resolve({ rows: [] as { id: string; name: string }[] })
      : getPool().query<{ id: string; name: string }>(sql, [[...ids]]);
  // One round trip each, all at once: the three tables do not depend on each other.
  const [userRows, roleRows, channelRows] = await Promise.all([
    lookup(`SELECT id::text, display_name AS name FROM users WHERE id = ANY($1::uuid[])`, users),
    lookup(`SELECT id::text, name FROM roles WHERE id = ANY($1::uuid[])`, roles),
    lookup(
      `SELECT id::text, name FROM channels
        WHERE id = ANY($1::uuid[]) AND kind = 'server' AND is_private = FALSE`,
      channels,
    ),
  ]);
  const names = new Map<string, string>();
  for (const row of userRows.rows) {
    names.set(`@${row.id}`, row.name);
  }
  for (const row of roleRows.rows) {
    names.set(`@&${row.id}`, row.name);
  }
  for (const row of channelRows.rows) {
    names.set(`#${row.id}`, row.name);
  }
  return names;
}

/**
 * Text that can never be read as a mention by any client. A client finds
 * mentions by scanning a message body for `@name`, and the body of a forward
 * with no comment is a line built from the snapshot, so the snapshot itself
 * has to be inert: markup becomes plain words, and every `@` that would start
 * a name gets an invisible zero-width space after it, which no mention
 * pattern matches and no reader sees. The same text is what the card shows.
 */
export function defangMentionText(
  text: string,
  names: ReadonlyMap<string, string>,
): string {
  const plain = text.replace(MARKUP, (_all, kind: string, id: string) => {
    const prefix = kind === "#" ? "#" : kind === "@&" ? "@&" : "@";
    // A name is somebody's text too: one that itself contains markup (a display
    // name of "<@id> @&id") loses every token whole, ids included, and keeps
    // only the readable text. The `@` pass below covers any `@word` left in it.
    const found = names.get(`${prefix}${id.toLowerCase()}`);
    // Leading `@` / `#` of the name go too, so the one the markup stands for
    // is the only one: "@@name" never reaches the card.
    const name = found === undefined ? "" : stripMarkup(found).replace(/^[@#]+/, "");
    if (name) {
      return kind === "#" ? `#${name}` : `@${name}`;
    }
    return kind === "#" ? "#unknown" : "@unknown";
  });
  // A complete pass over the FINAL text, names included: any markup that is
  // still there (a resolved name that carried `<@&id>`, `<@!id>`, `<#id>`) loses
  // its opening bracket, and every `@word` (`@everyone`, `@here`, a username)
  // gets the zero-width space.
  return plain
    .replace(/<(?=@|#)/g, "")
    .replace(/@(?=[A-Za-z0-9_])/g, `@${ZERO_WIDTH_SPACE}`);
}

/** Cut to the schema's unit (UTF-16), never inside a surrogate pair. */
function clampExcerpt(text: string): string {
  if (text.length <= FORWARD_EXCERPT_MAX) {
    return text;
  }
  let cut = text.slice(0, FORWARD_EXCERPT_MAX - 3);
  const last = cut.charCodeAt(cut.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) {
    cut = cut.slice(0, -1);
  }
  return `${cut.trimEnd()}...`;
}

/** Every text of a snapshot made inert (see `defangMentionText`). */
export async function defangSnapshot(snapshot: MessageForward): Promise<MessageForward> {
  const fields = [snapshot.title, snapshot.excerpt].filter(
    (value): value is string => typeof value === "string",
  );
  const names = await plainMarkup(fields);
  const clean = (value: string) => defangMentionText(value, names);
  // Names are plain labels: markup inside one is dropped whole, not resolved.
  const label = (value: string) => defangMentionText(stripMarkup(value), new Map());
  return {
    ...snapshot,
    sourceServerName: label(snapshot.sourceServerName),
    ...(snapshot.sourceChannelName !== undefined
      ? { sourceChannelName: label(snapshot.sourceChannelName) }
      : {}),
    ...(snapshot.authorDisplayName !== undefined
      ? { authorDisplayName: label(snapshot.authorDisplayName) }
      : {}),
    ...(snapshot.title !== undefined ? { title: clean(snapshot.title) } : {}),
    excerpt: clampExcerpt(clean(snapshot.excerpt)),
  };
}

/** Targets with duplicates dropped, first occurrence kept. */
export function dedupeForwardTargets(targets: ForwardTarget[]): ForwardTarget[] {
  const seen = new Set<string>();
  const kept: ForwardTarget[] = [];
  for (const target of targets) {
    const key = "channelId" in target ? `c:${target.channelId}` : `u:${target.userId}`;
    if (!seen.has(key)) {
      seen.add(key);
      kept.push(target);
    }
  }
  return kept;
}

type Refusal = { ok: false; reason: ForwardRefusalReason; retryAfterMs?: number };

/** Where a target resolves to, or why it may not receive this forward. */
async function resolveTarget(
  user: DbUser,
  target: ForwardTarget,
  stayInServerId: string | null,
): Promise<{ ok: true; channelId: string; serverId: string | null } | Refusal> {
  if ("userId" in target) {
    // A person is a conversation: never for a restricted source, and decided
    // before the conversation is opened so a refusal creates nothing.
    if (stayInServerId) {
      return { ok: false, reason: "stays_in_server" };
    }
    try {
      const opened = await openConversation(user.id, [target.userId]);
      return { ok: true, channelId: opened.channelId, serverId: null };
    } catch (error) {
      if (error instanceof DmRefusedError) {
        // Blocked, private, self, unknown: one answer, so this is no oracle.
        return { ok: false, reason: "unreachable" };
      }
      throw error;
    }
  }
  const channel = await getChannel(target.channelId);
  if (!channel || !(await canAccessChannel(channel.id, user.id))) {
    return { ok: false, reason: "no_access" };
  }
  if (channel.kind === "server" && (channel.type === "category" || channel.type === "forum")) {
    return { ok: false, reason: "bad_target" };
  }
  if (stayInServerId && channel.server_id !== stayInServerId) {
    return { ok: false, reason: "stays_in_server" };
  }
  return { ok: true, channelId: channel.id, serverId: channel.server_id };
}

/** The message body: the forwarder's comment, or the fallback an old client shows. */
export function forwardBody(comment: string | undefined, snapshot: MessageForward): string {
  const own = comment?.trim() ?? "";
  const body = own || forwardFallbackBody(snapshot);
  return body.length > MESSAGE_MAX_LENGTH ? body.slice(0, MESSAGE_MAX_LENGTH) : body;
}

/**
 * One message per target, each through the chat's send, in parallel (at most
 * five). A target that fails, even by throwing, does not stop the others; the
 * answer says which did what, in request order.
 */
export async function forwardToTargets(input: {
  user: DbUser;
  resolved: ResolvedForwardSource;
  targets: ForwardTarget[];
  comment?: string;
  nonce?: string;
}): Promise<ForwardResult[]> {
  const comment = input.comment?.trim() ?? "";
  const body = forwardBody(comment, input.resolved.snapshot);
  const targets = dedupeForwardTargets(input.targets);
  return Promise.all(
    targets.map((target) => forwardToOne(input, target, comment, body)),
  );
}

async function forwardToOne(
  input: {
    user: DbUser;
    resolved: ResolvedForwardSource;
    nonce?: string;
  },
  target: ForwardTarget,
  comment: string,
  body: string,
): Promise<ForwardResult> {
  let channelId: string | null = null;
  try {
    const resolved = await resolveTarget(
      input.user,
      target,
      input.resolved.stayInServerId,
    );
    if (!resolved.ok) {
      return { ok: false, target, reason: resolved.reason };
    }
    channelId = resolved.channelId;
    const done = (message: unknown): ForwardResult => ({
      ok: true,
      target,
      channelId: resolved.channelId,
      serverId: resolved.serverId,
      message,
    });

    // A retry of a request whose answer was lost: what already went out is
    // handed back BEFORE the budget is charged, so a retry is never refused
    // for sends it does not make.
    if (input.nonce) {
      const existing = await findMessageByNonce(
        resolved.channelId,
        input.user.id,
        input.nonce,
      );
      if (existing) {
        return done(mapMessage(existing));
      }
    }
    // The chat's own send budget, charged per message so a forward to five
    // places costs what five sends cost.
    const budget = takeMessageBudget(input.user.id);
    if (!budget.ok) {
      return {
        ok: false,
        target,
        reason: "rate_limited",
        retryAfterMs: Math.ceil(budget.retryAfterMs),
      };
    }
    const posted = await postChannelMessage({
      author: input.user,
      channelId: resolved.channelId,
      body,
      forward: { snapshot: input.resolved.snapshot, comment },
      ...(input.nonce ? { nonce: input.nonce } : {}),
    });
    if (posted.ok) {
      return done(posted.message);
    }
    return {
      ok: false,
      target,
      reason: refusalFor(posted.reason),
      ...(posted.retryAfterMs && posted.retryAfterMs > 0
        ? { retryAfterMs: Math.ceil(posted.retryAfterMs) }
        : {}),
    };
  } catch (error) {
    // A dependency failed (the database). One target's failure is that
    // target's answer, never the request's: the others may already be sent.
    console.error("[forwards] target failed:", error);
    // The send may have committed before the throw: the nonce says. A row
    // that is stored IS the forward (history and every later reader show it),
    // and what a throw after the commit can have missed is live fan-out, which
    // a viewer's next history read repairs. A retry would find the same row
    // and answer the same way, so reporting it as sent is what is true.
    if (input.nonce && channelId) {
      try {
        const existing = await findMessageByNonce(channelId, input.user.id, input.nonce);
        if (existing) {
          const serverId = (await getChannel(channelId))?.server_id ?? null;
          return {
            ok: true,
            target,
            channelId,
            serverId,
            message: mapMessage(existing),
          };
        }
      } catch {
        // Fall through to unavailable.
      }
    }
    return { ok: false, target, reason: "unavailable" };
  }
}

function refusalFor(reason: string): ForwardRefusalReason {
  switch (reason) {
    case "no-access":
      return "no_access";
    case "cannot-send":
    case "locked":
      return "cannot_send";
    case "undeliverable":
      return "unreachable";
    case "slow-mode":
      return "slow_mode";
    case "rate-limited":
      return "rate_limited";
    case "automod":
      return "automod";
    default:
      return "unavailable";
  }
}

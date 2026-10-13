import {
  type BotActionItem,
  createChannelSchema,
  hasPermission,
  isPollClosed,
  POLL_DURATION_SECONDS,
  POLL_MAX_OPTIONS,
  POLL_OPTION_MAX_LENGTH,
  pollRequestSchema,
  moveChannelSchema,
  Permission,
  updateChannelSchema,
} from "@pqp/shared";
import { getPool, type DbUser } from "../db.js";
import { logEvent } from "../lib/log.js";
import { runWithBotRequester } from "./audit.js";
import { bumpBotStats, bumpBotTool } from "./bot-stats.js";
import type { BotToolSpec } from "./bot-llm.js";
import type { PollRequest } from "@pqp/shared";
import { forumChannelsEnabled } from "../lib/forum-config.js";
import { describeMedia, loadMessageMedia } from "./bot-media.js";
import { isCommunityHomeEnabled } from "./community-home.js";
import { canActOnMember, computeMemberPermissions, getMemberHierarchy } from "./permissions.js";
import { findTimeoutForRequest } from "./sanctions.js";
import { listChannels } from "./servers.js";

/**
 * What a server bot can DO, as opposed to say. See docs/plans/CUSTOM_BOTS.md
 * §Actions. The rules this file keeps:
 *
 *   * TWO KEYS. An action runs only when the bot AND the member who asked hold
 *     the permission. The bot's key is the route's own check (every write goes
 *     through the same route a person's client calls, as the bot); the
 *     requester's key is checked here, at staging and again at execution.
 *     Reads follow the same rule: the model only sees what both can see.
 *   * WRITES ARE STAGED, NEVER RUN MID-CONVERSATION. The model proposes; code
 *     validates, words and stores the plan. A few reversible writes run at
 *     once; more, or anything destructive, wait for the requester's "sim".
 *   * WHAT "SIM" APPROVES IS WHAT WAS SHOWN. The plan's text is built here from
 *     the stored actions, never from the model's prose.
 *   * A STEP RUNS AT MOST ONCE. Its row is written before it runs; a worker
 *     that takes a plan over skips any step with a row.
 *   * NO ROLES. Nothing here creates, edits, grants or removes a role or a
 *     permission, and `edit_channel` cannot make a channel private. Staff do
 *     that by hand. The bot's own role is made and kept in step with its tool
 *     switches when staff save them (`bot-role.ts`), never by the model.
 */

/** Writes one request may stage. */
export const BOT_ACTIONS_PER_REQUEST = 10;
/** Past this many writes, or with any destructive one, a plan needs a "sim". */
export const BOT_ACTIONS_WITHOUT_CONFIRM = 3;
/** How long a plan waits for its "sim". */
export const BOT_PLAN_TTL_MS = 5 * 60_000;

/** Writes one bot may run per hour, across every request. */
export function botActionsPerHour(): number {
  const raw = Number(process.env.BOTS_ACTIONS_PER_HOUR);
  return Number.isFinite(raw) && raw >= 0 ? Math.floor(raw) : 30;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const REF_RE = /^new:(\d{1,2})$/;
const BODY_MAX = 1900;
const READ_CHANNEL_DEFAULT = 20;
const READ_CHANNEL_MAX = 40;

/** Where invite links point. */
function appUrl(): string {
  return (process.env.PUBLIC_APP_URL?.trim() || "https://pqp.gg").replace(/\/+$/, "");
}

export interface BotActionContext {
  serverId: string;
  /** Where the request was made. */
  channelId: string;
  /** `server_bots.id`. */
  botId: string;
  bot: DbUser;
  requesterId: string;
  /** `@handle` or display name, for the audit reason. */
  requesterTag: string;
  /** The tools staff switched on for this bot. */
  enabledTools: ReadonlySet<string>;
  /** The bot's model, for the sentence explaining a failed step. */
  model?: string | null;
  /** The channels staff set the bot to answer in (a forum covers its posts). */
  answerChannelIds?: ReadonlySet<string>;
}

/** One staged write, as stored in `server_bot_plans.actions`. */
export interface StagedAction {
  tool: string;
  input: Record<string, unknown>;
  /** Code-built, pt-BR: what the plan shows and the result line names. */
  label: string;
  destructive: boolean;
  /** `new:N` when this action creates a channel later actions may name. */
  ref?: string;
}

export class ToolRefusal extends Error {}

interface ChannelInfo {
  id: string;
  name: string;
  type: string;
  parent_id: string | null;
  topic: string | null;
}

/** Per-request lookups, loaded once. */
export class ActionSession {
  readonly staged: StagedAction[] = [];
  /**
   * The conversation's messages by the number the model sees (`[m3]`), so a
   * tool can name a message without the model ever handling an id, and only
   * a message the member could see in this conversation.
   */
  messageRefs = new Map<number, { id: string; authorName: string; preview: string }>();
  private channels: Map<string, ChannelInfo> | null = null;
  private serverPerms: bigint | null = null;

  constructor(readonly ctx: BotActionContext) {}

  async allChannels(): Promise<Map<string, ChannelInfo>> {
    if (!this.channels) {
      const rows = await getPool().query<ChannelInfo>(
        `SELECT id, name, type, parent_id, topic FROM channels WHERE server_id = $1`,
        [this.ctx.serverId],
      );
      this.channels = new Map(rows.rows.map((row) => [row.id, row]));
    }
    return this.channels;
  }

  async requesterServerPerms(): Promise<bigint> {
    this.serverPerms ??= await computeMemberPermissions(this.ctx.serverId, this.ctx.requesterId);
    return this.serverPerms;
  }
}

// ------------------------------------------------------------------ helpers

async function requireRequesterServerPermission(
  session: ActionSession,
  permission: bigint,
  what: string,
): Promise<void> {
  if (!hasPermission(await session.requesterServerPerms(), permission)) {
    throw new ToolRefusal(`The member who asked lacks the "${what}" permission, so you may not do this for them.`);
  }
}

async function requesterSeesChannel(ctx: BotActionContext, channelId: string): Promise<boolean> {
  const perms = await computeMemberPermissions(ctx.serverId, ctx.requesterId, channelId);
  return hasPermission(perms, Permission.VIEW_CHANNEL);
}

/** A published, unlocked forum post of this server that the requester can see. */
async function forumPost(session: ActionSession, raw: unknown): Promise<{ id: string; name: string }> {
  if (typeof raw !== "string" || !UUID_RE.test(raw)) {
    throw new ToolRefusal("postId must be a post id from list_forum_posts.");
  }
  const found = await getPool().query<{ id: string; name: string; locked: boolean }>(
    `SELECT c.id, c.name, p.locked_at IS NOT NULL AS locked
       FROM forum_posts p JOIN channels c ON c.id = p.channel_id
      WHERE p.channel_id = $1 AND c.server_id = $2 AND p.published_at IS NOT NULL`,
    [raw, session.ctx.serverId],
  );
  const post = found.rows[0];
  if (!post || !(await requesterSeesChannel(session.ctx, post.id))) {
    throw new ToolRefusal(`No forum post ${raw} on this server.`);
  }
  if (post.locked) {
    throw new ToolRefusal(`The post "${post.name}" is locked: nobody can reply.`);
  }
  return post;
}

/**
 * Who may have the bot post a poll: here, anyone who may send messages; in
 * another channel, the same as `post_message` (send and manage messages
 * there), so the bot is never a megaphone for somebody who could not post.
 */
async function requirePollRights(ctx: BotActionContext, channelId: string, elsewhere: boolean): Promise<void> {
  const perms = await computeMemberPermissions(ctx.serverId, ctx.requesterId, channelId);
  if (!hasPermission(perms, Permission.VIEW_CHANNEL) || !hasPermission(perms, Permission.SEND_MESSAGES)) {
    throw new ToolRefusal("The member who asked cannot send messages there.");
  }
  if (elsewhere && !hasPermission(perms, Permission.MANAGE_MESSAGES)) {
    throw new ToolRefusal("The member who asked cannot post in another channel through you (needs Manage Messages there).");
  }
}

/** A poll in this conversation: by its [mN] number, or the newest one here. */
async function pollMessageId(session: ActionSession, raw: unknown): Promise<string> {
  if (raw !== undefined && raw !== null && raw !== "") {
    return messageRef(session, raw).id;
  }
  const newest = await getPool().query<{ message_id: string }>(
    `SELECT p.message_id FROM polls p JOIN messages m ON m.id = p.message_id
      WHERE m.channel_id = $1 ORDER BY m.created_at DESC LIMIT 1`,
    [session.ctx.channelId],
  );
  const id = newest.rows[0]?.message_id;
  if (!id) {
    throw new ToolRefusal("There is no poll in this conversation.");
  }
  return id;
}

/** An existing channel of this server that the requester can see. */
async function existingChannel(session: ActionSession, raw: unknown, field: string): Promise<ChannelInfo> {
  if (typeof raw !== "string" || !UUID_RE.test(raw)) {
    throw new ToolRefusal(`${field} must be a channel id from list_channels.`);
  }
  const channel = (await session.allChannels()).get(raw);
  if (!channel || !(await requesterSeesChannel(session.ctx, channel.id))) {
    throw new ToolRefusal(`No channel ${raw} on this server.`);
  }
  return channel;
}

/**
 * A category the action may go in: an existing one, a `new:N` category staged
 * earlier in this request, or null for none.
 */
async function categoryRef(
  session: ActionSession,
  raw: unknown,
): Promise<{ value: string | null; label: string | null }> {
  if (raw === undefined || raw === null || raw === "") {
    return { value: null, label: null };
  }
  if (typeof raw === "string" && REF_RE.test(raw)) {
    const staged = session.staged.find((action) => action.ref === raw);
    if (!staged || staged.input.type !== "category") {
      throw new ToolRefusal(`${raw} is not a category created earlier in this request.`);
    }
    return { value: raw, label: String(staged.input.name) };
  }
  const channel = await existingChannel(session, raw, "categoryId");
  if (channel.type !== "category") {
    throw new ToolRefusal(`#${channel.name} is not a category.`);
  }
  return { value: channel.id, label: channel.name };
}

/**
 * A channel name as the app wants it: "Lobby CS2" becomes "lobby-cs2". Models
 * write names the way people say them; categories keep their spaces.
 */
export function slugChannelName(type: string, name: string): string {
  if (type === "category") return name.trim();
  return name
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 100);
}

function messageRef(session: ActionSession, raw: unknown): { id: string; label: string } {
  const n = Number(String(raw ?? "").replace(/^m/i, ""));
  const found = Number.isInteger(n) ? session.messageRefs.get(n) : undefined;
  if (!found) {
    throw new ToolRefusal("messageRef must be a number like 3 from a [m3] in the conversation.");
  }
  return { id: found.id, label: `a mensagem de ${found.authorName} ("${found.preview}")` };
}

interface MemberTarget {
  id: string;
  label: string;
}

/**
 * A member the requester may act on: in this server, not the bot, and ranked
 * below the requester (the bot's own rank is the route's check).
 */
async function memberTarget(session: ActionSession, raw: unknown): Promise<MemberTarget> {
  const { serverId, requesterId, bot } = session.ctx;
  if (typeof raw !== "string" || !UUID_RE.test(raw)) {
    throw new ToolRefusal("userId must be an id from list_members.");
  }
  if (raw === bot.id) {
    throw new ToolRefusal("You cannot act on yourself.");
  }
  if (raw === requesterId) {
    throw new ToolRefusal("The member cannot ask you to act on themselves.");
  }
  const row = await getPool().query<{ display_name: string; username: string | null }>(
    `SELECT u.display_name, u.username FROM server_members m JOIN users u ON u.id = m.user_id
      WHERE m.server_id = $1 AND m.user_id = $2`,
    [serverId, raw],
  );
  const member = row.rows[0];
  if (!member) {
    throw new ToolRefusal("That person is not a member of this server.");
  }
  const [actor, target] = await Promise.all([
    getMemberHierarchy(serverId, requesterId),
    getMemberHierarchy(serverId, raw),
  ]);
  if (!actor || !target || !canActOnMember(actor, target)) {
    throw new ToolRefusal("The member who asked does not outrank that person, so you may not act on them.");
  }
  return { id: raw, label: member.username ? `@${member.username}` : member.display_name };
}

function routeResult(action: StagedAction, result: { status: number; body: unknown }): ExecResult {
  return result.status >= 200 && result.status < 300
    ? { ok: true, line: action.label }
    : { ok: false, line: `${action.label}: ${errorText(result.body)}` };
}

const MODERATION_REASON_MAX = 200;

function moderationReason(raw: unknown): string | null {
  return typeof raw === "string" && raw.trim() ? raw.trim().slice(0, MODERATION_REASON_MAX) : null;
}

function channelLabel(channel: ChannelInfo): string {
  return channel.type === "category" ? `a categoria "${channel.name}"` : `#${channel.name}`;
}

const TYPE_LABEL: Record<string, string> = {
  text: "canal de texto",
  voice: "canal de voz",
  category: "categoria",
  forum: "fórum",
};

function cleanBody(text: string): string {
  // Same defusing as a chat reply: no crowd pings from a bot.
  const defused = text.replace(/@(everyone|here)\b/gi, "＠$1").trim();
  return defused.length > BODY_MAX ? `${defused.slice(0, BODY_MAX - 1)}…` : defused;
}

/** What a route's error code means, for the member reading the card. */
const ROUTE_ERRORS: Record<string, string> = {
  forum_channels_off: "os fóruns estão desligados neste servidor",
  community_home_off: "o Baú está desligado",
  Forbidden: "sem permissão",
};

function errorText(body: unknown): string {
  if (body && typeof body === "object" && "error" in body && typeof body.error === "string") {
    return ROUTE_ERRORS[body.error] ?? body.error;
  }
  return "erro";
}

// -------------------------------------------------------------------- tools

export interface ExecResult {
  ok: boolean;
  line: string;
  createdId?: string;
  /** Shown under a step that worked, e.g. the invite link it made. */
  note?: string;
}

interface ExecEnv {
  ctx: BotActionContext;
  /** Unique per plan step, for routes that take a client nonce. */
  nonce: string;
  /** `new:N` to the id it was created as. */
  refs: Map<string, string>;
  invoke(
    method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE",
    path: string,
    body?: unknown,
  ): Promise<{ status: number; body: unknown }>;
}

interface ToolDef {
  spec: BotToolSpec;
  kind: "read" | "write";
  /** Why the tool is not offered on this server right now (a feature that is off), or null. */
  offline?(serverId: string): string | null;
  /** Server-level permission both keys need; the tool is not offered without it. */
  permission?: bigint;
  destructive?: boolean;
  read?(session: ActionSession, input: Record<string, unknown>): Promise<unknown>;
  stage?(session: ActionSession, input: Record<string, unknown>): Promise<StagedAction>;
  execute?(env: ExecEnv, action: StagedAction): Promise<ExecResult>;
  /** The route this tool writes through, for the bot's timeout check. */
  timeoutPath?(env: ExecEnv, action: StagedAction): { method: string; path: string };
}

function resolveRef(env: ExecEnv, value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const text = String(value);
  return REF_RE.test(text) ? (env.refs.get(text) ?? null) : text;
}

const TOOLS: ToolDef[] = [
  {
    kind: "read",
    spec: {
      name: "list_channels",
      description:
        "List this server's channels and categories (id, name, type, categoryId, topic, youAnswerHere), in display order. Call this before acting on a channel: actions take ids, not names. youAnswerHere says whether a mention there wakes you; in a forum it covers every post. Only the server's staff can change that, in your settings.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
    },
    async read(session) {
      const { serverId, bot, requesterId } = session.ctx;
      const [mine, theirs] = await Promise.all([
        listChannels(serverId, bot.id),
        listChannels(serverId, requesterId),
      ]);
      const visible = new Set(theirs.map((channel) => channel.id));
      return mine
        .filter((channel) => visible.has(channel.id) && channel.type !== "thread")
        .map((channel) => ({
          id: channel.id,
          name: channel.name,
          type: channel.type,
          categoryId: channel.parent_id,
          ...(channel.topic ? { topic: channel.topic } : {}),
          // Where a mention wakes you: staff choose these in the bot's settings.
          ...(session.ctx.answerChannelIds ? { youAnswerHere: session.ctx.answerChannelIds.has(channel.id) } : {}),
        }));
    },
  },
  {
    kind: "read",
    spec: {
      name: "read_channel",
      description:
        `Read the newest messages of a text channel or thread (at most ${READ_CHANNEL_MAX}), to summarise it or answer about it. It never reaches a channel's whole history: the result says how many messages came back and whether older ones exist. Only channels both you and the member can read.`,
      inputSchema: {
        type: "object",
        properties: {
          channelId: { type: "string", description: "A channel id from list_channels." },
          limit: { type: "integer", minimum: 1, maximum: READ_CHANNEL_MAX, description: `How many messages, newest last. Default ${READ_CHANNEL_DEFAULT}.` },
        },
        required: ["channelId"],
        additionalProperties: false,
      },
    },
    async read(session, input) {
      const channel = await existingChannel(session, input.channelId, "channelId");
      const { serverId, bot, requesterId } = session.ctx;
      const [botPerms, theirPerms] = await Promise.all([
        computeMemberPermissions(serverId, bot.id, channel.id),
        computeMemberPermissions(serverId, requesterId, channel.id),
      ]);
      const canRead = (perms: bigint) =>
        hasPermission(perms, Permission.VIEW_CHANNEL) && hasPermission(perms, Permission.READ_MESSAGE_HISTORY);
      if (!canRead(botPerms) || !canRead(theirPerms)) {
        throw new ToolRefusal(`#${channel.name} is not readable by both of you.`);
      }
      const limit = Math.min(READ_CHANNEL_MAX, Math.max(1, Number(input.limit) || READ_CHANNEL_DEFAULT));
      const rows = await getPool().query<{ id: string; body: string; created_at: Date; display_name: string; webhook_username: string | null }>(
        `SELECT m.id, m.body, m.created_at, u.display_name, m.webhook_username
           FROM messages m JOIN users u ON u.id = m.author_id
          WHERE m.channel_id = $1
          ORDER BY m.created_at DESC, m.id DESC
          LIMIT $2`,
        [channel.id, limit + 1],
      );
      // Stated, not left to the model: it miscounts a list of forty and then
      // reads "fewer than I asked for" as "that is everything".
      const olderExist = rows.rows.length > limit;
      const page = rows.rows.slice(0, limit);
      // Voice notes read as their transcript; images are named, not shown.
      const media = await loadMessageMedia(page.map((row) => row.id), serverId);
      const hearVoice = session.ctx.enabledTools.has("hear_voice_notes");
      return {
        channel: `#${channel.name}`,
        count: page.length,
        olderMessagesExist: olderExist,
        note: olderExist
          ? `Only the newest ${page.length} messages. Older ones exist that you cannot read; never call any of these the oldest in the channel.`
          : "This is the channel's whole history.",
        messages: page.reverse().map((row) => ({
          at: row.created_at.toISOString(),
          from: row.webhook_username ?? row.display_name,
          text: [row.body.slice(0, 600), describeMedia(media.get(row.id), { hearVoice, imageNumbers: new Map() })]
            .filter(Boolean)
            .join(" "),
        })),
      };
    },
  },
  {
    offline: (serverId) => (forumChannelsEnabled(serverId) ? null : "forum channels are turned off on this server"),
    kind: "read",
    spec: {
      name: "list_forum_posts",
      description:
        "List a forum's posts, newest activity first (id, title, author, replies, locked, resolved). A post is a thread: read_channel reads it and reply_forum_post answers in it.",
      inputSchema: {
        type: "object",
        properties: {
          forumChannelId: { type: "string", description: "A forum channel id from list_channels." },
          query: { type: "string", maxLength: 50, description: "Part of a title." },
        },
        required: ["forumChannelId"],
        additionalProperties: false,
      },
    },
    async read(session, input) {
      const forum = await existingChannel(session, input.forumChannelId, "forumChannelId");
      if (forum.type !== "forum") {
        throw new ToolRefusal(`#${forum.name} is not a forum.`);
      }
      const query = typeof input.query === "string" ? input.query.trim() : "";
      const rows = await getPool().query<{
        id: string;
        title: string;
        author: string | null;
        replies: number;
        locked: boolean;
        resolved: boolean;
        last_activity_at: Date;
      }>(
        `SELECT c.id, c.name AS title, u.display_name AS author,
                GREATEST((SELECT COUNT(*)::int FROM messages m WHERE m.channel_id = c.id) - 1, 0) AS replies,
                p.locked_at IS NOT NULL AS locked, p.resolved_at IS NOT NULL AS resolved,
                p.last_activity_at
           FROM forum_posts p
           JOIN channels c ON c.id = p.channel_id
           LEFT JOIN users u ON u.id = p.author_id
          WHERE p.forum_id = $1 AND p.published_at IS NOT NULL
            AND ($2 = '' OR c.name ILIKE '%' || $2 || '%')
          ORDER BY p.pinned_at IS NOT NULL DESC, p.last_activity_at DESC
          LIMIT 25`,
        [forum.id, query],
      );
      return rows.rows.map((row) => ({
        id: row.id,
        title: row.title,
        author: row.author ?? "Conta excluída",
        replies: row.replies,
        lastActivity: row.last_activity_at.toISOString(),
        ...(row.locked ? { locked: true } : {}),
        ...(row.resolved ? { resolved: true } : {}),
      }));
    },
  },
  {
    kind: "write",
    permission: Permission.MANAGE_CHANNELS,
    spec: {
      name: "create_channel",
      description:
        "Stage creating a channel or a category. Returns a ref like new:1 that later actions in this request can use as a channelId or categoryId. Channel names become lowercase with hyphens (Lobby CS2 is saved as lobby-cs2); category names keep their spaces.",
      inputSchema: {
        type: "object",
        properties: {
          name: { type: "string", maxLength: 100 },
          type: { type: "string", enum: ["text", "voice", "category", "forum"] },
          categoryId: {
            type: "string",
            description: "Category to put it in: an id from list_channels or a new:N ref. Omit for none.",
          },
          topic: { type: "string", maxLength: 200 },
        },
        required: ["name", "type"],
        additionalProperties: false,
      },
    },
    async stage(session, input) {
      const type = String(input.type ?? "");
      const category = type === "category" ? { value: null, label: null } : await categoryRef(session, input.categoryId);
      const parsed = createChannelSchema.safeParse({
        name: slugChannelName(type, String(input.name ?? "")),
        type,
        topic: typeof input.topic === "string" && input.topic.trim() ? input.topic : undefined,
        parentId: null,
      });
      if (type === "forum" && !forumChannelsEnabled(session.ctx.serverId)) {
        throw new ToolRefusal("Forum channels are turned off on this server. The server's staff can ask for them.");
      }
      if (!parsed.success || !["text", "voice", "category", "forum"].includes(type)) {
        throw new ToolRefusal(parsed.success ? "Unsupported type." : parsed.error.issues[0]?.message ?? "Invalid name.");
      }
      const ref = `new:${session.staged.filter((action) => action.ref).length + 1}`;
      const name = parsed.data.name;
      return {
        tool: "create_channel",
        input: { name, type, categoryId: category.value, topic: parsed.data.topic ?? null },
        label: `Criar ${TYPE_LABEL[type]} "${name}"${category.label ? ` em "${category.label}"` : ""}`,
        destructive: false,
        ref,
      };
    },
    async execute(env, action) {
      const parentId = resolveRef(env, action.input.categoryId);
      if (action.input.categoryId && !parentId) {
        return { ok: false, line: `${action.label}: a categoria não foi criada` };
      }
      const { status, body } = await env.invoke("POST", `/api/servers/${env.ctx.serverId}/channels`, {
        name: action.input.name,
        type: action.input.type,
        isPrivate: false,
        ...(action.input.topic ? { topic: action.input.topic } : {}),
        parentId,
      });
      if (status !== 201) {
        return { ok: false, line: `${action.label}: ${errorText(body)}` };
      }
      const id = (body as { channel?: { id?: string } }).channel?.id;
      return { ok: true, line: action.label, ...(id ? { createdId: id } : {}) };
    },
    timeoutPath: (env) => ({ method: "POST", path: `/api/servers/${env.ctx.serverId}/channels` }),
  },
  {
    kind: "write",
    permission: Permission.MANAGE_CHANNELS,
    spec: {
      name: "edit_channel",
      description: "Stage renaming a channel or category, or changing a channel's topic or slow mode. Cannot change privacy or permissions.",
      inputSchema: {
        type: "object",
        properties: {
          channelId: { type: "string", description: "An id from list_channels, or a new:N ref." },
          name: { type: "string", maxLength: 100 },
          topic: { type: ["string", "null"], maxLength: 200, description: "null clears it." },
          slowmodeSeconds: { type: "integer", minimum: 0, maximum: 21600 },
        },
        required: ["channelId"],
        additionalProperties: false,
      },
    },
    async stage(session, input) {
      const channel = await existingChannel(session, input.channelId, "channelId");
      const changes: Record<string, unknown> = {};
      if (typeof input.name === "string") changes.name = slugChannelName(channel.type, input.name);
      if (input.topic === null || typeof input.topic === "string") changes.topic = input.topic;
      if (typeof input.slowmodeSeconds === "number") changes.slowmodeSeconds = input.slowmodeSeconds;
      if (Object.keys(changes).length === 0) {
        throw new ToolRefusal("Nothing to change.");
      }
      const parsed = updateChannelSchema.safeParse(changes);
      if (!parsed.success) {
        throw new ToolRefusal(parsed.error.issues[0]?.message ?? "Invalid change.");
      }
      const parts: string[] = [];
      if (changes.name !== undefined) parts.push(`renomear para "${String(changes.name)}"`);
      if (changes.topic !== undefined) parts.push(changes.topic ? "trocar o tópico" : "limpar o tópico");
      if (changes.slowmodeSeconds !== undefined) parts.push(`modo lento ${String(changes.slowmodeSeconds)}s`);
      return {
        tool: "edit_channel",
        input: { channelId: channel.id, ...changes },
        label: `Editar ${channelLabel(channel)}: ${parts.join(", ")}`,
        destructive: false,
      };
    },
    async execute(env, action) {
      const { channelId, ...changes } = action.input;
      const { status, body } = await env.invoke("PATCH", `/api/channels/${String(channelId)}`, changes);
      return status === 200 ? { ok: true, line: action.label } : { ok: false, line: `${action.label}: ${errorText(body)}` };
    },
    timeoutPath: (_env, action) => ({ method: "PATCH", path: `/api/channels/${String(action.input.channelId)}` }),
  },
  {
    kind: "write",
    permission: Permission.MANAGE_CHANNELS,
    spec: {
      name: "move_channel",
      description: "Stage moving a channel into a category (or out of any) at a position. position 0 is the top of that category.",
      inputSchema: {
        type: "object",
        properties: {
          channelId: { type: "string", description: "An id from list_channels." },
          categoryId: { type: ["string", "null"], description: "Target category id or new:N ref; null for none." },
          position: { type: "integer", minimum: 0 },
        },
        required: ["channelId", "categoryId", "position"],
        additionalProperties: false,
      },
    },
    async stage(session, input) {
      const channel = await existingChannel(session, input.channelId, "channelId");
      if (channel.type === "category") {
        throw new ToolRefusal("Categories cannot be moved into a category.");
      }
      const category = await categoryRef(session, input.categoryId);
      const position = Number(input.position);
      if (!Number.isInteger(position) || position < 0) {
        throw new ToolRefusal("position must be a whole number from 0.");
      }
      return {
        tool: "move_channel",
        input: { channelId: channel.id, categoryId: category.value, position },
        label: `Mover ${channelLabel(channel)} para ${category.label ? `"${category.label}"` : "fora das categorias"} (posição ${position + 1})`,
        destructive: false,
      };
    },
    async execute(env, action) {
      const parentId = resolveRef(env, action.input.categoryId);
      if (action.input.categoryId && !parentId) {
        return { ok: false, line: `${action.label}: a categoria não foi criada` };
      }
      const body = moveChannelSchema.parse({ parentId, index: action.input.position });
      const result = await env.invoke("PATCH", `/api/channels/${String(action.input.channelId)}/move`, body);
      return result.status === 200 || result.status === 204
        ? { ok: true, line: action.label }
        : { ok: false, line: `${action.label}: ${errorText(result.body)}` };
    },
    timeoutPath: (_env, action) => ({ method: "PATCH", path: `/api/channels/${String(action.input.channelId)}/move` }),
  },
  {
    kind: "write",
    permission: Permission.MANAGE_CHANNELS,
    destructive: true,
    spec: {
      name: "delete_channel",
      description:
        "Stage deleting a channel or category, with its messages. Destructive: always waits for the member's confirmation.",
      inputSchema: {
        type: "object",
        properties: { channelId: { type: "string", description: "An id from list_channels." } },
        required: ["channelId"],
        additionalProperties: false,
      },
    },
    async stage(session, input) {
      const channel = await existingChannel(session, input.channelId, "channelId");
      return {
        tool: "delete_channel",
        input: { channelId: channel.id },
        label: `Apagar ${channelLabel(channel)}${channel.type === "category" ? "" : " e as mensagens dele"}`,
        destructive: true,
      };
    },
    async execute(env, action) {
      const { status, body } = await env.invoke("DELETE", `/api/channels/${String(action.input.channelId)}`);
      return status === 200 || status === 204
        ? { ok: true, line: action.label }
        : { ok: false, line: `${action.label}: ${errorText(body)}` };
    },
    timeoutPath: (_env, action) => ({ method: "DELETE", path: `/api/channels/${String(action.input.channelId)}` }),
  },
  {
    kind: "write",
    permission: Permission.MANAGE_MESSAGES,
    spec: {
      name: "post_message",
      description: "Stage posting a message as yourself in another text channel (an announcement, a welcome note). Not for answering the member: your reply already does that.",
      inputSchema: {
        type: "object",
        properties: {
          channelId: { type: "string", description: "A text channel id from list_channels, or a new:N ref." },
          text: { type: "string", maxLength: BODY_MAX },
        },
        required: ["channelId", "text"],
        additionalProperties: false,
      },
    },
    async stage(session, input) {
      const text = typeof input.text === "string" ? cleanBody(input.text) : "";
      if (!text) {
        throw new ToolRefusal("text is empty.");
      }
      let target: string;
      let where: string;
      if (typeof input.channelId === "string" && REF_RE.test(input.channelId)) {
        const staged = session.staged.find((action) => action.ref === input.channelId);
        if (!staged || staged.input.type !== "text") {
          throw new ToolRefusal(`${input.channelId} is not a text channel created earlier in this request.`);
        }
        target = input.channelId;
        where = `#${String(staged.input.name)}`;
      } else {
        const channel = await existingChannel(session, input.channelId, "channelId");
        if (channel.type !== "text") {
          throw new ToolRefusal("Messages go in text channels only.");
        }
        const perms = await computeMemberPermissions(session.ctx.serverId, session.ctx.requesterId, channel.id);
        if (!hasPermission(perms, Permission.SEND_MESSAGES) || !hasPermission(perms, Permission.MANAGE_MESSAGES)) {
          throw new ToolRefusal("The member who asked cannot post and manage messages there.");
        }
        target = channel.id;
        where = `#${channel.name}`;
      }
      const preview = text.length > 80 ? `${text.slice(0, 79)}…` : text;
      return {
        tool: "post_message",
        input: { channelId: target, text },
        label: `Postar em ${where}: "${preview.replace(/\s+/g, " ")}"`,
        destructive: false,
      };
    },
    async execute(env, action) {
      const channelId = resolveRef(env, action.input.channelId);
      if (!channelId) {
        return { ok: false, line: `${action.label}: o canal não foi criado` };
      }
      const { postChannelMessage } = await import("../ws/chat.js");
      const posted = await postChannelMessage({
        author: env.ctx.bot,
        channelId,
        body: String(action.input.text),
      });
      return posted.ok ? { ok: true, line: action.label } : { ok: false, line: `${action.label}: ${posted.reason}` };
    },
  },
  // ------------------------------------------------- messages and threads
  {
    kind: "write",
    permission: Permission.MANAGE_MESSAGES,
    spec: {
      name: "pin_message",
      description: "Stage pinning or unpinning a message from this conversation.",
      inputSchema: {
        type: "object",
        properties: {
          messageRef: { type: "integer", description: "The number in [mN] before the message." },
          unpin: { type: "boolean" },
        },
        required: ["messageRef"],
        additionalProperties: false,
      },
    },
    async stage(session, input) {
      const message = messageRef(session, input.messageRef);
      const unpin = input.unpin === true;
      return {
        tool: "pin_message",
        input: { messageId: message.id, unpin },
        label: `${unpin ? "Desafixar" : "Fixar"} ${message.label}`,
        destructive: false,
      };
    },
    async execute(env, action) {
      const path = `/api/messages/${String(action.input.messageId)}/pin`;
      return routeResult(action, await env.invoke(action.input.unpin ? "DELETE" : "POST", path));
    },
    timeoutPath: (_env, action) => ({ method: "POST", path: `/api/messages/${String(action.input.messageId)}/pin` }),
  },
  {
    kind: "write",
    spec: {
      name: "create_thread",
      description: "Stage opening a thread on a message from this conversation.",
      inputSchema: {
        type: "object",
        properties: {
          messageRef: { type: "integer", description: "The number in [mN] before the message." },
          name: { type: "string", maxLength: 100 },
        },
        required: ["messageRef"],
        additionalProperties: false,
      },
    },
    async stage(session, input) {
      const message = messageRef(session, input.messageRef);
      const name = typeof input.name === "string" && input.name.trim() ? input.name.trim().slice(0, 100) : null;
      return {
        tool: "create_thread",
        input: { messageId: message.id, name },
        label: `Abrir um tópico${name ? ` "${name}"` : ""} em ${message.label}`,
        destructive: false,
      };
    },
    async execute(env, action) {
      return routeResult(
        action,
        await env.invoke("POST", `/api/messages/${String(action.input.messageId)}/threads`, {
          ...(action.input.name ? { name: action.input.name } : {}),
        }),
      );
    },
    timeoutPath: (_env, action) => ({ method: "POST", path: `/api/messages/${String(action.input.messageId)}/threads` }),
  },
  {
    offline: (serverId) => (forumChannelsEnabled(serverId) ? null : "forum channels are turned off on this server"),
    kind: "write",
    permission: Permission.MANAGE_MESSAGES,
    spec: {
      name: "create_forum_post",
      description: "Stage a new post in a forum channel, as yourself.",
      inputSchema: {
        type: "object",
        properties: {
          forumChannelId: { type: "string", description: "A forum channel id from list_channels." },
          title: { type: "string", maxLength: 100 },
          body: { type: "string", maxLength: BODY_MAX },
        },
        required: ["forumChannelId", "title", "body"],
        additionalProperties: false,
      },
    },
    async stage(session, input) {
      const forum = await existingChannel(session, input.forumChannelId, "forumChannelId");
      if (forum.type !== "forum") {
        throw new ToolRefusal(`#${forum.name} is not a forum.`);
      }
      const title = typeof input.title === "string" ? input.title.trim().slice(0, 100) : "";
      const body = typeof input.body === "string" ? cleanBody(input.body) : "";
      if (!title || !body) {
        throw new ToolRefusal("A post needs a title and a body.");
      }
      return {
        tool: "create_forum_post",
        input: { forumId: forum.id, title, body },
        label: `Publicar no fórum #${forum.name}: "${title}"`,
        destructive: false,
      };
    },
    async execute(env, action) {
      return routeResult(
        action,
        await env.invoke("POST", `/api/channels/${String(action.input.forumId)}/posts`, {
          title: action.input.title,
          body: action.input.body,
          nonce: env.nonce,
        }),
      );
    },
    timeoutPath: (_env, action) => ({ method: "POST", path: `/api/channels/${String(action.input.forumId)}/posts` }),
  },
  {
    offline: (serverId) => (forumChannelsEnabled(serverId) ? null : "forum channels are turned off on this server"),
    kind: "write",
    permission: Permission.MANAGE_MESSAGES,
    spec: {
      name: "reply_forum_post",
      description:
        "Stage replying, as yourself, inside an existing forum post (a post id from list_forum_posts). Not for answering the member when they called you inside that post: your reply already lands there.",
      inputSchema: {
        type: "object",
        properties: {
          postId: { type: "string", description: "A post id from list_forum_posts." },
          text: { type: "string", maxLength: BODY_MAX },
        },
        required: ["postId", "text"],
        additionalProperties: false,
      },
    },
    async stage(session, input) {
      const text = typeof input.text === "string" ? cleanBody(input.text) : "";
      if (!text) {
        throw new ToolRefusal("text is empty.");
      }
      const post = await forumPost(session, input.postId);
      const perms = await computeMemberPermissions(session.ctx.serverId, session.ctx.requesterId, post.id);
      if (!hasPermission(perms, Permission.SEND_MESSAGES)) {
        throw new ToolRefusal("The member who asked cannot reply in that post.");
      }
      const preview = text.length > 80 ? `${text.slice(0, 79)}…` : text;
      return {
        tool: "reply_forum_post",
        input: { postId: post.id, text },
        label: `Responder no post "${post.name}": "${preview.replace(/\s+/g, " ")}"`,
        destructive: false,
      };
    },
    async execute(env, action) {
      const { postChannelMessage } = await import("../ws/chat.js");
      const posted = await postChannelMessage({
        author: env.ctx.bot,
        channelId: String(action.input.postId),
        body: String(action.input.text),
      });
      return posted.ok
        ? { ok: true, line: action.label }
        : { ok: false, line: `${action.label}: ${ROUTE_ERRORS[posted.reason] ?? posted.reason}` };
    },
  },
  {
    offline: () => (isCommunityHomeEnabled() ? null : "Baú is turned off on this instance"),
    kind: "write",
    permission: Permission.MANAGE_SERVER,
    spec: {
      name: "create_bau_post",
      description: "Stage a text post on the server's Baú (its home feed). Saved as a draft unless the member asked to publish now.",
      inputSchema: {
        type: "object",
        properties: {
          title: { type: "string", maxLength: 120 },
          body: { type: "string", maxLength: BODY_MAX },
          publish: { type: "boolean", description: "true only when the member asked to publish now." },
        },
        required: ["title", "body"],
        additionalProperties: false,
      },
    },
    async stage(_session, input) {
      if (!isCommunityHomeEnabled()) {
        throw new ToolRefusal("The Baú is not turned on here.");
      }
      const title = typeof input.title === "string" ? input.title.trim().slice(0, 120) : "";
      const body = typeof input.body === "string" ? cleanBody(input.body) : "";
      if (!title && !body) {
        throw new ToolRefusal("A post needs a title or a body.");
      }
      const publish = input.publish === true;
      return {
        tool: "create_bau_post",
        input: { title, body, publish },
        label: `${publish ? "Publicar" : "Criar um rascunho"} no Baú: "${title || body.slice(0, 60)}"`,
        destructive: false,
      };
    },
    async execute(env, action) {
      return routeResult(
        action,
        await env.invoke("POST", `/api/servers/${env.ctx.serverId}/home/posts`, {
          title: action.input.title || null,
          body: action.input.body || null,
          status: action.input.publish ? "published" : "draft",
        }),
      );
    },
    timeoutPath: (env) => ({ method: "POST", path: `/api/servers/${env.ctx.serverId}/home/posts` }),
  },
  // ------------------------------------------------------------ moderation
  {
    kind: "read",
    spec: {
      name: "list_members",
      description: "Find members of this server by name or @handle (id, name, handle). Moderation tools take these ids.",
      inputSchema: {
        type: "object",
        properties: { query: { type: "string", maxLength: 50, description: "Part of a name or handle; omit for the first 25." } },
        additionalProperties: false,
      },
    },
    async read(session, input) {
      const query = typeof input.query === "string" ? input.query.replace(/^@/, "").trim() : "";
      const rows = await getPool().query<{ id: string; display_name: string; username: string | null; is_character: boolean }>(
        `SELECT u.id, u.display_name, u.username, u.is_character
           FROM server_members m JOIN users u ON u.id = m.user_id
          WHERE m.server_id = $1
            AND ($2 = '' OR u.display_name ILIKE '%' || $2 || '%' OR u.username ILIKE '%' || $2 || '%')
          ORDER BY u.display_name
          LIMIT 25`,
        [session.ctx.serverId, query],
      );
      return rows.rows.map((row) => ({
        id: row.id,
        name: row.display_name,
        ...(row.username ? { handle: `@${row.username}` } : {}),
        ...(row.is_character ? { bot: true } : {}),
      }));
    },
  },
  {
    kind: "write",
    permission: Permission.MANAGE_MESSAGES,
    destructive: true,
    spec: {
      name: "delete_message",
      description: "Stage deleting a message from this conversation. Always waits for the member's confirmation.",
      inputSchema: {
        type: "object",
        properties: { messageRef: { type: "integer", description: "The number in [mN] before the message." } },
        required: ["messageRef"],
        additionalProperties: false,
      },
    },
    async stage(session, input) {
      const message = messageRef(session, input.messageRef);
      return { tool: "delete_message", input: { messageId: message.id }, label: `Apagar ${message.label}`, destructive: true };
    },
    async execute(env, action) {
      return routeResult(action, await env.invoke("DELETE", `/api/messages/${String(action.input.messageId)}`));
    },
    timeoutPath: (_env, action) => ({ method: "DELETE", path: `/api/messages/${String(action.input.messageId)}` }),
  },
  {
    kind: "write",
    permission: Permission.MODERATE_MEMBERS,
    destructive: true,
    spec: {
      name: "timeout_member",
      description: "Stage silencing a member for some minutes (1 to 40320). Always waits for confirmation.",
      inputSchema: {
        type: "object",
        properties: {
          userId: { type: "string", description: "An id from list_members." },
          minutes: { type: "integer", minimum: 1, maximum: 40320 },
          reason: { type: "string", maxLength: MODERATION_REASON_MAX },
        },
        required: ["userId", "minutes"],
        additionalProperties: false,
      },
    },
    async stage(session, input) {
      const target = await memberTarget(session, input.userId);
      const minutes = Number(input.minutes);
      if (!Number.isInteger(minutes) || minutes < 1 || minutes > 40320) {
        throw new ToolRefusal("minutes must be 1 to 40320.");
      }
      const reason = moderationReason(input.reason);
      return {
        tool: "timeout_member",
        input: { userId: target.id, minutes, reason },
        label: `Silenciar ${target.label} por ${minutes} min${reason ? ` (${reason})` : ""}`,
        destructive: true,
      };
    },
    async execute(env, action) {
      return routeResult(
        action,
        await env.invoke("POST", `/api/servers/${env.ctx.serverId}/timeouts`, {
          userId: action.input.userId,
          minutes: action.input.minutes,
          reason: action.input.reason,
        }),
      );
    },
    timeoutPath: (env) => ({ method: "POST", path: `/api/servers/${env.ctx.serverId}/timeouts` }),
  },
  {
    kind: "write",
    permission: Permission.KICK_MEMBERS,
    destructive: true,
    spec: {
      name: "kick_member",
      description: "Stage removing a member from the server (they can rejoin with an invite). Always waits for confirmation.",
      inputSchema: {
        type: "object",
        properties: { userId: { type: "string", description: "An id from list_members." } },
        required: ["userId"],
        additionalProperties: false,
      },
    },
    async stage(session, input) {
      const target = await memberTarget(session, input.userId);
      return { tool: "kick_member", input: { userId: target.id }, label: `Expulsar ${target.label} do servidor`, destructive: true };
    },
    async execute(env, action) {
      return routeResult(
        action,
        await env.invoke("DELETE", `/api/servers/${env.ctx.serverId}/members/${String(action.input.userId)}`, { ban: false }),
      );
    },
    timeoutPath: (env, action) => ({ method: "DELETE", path: `/api/servers/${env.ctx.serverId}/members/${String(action.input.userId)}` }),
  },
  {
    kind: "write",
    permission: Permission.BAN_MEMBERS,
    destructive: true,
    spec: {
      name: "ban_member",
      description: "Stage banning a member from the server. Always waits for confirmation.",
      inputSchema: {
        type: "object",
        properties: {
          userId: { type: "string", description: "An id from list_members." },
          reason: { type: "string", maxLength: MODERATION_REASON_MAX },
        },
        required: ["userId"],
        additionalProperties: false,
      },
    },
    async stage(session, input) {
      const target = await memberTarget(session, input.userId);
      const reason = moderationReason(input.reason);
      return {
        tool: "ban_member",
        input: { userId: target.id, reason },
        label: `Banir ${target.label}${reason ? ` (${reason})` : ""}`,
        destructive: true,
      };
    },
    async execute(env, action) {
      return routeResult(
        action,
        await env.invoke("POST", `/api/servers/${env.ctx.serverId}/bans`, {
          userId: action.input.userId,
          reason: action.input.reason,
        }),
      );
    },
    timeoutPath: (env) => ({ method: "POST", path: `/api/servers/${env.ctx.serverId}/bans` }),
  },
  // ------------------------------------------------------------------ polls
  {
    kind: "write",
    spec: {
      name: "create_poll",
      description:
        "Stage posting a poll as yourself, in this conversation unless channelId names another text channel. Members vote on it with buttons; read_poll shows the results.",
      inputSchema: {
        type: "object",
        properties: {
          question: { type: "string", maxLength: 300 },
          options: {
            type: "array",
            items: { type: "string", maxLength: POLL_OPTION_MAX_LENGTH },
            minItems: 2,
            maxItems: POLL_MAX_OPTIONS,
          },
          durationHours: {
            type: "integer",
            enum: POLL_DURATION_SECONDS.map((seconds) => seconds / 3600),
            description: "How long it stays open. Default 24.",
          },
          multipleChoice: { type: "boolean", description: "Members may pick more than one. Default false." },
          channelId: { type: "string", description: "Another text channel id from list_channels. Omit for here." },
        },
        required: ["question", "options"],
        additionalProperties: false,
      },
    },
    async stage(session, input) {
      const hours = Number.isInteger(input.durationHours) ? Number(input.durationHours) : 24;
      const parsed = pollRequestSchema.safeParse({
        question: input.question,
        options: Array.isArray(input.options) ? input.options : [],
        durationSeconds: hours * 3600,
        allowMultiselect: input.multipleChoice === true,
      });
      if (!parsed.success) {
        throw new ToolRefusal(
          `Invalid poll: ${parsed.error.issues[0]?.message ?? "check it"}. A question, 2 to ${POLL_MAX_OPTIONS} options of at most ${POLL_OPTION_MAX_LENGTH} characters, and durationHours one of ${POLL_DURATION_SECONDS.map((seconds) => seconds / 3600).join(", ")}.`,
        );
      }
      const elsewhere = typeof input.channelId === "string" && input.channelId !== session.ctx.channelId;
      const channel = elsewhere ? await existingChannel(session, input.channelId, "channelId") : null;
      if (channel && channel.type !== "text") {
        throw new ToolRefusal("Polls go in text channels only.");
      }
      const channelId = channel?.id ?? session.ctx.channelId;
      await requirePollRights(session.ctx, channelId, !!channel);
      return {
        tool: "create_poll",
        input: { channelId, elsewhere: !!channel, poll: parsed.data },
        label: `Criar enquete${channel ? ` em #${channel.name}` : ""}: "${parsed.data.question}"`,
        destructive: false,
      };
    },
    async execute(env, action) {
      const channelId = String(action.input.channelId);
      try {
        await requirePollRights(env.ctx, channelId, action.input.elsewhere === true);
      } catch (error) {
        if (error instanceof ToolRefusal) {
          return { ok: false, line: `${action.label}: ${error.message}` };
        }
        throw error;
      }
      const { postChannelMessage } = await import("../ws/chat.js");
      const posted = await postChannelMessage({
        author: env.ctx.bot,
        channelId,
        body: "",
        poll: action.input.poll as PollRequest,
      });
      return posted.ok
        ? { ok: true, line: action.label, createdId: posted.message.id }
        : { ok: false, line: `${action.label}: ${ROUTE_ERRORS[posted.reason] ?? posted.reason}` };
    },
  },
  {
    kind: "read",
    spec: {
      name: "read_poll",
      description:
        "Read a poll in this conversation: its question, the options numbered from 1 with their votes, whether it is closed, and what you voted. Without messageRef, the newest poll here.",
      inputSchema: {
        type: "object",
        properties: {
          messageRef: { type: "integer", description: "The number in [mN] before the poll. Omit for the newest poll here." },
        },
        additionalProperties: false,
      },
    },
    async read(session, input) {
      const messageId = await pollMessageId(session, input.messageRef);
      const { getPoll } = await import("./polls.js");
      const poll = await getPoll(messageId, session.ctx.bot.id);
      if (!poll) {
        throw new ToolRefusal("That message is not a poll.");
      }
      return {
        question: poll.question,
        multipleChoice: poll.allowMultiselect,
        closed: isPollClosed(poll),
        closesAt: poll.closedAt ?? poll.closesAt,
        totalVotes: poll.totalVotes,
        options: poll.options.map((option, index) => ({
          number: index + 1,
          label: option.label,
          votes: option.votes,
          ...(option.voted ? { youVoted: true } : {}),
          voters: option.voters.slice(0, 10).map((voter) => voter.displayName),
        })),
      };
    },
  },
  {
    kind: "write",
    spec: {
      name: "vote_poll",
      description:
        "Stage voting, as yourself, in a poll in this conversation. Only when the member asks you to vote. Give the option's number from read_poll.",
      inputSchema: {
        type: "object",
        properties: {
          messageRef: { type: "integer", description: "The number in [mN] before the poll. Omit for the newest poll here." },
          option: { type: "integer", minimum: 1, maximum: POLL_MAX_OPTIONS },
        },
        required: ["option"],
        additionalProperties: false,
      },
    },
    async stage(session, input) {
      const messageId = await pollMessageId(session, input.messageRef);
      const { getPoll } = await import("./polls.js");
      const poll = await getPoll(messageId, session.ctx.bot.id);
      if (!poll) {
        throw new ToolRefusal("That message is not a poll.");
      }
      if (isPollClosed(poll)) {
        throw new ToolRefusal("That poll is closed.");
      }
      const option = poll.options[Number(input.option) - 1];
      if (!option) {
        throw new ToolRefusal(`option must be a number from 1 to ${poll.options.length}.`);
      }
      return {
        tool: "vote_poll",
        input: { messageId, optionId: option.id },
        label: `Votar em "${option.label}" na enquete "${poll.question}"`,
        destructive: false,
      };
    },
    async execute(env, action) {
      const messageId = String(action.input.messageId);
      const optionId = String(action.input.optionId);
      const { getPoll, votePoll } = await import("./polls.js");
      const before = await getPoll(messageId, env.ctx.bot.id);
      // Voting again on the same option takes the vote back; a bot asked to
      // vote twice keeps its vote instead.
      if (before?.options.find((option) => option.id === optionId)?.voted) {
        return { ok: true, line: action.label };
      }
      const voted = await votePoll(messageId, env.ctx.bot.id, optionId);
      if (!voted) {
        return { ok: false, line: `${action.label}: a enquete fechou` };
      }
      const { broadcastToChannel } = await import("../ws/chat.js");
      broadcastToChannel(env.ctx.channelId, {
        type: "poll-update",
        channelId: env.ctx.channelId,
        messageId,
        poll: { ...voted.poll, canClose: false },
        voterId: env.ctx.bot.id,
        optionId,
        added: voted.added,
      });
      return { ok: true, line: action.label };
    },
  },
  {
    kind: "write",
    permission: Permission.CREATE_INVITE,
    spec: {
      name: "create_invite",
      description: "Stage creating an invite link to this server. The link appears in the result.",
      inputSchema: {
        type: "object",
        properties: {
          maxUses: { type: "integer", minimum: 1, maximum: 100, description: "Omit for unlimited." },
          expiresInHours: { type: "integer", minimum: 1, maximum: 720, description: "Omit for the server default." },
        },
        additionalProperties: false,
      },
    },
    async stage(_session, input) {
      const maxUses = Number.isInteger(input.maxUses) ? Number(input.maxUses) : null;
      const hours = Number.isInteger(input.expiresInHours) ? Number(input.expiresInHours) : null;
      const parts = [maxUses ? `${maxUses} uso${maxUses === 1 ? "" : "s"}` : null, hours ? `vale ${hours}h` : null].filter(Boolean);
      return {
        tool: "create_invite",
        input: { maxUses, expiresInHours: hours },
        label: `Criar um convite${parts.length ? ` (${parts.join(", ")})` : ""}`,
        destructive: false,
      };
    },
    async execute(env, action) {
      const result = await env.invoke("POST", `/api/servers/${env.ctx.serverId}/invites`, {
        ...(action.input.maxUses ? { maxUses: action.input.maxUses } : {}),
        ...(action.input.expiresInHours ? { expiresInHours: action.input.expiresInHours } : {}),
      });
      if (result.status !== 201) {
        return { ok: false, line: `${action.label}: ${errorText(result.body)}` };
      }
      const code = (result.body as { invite?: { code?: string } }).invite?.code;
      const link = code ? `${appUrl()}/app/invite/${encodeURIComponent(code)}` : null;
      return { ok: true, line: link ? `${action.label}: ${link}` : action.label, ...(link ? { note: link } : {}) };
    },
    timeoutPath: (env) => ({ method: "POST", path: `/api/servers/${env.ctx.serverId}/invites` }),
  },
  {
    kind: "write",
    permission: Permission.MODERATE_MEMBERS,
    spec: {
      name: "remove_timeout",
      description: "Stage lifting a member's timeout early.",
      inputSchema: {
        type: "object",
        properties: { userId: { type: "string", description: "An id from list_members." } },
        required: ["userId"],
        additionalProperties: false,
      },
    },
    async stage(session, input) {
      const target = await memberTarget(session, input.userId);
      return { tool: "remove_timeout", input: { userId: target.id }, label: `Tirar o silêncio de ${target.label}`, destructive: false };
    },
    async execute(env, action) {
      return routeResult(
        action,
        await env.invoke("DELETE", `/api/servers/${env.ctx.serverId}/timeouts/${String(action.input.userId)}`),
      );
    },
    timeoutPath: (env, action) => ({ method: "DELETE", path: `/api/servers/${env.ctx.serverId}/timeouts/${String(action.input.userId)}` }),
  },
  {
    kind: "read",
    permission: Permission.BAN_MEMBERS,
    spec: {
      name: "list_bans",
      description: "List who is banned from this server (id, name, reason). unban_member takes these ids.",
      inputSchema: {
        type: "object",
        properties: { query: { type: "string", maxLength: 50, description: "Part of a name or handle." } },
        additionalProperties: false,
      },
    },
    async read(session, input) {
      const query = typeof input.query === "string" ? input.query.replace(/^@/, "").trim().toLowerCase() : "";
      const rows = await getPool().query<{ user_id: string; display_name: string; username: string | null; reason: string | null }>(
        `SELECT b.user_id, u.display_name, u.username, b.reason
           FROM server_bans b JOIN users u ON u.id = b.user_id
          WHERE b.server_id = $1
            AND ($2 = '' OR u.display_name ILIKE '%' || $2 || '%' OR u.username ILIKE '%' || $2 || '%')
          ORDER BY b.created_at DESC
          LIMIT 25`,
        [session.ctx.serverId, query],
      );
      return rows.rows.map((row) => ({
        id: row.user_id,
        name: row.display_name,
        ...(row.username ? { handle: `@${row.username}` } : {}),
        ...(row.reason ? { reason: row.reason } : {}),
      }));
    },
  },
  {
    kind: "write",
    permission: Permission.BAN_MEMBERS,
    spec: {
      name: "unban_member",
      description: "Stage lifting a ban, so the person can join again with an invite.",
      inputSchema: {
        type: "object",
        properties: { userId: { type: "string", description: "An id from list_bans." } },
        required: ["userId"],
        additionalProperties: false,
      },
    },
    async stage(session, input) {
      if (typeof input.userId !== "string" || !UUID_RE.test(input.userId)) {
        throw new ToolRefusal("userId must be an id from list_bans.");
      }
      const banned = await getPool().query<{ display_name: string; username: string | null }>(
        `SELECT u.display_name, u.username FROM server_bans b JOIN users u ON u.id = b.user_id
          WHERE b.server_id = $1 AND b.user_id = $2`,
        [session.ctx.serverId, input.userId],
      );
      const row = banned.rows[0];
      if (!row) {
        throw new ToolRefusal("That person is not banned here.");
      }
      return {
        tool: "unban_member",
        input: { bannedUserId: input.userId },
        label: `Desbanir ${row.username ? `@${row.username}` : row.display_name}`,
        destructive: false,
      };
    },
    async execute(env, action) {
      return routeResult(
        action,
        await env.invoke("DELETE", `/api/servers/${env.ctx.serverId}/bans/${String(action.input.bannedUserId)}`),
      );
    },
    timeoutPath: (env, action) => ({ method: "DELETE", path: `/api/servers/${env.ctx.serverId}/bans/${String(action.input.bannedUserId)}` }),
  },
];

const BY_NAME = new Map(TOOLS.map((tool) => [tool.spec.name, tool]));

/** `{ tools, unavailable }`: what to offer, and the names left out and why. */
/** create_channel without the forum type, for a server where forums are off. */
function withoutForumType(spec: BotToolSpec): BotToolSpec {
  const schema = spec.inputSchema as { properties: Record<string, { enum?: string[] }> };
  return {
    ...spec,
    inputSchema: {
      ...spec.inputSchema,
      properties: {
        ...schema.properties,
        type: { ...schema.properties.type, enum: ["text", "voice", "category"] },
      },
    },
  };
}

/**
 * The server permissions these tools need: what the bot's own role carries
 * (`bot-role.ts`). Reads and polls need none beyond @everyone's.
 */
export function botToolPermissions(tools: Iterable<string>): bigint {
  const on = new Set(tools);
  let bits = 0n;
  for (const tool of TOOLS) {
    if (tool.permission && on.has(tool.spec.name)) {
      bits |= tool.permission;
    }
  }
  return bits;
}

export async function toolsFor(
  ctx: BotActionContext,
): Promise<{ tools: BotToolSpec[]; unavailable: string[] }> {
  const [botPerms, requesterPerms] = await Promise.all([
    computeMemberPermissions(ctx.serverId, ctx.bot.id),
    computeMemberPermissions(ctx.serverId, ctx.requesterId),
  ]);
  const tools: BotToolSpec[] = [];
  const unavailable: string[] = [];
  const forumsOn = forumChannelsEnabled(ctx.serverId);
  for (const tool of TOOLS) {
    const offline = tool.offline?.(ctx.serverId) ?? null;
    if (!ctx.enabledTools.has(tool.spec.name)) {
      unavailable.push(`${tool.spec.name} (switched off for you by the server's staff)`);
    } else if (offline) {
      unavailable.push(`${tool.spec.name} (${offline})`);
    } else if (!tool.permission) {
      tools.push(tool.spec);
    } else if (!hasPermission(botPerms, tool.permission)) {
      unavailable.push(`${tool.spec.name} (you lack the permission on this server)`);
    } else if (!hasPermission(requesterPerms, tool.permission)) {
      unavailable.push(`${tool.spec.name} (the member asking lacks the permission)`);
    } else {
      tools.push(tool.spec.name === "create_channel" && !forumsOn ? withoutForumType(tool.spec) : tool.spec);
    }
  }
  if (!forumsOn) {
    unavailable.push("forum channels (turned off on this server)");
  }
  return { tools, unavailable };
}

/**
 * Answer one tool call from the model: run a read, or stage a write. Returns
 * the text the model sees. Never throws for a bad call; a refusal goes back to
 * the model so it can tell the member.
 */
export async function handleToolCall(
  session: ActionSession,
  name: string,
  input: Record<string, unknown>,
): Promise<{ content: string; isError: boolean }> {
  const tool = BY_NAME.get(name);
  if (!tool) {
    return { content: `Unknown tool ${name}.`, isError: true };
  }
  if (!session.ctx.enabledTools.has(name)) {
    return { content: `${name} is switched off for you by the server's staff.`, isError: true };
  }
  try {
    if (tool.kind === "read") {
      const result = await tool.read!(session, input);
      const json = JSON.stringify(result);
      return { content: json.length > 8000 ? `${json.slice(0, 8000)}…(truncated)` : json, isError: false };
    }
    if (tool.permission) {
      await requireRequesterServerPermission(session, tool.permission, permissionName(tool.permission));
    }
    if (session.staged.length >= BOT_ACTIONS_PER_REQUEST) {
      throw new ToolRefusal(`At most ${BOT_ACTIONS_PER_REQUEST} actions per request. Tell the member to ask for the rest separately.`);
    }
    const staged = await tool.stage!(session, input);
    session.staged.push(staged);
    return {
      content: JSON.stringify({
        staged: true,
        ...(staged.ref ? { ref: staged.ref } : {}),
        willDo: staged.label,
      }),
      isError: false,
    };
  } catch (error) {
    if (error instanceof ToolRefusal) {
      return { content: error.message, isError: true };
    }
    throw error;
  }
}

function permissionName(permission: bigint): string {
  if (permission === Permission.MANAGE_CHANNELS) return "Manage Channels";
  if (permission === Permission.MANAGE_MESSAGES) return "Manage Messages";
  if (permission === Permission.MANAGE_SERVER) return "Manage Server";
  if (permission === Permission.MODERATE_MEMBERS) return "Moderate Members";
  if (permission === Permission.KICK_MEMBERS) return "Kick Members";
  if (permission === Permission.BAN_MEMBERS) return "Ban Members";
  if (permission === Permission.CREATE_INVITE) return "Create Invite";
  return "required";
}

export function planNeedsConfirmation(actions: StagedAction[]): boolean {
  return actions.length > BOT_ACTIONS_WITHOUT_CONFIRM || actions.some((action) => action.destructive);
}

// -------------------------------------------------------------------- plans

export interface PlanRow {
  id: string;
  bot_id: string;
  server_id: string;
  channel_id: string;
  requester_id: string;
  run_id: string;
  message_id: string | null;
  actions: StagedAction[];
  status: "pending" | "executing" | "done" | "cancelled" | "expired";
  expires_at: Date;
}

export async function savePlan(
  ctx: BotActionContext,
  runId: string,
  actions: StagedAction[],
  status: "pending" | "executing",
): Promise<PlanRow | null> {
  const result = await getPool().query<PlanRow>(
    `INSERT INTO server_bot_plans
       (bot_id, server_id, channel_id, requester_id, run_id, actions, status, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, NOW() + make_interval(secs => $8))
     ON CONFLICT (run_id) DO NOTHING
     RETURNING *`,
    [ctx.botId, ctx.serverId, ctx.channelId, ctx.requesterId, runId, JSON.stringify(actions), status, BOT_PLAN_TTL_MS / 1000],
  );
  if (result.rows[0]) {
    await bumpBotStats(ctx.botId, { plans: 1 });
  }
  return result.rows[0] ?? null;
}

/** The bot message that shows the plan: its card follows the decision. */
export async function setPlanMessage(planId: string, messageId: string): Promise<void> {
  await getPool().query(`UPDATE server_bot_plans SET message_id = $2 WHERE id = $1`, [planId, messageId]);
}

export async function planForRun(runId: string): Promise<PlanRow | null> {
  const result = await getPool().query<PlanRow>(`SELECT * FROM server_bot_plans WHERE run_id = $1`, [runId]);
  return result.rows[0] ?? null;
}

export async function getPlan(planId: string): Promise<PlanRow | null> {
  const result = await getPool().query<PlanRow>(`SELECT * FROM server_bot_plans WHERE id = $1`, [planId]);
  return result.rows[0] ?? null;
}

/** The open plan a "sim" from this member here would answer, if any. */
export async function pendingPlanFor(
  botId: string,
  channelId: string,
  requesterId: string,
): Promise<string | null> {
  const result = await getPool().query<{ id: string }>(
    `SELECT id FROM server_bot_plans
      WHERE bot_id = $1 AND channel_id = $2 AND requester_id = $3
        AND status = 'pending' AND expires_at > NOW()
      ORDER BY created_at DESC LIMIT 1`,
    [botId, channelId, requesterId],
  );
  return result.rows[0]?.id ?? null;
}

/**
 * Take a pending plan for execution. Single use: the conditional UPDATE is the
 * claim, so a second "sim" (or a "sim" from anybody else) gets nothing.
 */
export async function claimPlan(planId: string, requesterId: string): Promise<PlanRow | null> {
  const result = await getPool().query<PlanRow>(
    `UPDATE server_bot_plans SET status = 'executing'
      WHERE id = $1 AND requester_id = $2 AND status = 'pending' AND expires_at > NOW()
      RETURNING *`,
    [planId, requesterId],
  );
  if (result.rows[0]) {
    await bumpBotStats(result.rows[0].bot_id, { plansConfirmed: 1 });
  }
  return result.rows[0] ?? null;
}

export async function cancelPlan(planId: string, requesterId: string): Promise<boolean> {
  const result = await getPool().query(
    `UPDATE server_bot_plans SET status = 'cancelled', finished_at = NOW()
      WHERE id = $1 AND requester_id = $2 AND status = 'pending'
      RETURNING bot_id`,
    [planId, requesterId],
  );
  const cancelled = result.rows[0] as { bot_id: string } | undefined;
  if (cancelled) {
    await bumpBotStats(cancelled.bot_id, { plansCancelled: 1 });
  }
  return cancelled !== undefined;
}

/** The message that asks for the "sim". Built from the stored actions only. */
export function describePlan(actions: StagedAction[], requesterTag: string): string {
  const lines = actions.map((action, index) => `${index + 1}. ${action.label}`);
  return [
    "Vou fazer isto:",
    ...lines,
    "",
    `Responda **sim** em até 5 minutos para confirmar, ou **não** para cancelar. Só ${requesterTag} pode confirmar.`,
  ].join("\n");
}

/**
 * Run a plan's steps in order, as the bot. Every step re-checks the
 * requester's key (minutes may have passed since staging), the bot's timeout
 * and the hourly cap, and writes its row before it runs. Returns one line per
 * step for the result message.
 */
export async function executePlan(
  plan: PlanRow,
  ctx: BotActionContext,
  /** Told before each step runs, for the "is working" indicator. */
  onStep?: (action: StagedAction) => void,
): Promise<{ lines: string[]; items: BotActionItem[] }> {
  const { invokeApiAsUser } = await import("../api/index.js");
  const done = await getPool().query<{ step: number; status: string; result: ExecResult | null }>(
    `SELECT step, status, result FROM server_bot_actions WHERE plan_id = $1`,
    [plan.id],
  );
  const previous = new Map(done.rows.map((row) => [row.step, row]));
  const refs = new Map<string, string>();
  const env: ExecEnv = {
    ctx,
    nonce: plan.id,
    refs,
    invoke: (method, path, body) => invokeApiAsUser(ctx.bot, method, path, body),
  };
  const session = new ActionSession(ctx);
  const lines: string[] = [];
  const items: BotActionItem[] = [];

  for (const [step, action] of plan.actions.entries()) {
    const earlier = previous.get(step);
    if (earlier) {
      // Ran (or may have run) under a worker that lost the plan. Never again.
      if (earlier.result?.createdId && action.ref) refs.set(action.ref, earlier.result.createdId);
      if (earlier.result) {
        lines.push(mark(earlier.result));
        items.push(itemOf(action, earlier.result));
      } else {
        lines.push(`? ${action.label}: não sei se terminou`);
        items.push({ tool: action.tool, label: action.label, status: "unknown", detail: "não sei se terminou" });
      }
      continue;
    }
    onStep?.(action);
    const tool = BY_NAME.get(action.tool);
    let result: ExecResult;
    if (!tool?.execute) {
      result = { ok: false, line: `${action.label}: ação desconhecida` };
    } else {
      result = await runStep(tool, env, session, plan, step, action);
    }
    if (result.createdId && action.ref) refs.set(action.ref, result.createdId);
    lines.push(mark(result));
    items.push(itemOf(action, result));
  }
  await getPool().query(
    `UPDATE server_bot_plans SET status = 'done', finished_at = NOW() WHERE id = $1`,
    [plan.id],
  );
  return { lines, items };
}

/** One card row: the stored label, and the reason apart when it failed. */
function itemOf(action: StagedAction, result: ExecResult): BotActionItem {
  const prefix = `${action.label}: `;
  const detail = result.ok
    ? (result.note ?? null)
    : result.line.startsWith(prefix)
      ? result.line.slice(prefix.length)
      : null;
  return {
    tool: action.tool,
    label: action.label,
    status: result.ok ? "ok" : "failed",
    detail: detail ? detail.slice(0, 200) : null,
  };
}

function mark(result: ExecResult): string {
  return `${result.ok ? "✓" : "✗"} ${result.line}`;
}

async function runStep(
  tool: ToolDef,
  env: ExecEnv,
  session: ActionSession,
  plan: PlanRow,
  step: number,
  action: StagedAction,
): Promise<ExecResult> {
  const { ctx } = env;
  if (!ctx.enabledTools.has(action.tool)) {
    return { ok: false, line: `${action.label}: essa ação foi desligada nas configurações do bot` };
  }
  // Minutes may have passed since staging: the requester's role, their rank
  // over a target member and their view of a target channel are asked again.
  if (tool.permission && !hasPermission(await session.requesterServerPerms(), tool.permission)) {
    return { ok: false, line: `${action.label}: ${ctx.requesterTag} não tem mais a permissão` };
  }
  try {
    if (typeof action.input.userId === "string") {
      await memberTarget(session, action.input.userId);
    }
    for (const key of ["channelId", "forumId", "categoryId"] as const) {
      const value = action.input[key];
      if (typeof value === "string" && UUID_RE.test(value) && !(await requesterSeesChannel(ctx, value))) {
        throw new ToolRefusal("channel");
      }
    }
  } catch (error) {
    if (error instanceof ToolRefusal) {
      return { ok: false, line: `${action.label}: ${ctx.requesterTag} não pode mais fazer isso` };
    }
    throw error;
  }
  const target = tool.timeoutPath?.(env, action);
  if (target && (await findTimeoutForRequest(ctx.bot.id, target.method, target.path))) {
    return { ok: false, line: `${action.label}: o bot está de castigo` };
  }
  const hour = await getPool().query<{ n: string }>(
    `SELECT COUNT(*) AS n FROM server_bot_actions
      WHERE bot_id = $1 AND created_at > NOW() - INTERVAL '1 hour'`,
    [ctx.botId],
  );
  if (Number(hour.rows[0]?.n ?? 0) >= botActionsPerHour()) {
    return { ok: false, line: `${action.label}: limite de ações por hora atingido` };
  }
  const claimed = await getPool().query(
    `INSERT INTO server_bot_actions (plan_id, step, bot_id, tool, status)
     VALUES ($1, $2, $3, $4, 'running')
     ON CONFLICT (plan_id, step) DO NOTHING`,
    [plan.id, step, ctx.botId, action.tool],
  );
  if ((claimed.rowCount ?? 0) === 0) {
    return { ok: false, line: `${action.label}: já em andamento` };
  }
  let result: ExecResult;
  try {
    const stepEnv = { ...env, nonce: `${plan.id}:${step}` };
    result = await runWithBotRequester(ctx.requesterTag, () => tool.execute!(stepEnv, action));
  } catch (error) {
    logEvent("bots.actionError", {
      planId: plan.id,
      step,
      tool: action.tool,
      message: error instanceof Error ? error.message.slice(0, 200) : String(error),
    });
    result = { ok: false, line: `${action.label}: erro` };
  }
  await getPool().query(
    `UPDATE server_bot_actions SET status = $3, result = $4 WHERE plan_id = $1 AND step = $2`,
    [plan.id, step, result.ok ? "done" : "failed", JSON.stringify(result)],
  );
  logEvent("bots.action", { planId: plan.id, step, tool: action.tool, ok: result.ok });
  await bumpBotStats(ctx.botId, result.ok ? { actionsDone: 1 } : { actionsFailed: 1 });
  await bumpBotTool(ctx.botId, action.tool, result.ok);
  return result;
}

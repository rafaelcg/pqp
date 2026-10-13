import { randomUUID } from "node:crypto";
import {
  BOT_BASE_FACES,
  BOT_COLORS,
  BOT_DEFAULT_COLOR,
  BOT_DEFAULT_FACE,
  botFaceAvatarPath,
  type BotBaseFace,
  type BotColor,
  extractMentionUsernames,
  hasPermission,
  Permission,
  type BotNotice,
  type BotNoticeReason,
  SERVER_BOT_DEFAULT_TOOLS,
  SERVER_BOT_TOOLS,
  SERVER_BOTS_MAX,
  type ServerBotDto,
  type ServerBotTool,
} from "@pqp/shared";
import { getPool, type DbUser } from "../db.js";
import { isEnabled } from "../lib/flags.js";
import { deriveHandle, slugifyUsername } from "./users.js";
import { invalidateServerAudience } from "./servers.js";
import { botDay } from "./bot-stats.js";

/**
 * Server bots: the data and the trigger. What a bot SAYS is in
 * `bot-runner.ts`; this file decides who a bot is and when it is asked.
 *
 * A bot is a character account (`users.is_character`) that is a member of
 * exactly one server, plus a `server_bots` row. Being a character is what gets
 * it the bot mark on every client, no DMs, no voice, no friend requests and
 * the outgoing-webhook skip, all without a new flag to teach three clients.
 * Nothing authenticates as it: there is no token, and only this process's own
 * worker posts in its name.
 */

/** The LISTEN channel the enqueue NOTIFYs and the runner's poller listens on. */
export const BOT_RUNS_CHANNEL = "pqp_bot_run_due";

/** Replies one server's bot may post per São Paulo day. */
export function botRepliesPerDay(): number {
  const raw = Number(process.env.BOTS_REPLIES_PER_SERVER_DAY);
  return Number.isInteger(raw) && raw >= 0 ? raw : 200;
}

/** Questions one member may ask one bot per hour. */
export function botRunsPerRequesterHour(): number {
  const raw = Number(process.env.BOTS_RUNS_PER_MEMBER_HOUR);
  return Number.isInteger(raw) && raw >= 0 ? raw : 20;
}

export class BotError extends Error {
  constructor(
    readonly code: "limit" | "missing" | "channel" | "name",
    message: string = code,
  ) {
    super(message);
  }
}

interface BotRow {
  id: string;
  server_id: string;
  user_id: string;
  persona: string;
  knowledge: string;
  channel_ids: string[];
  enabled: boolean;
  answer_to_name: boolean;
  model: string | null;
  tools: string[] | null;
  role_id: string | null;
  color: string;
  face: string;
  created_at: Date;
  display_name: string;
  username: string;
  avatar_url: string | null;
  custom_status: string | null;
}

const BOT_SELECT = `
  SELECT b.id, b.server_id, b.user_id, b.persona, b.knowledge, b.channel_ids,
         b.enabled, b.answer_to_name, b.model, b.tools, b.role_id, b.color, b.face, b.created_at,
         u.display_name, u.username, u.avatar_url, u.custom_status
    FROM server_bots b
    JOIN users u ON u.id = b.user_id`;

function toDto(row: BotRow, repliesToday: number): ServerBotDto {
  return {
    id: row.id,
    serverId: row.server_id,
    userId: row.user_id,
    name: row.display_name,
    username: row.username,
    avatarUrl: row.avatar_url,
    color: asColor(row.color),
    face: asFace(row.face),
    tagline: row.custom_status,
    persona: row.persona,
    knowledge: row.knowledge,
    channelIds: row.channel_ids,
    enabled: row.enabled,
    answerToName: row.answer_to_name,
    model: row.model,
    tools: normalizeTools(row.tools),
    createdAt: row.created_at.toISOString(),
    roleId: row.role_id,
    repliesToday,
    repliesPerDay: botRepliesPerDay(),
  };
}

function asColor(value: string): BotColor {
  return (BOT_COLORS as readonly string[]).includes(value) ? (value as BotColor) : BOT_DEFAULT_COLOR;
}

function asFace(value: string): BotBaseFace {
  return (BOT_BASE_FACES as readonly string[]).includes(value) ? (value as BotBaseFace) : BOT_DEFAULT_FACE;
}

async function repliesToday(serverId: string): Promise<number> {
  const result = await getPool().query<{ replies: number }>(
    `SELECT replies FROM server_bot_usage_daily
      WHERE day = $2::date AND server_id = $1`,
    [serverId, botDay()],
  );
  return result.rows[0]?.replies ?? 0;
}

export async function listServerBots(serverId: string): Promise<ServerBotDto[]> {
  const [rows, today] = await Promise.all([
    getPool().query<BotRow>(`${BOT_SELECT} WHERE b.server_id = $1 ORDER BY b.created_at`, [
      serverId,
    ]),
    repliesToday(serverId),
  ]);
  return rows.rows.map((row) => toDto(row, today));
}

export async function getServerBot(
  serverId: string,
  botId: string,
): Promise<ServerBotDto | null> {
  const result = await getPool().query<BotRow>(
    `${BOT_SELECT} WHERE b.server_id = $1 AND b.id = $2`,
    [serverId, botId],
  );
  const row = result.rows[0];
  return row ? toDto(row, await repliesToday(serverId)) : null;
}

/**
 * Only this server's own text channels, threads' parents included, may be on
 * the list. Anything else is refused rather than silently dropped, so the
 * settings page never shows a tick the bot will not honour.
 */
async function requireServerChannels(
  serverId: string,
  channelIds: string[],
): Promise<string[]> {
  const unique = [...new Set(channelIds)];
  if (unique.length === 0) {
    return [];
  }
  const result = await getPool().query<{ id: string }>(
    `SELECT id FROM channels
      WHERE server_id = $1 AND id = ANY($2::uuid[])
        AND type IN ('text', 'voice', 'watch_party', 'forum')`,
    [serverId, unique],
  );
  if (result.rows.length !== unique.length) {
    throw new BotError("channel");
  }
  return unique;
}

/**
 * A handle nobody in this server already answers to. `MENTION_PATTERN` reads
 * the bare username, which is unique only with its discriminator, so a bot
 * called "Caio" beside a member `caio#2160` would wake on every mention of
 * the person. The `_bot` suffix makes that rare; this check makes it absent
 * at creation time.
 */
/**
 * The name part of a bot's handle. Cut to leave room for the suffix, so `_bot`
 * always survives `slugifyUsername`'s 32-character cut; a name with nothing
 * sluggable (all emoji) has an empty stem and becomes plain `bot`.
 */
/**
 * The stored list, or the default set for NULL. Names no longer in the
 * catalogue are dropped, so a retired tool cannot linger switched on.
 */
export function normalizeTools(stored: string[] | null): ServerBotTool[] {
  if (stored === null) {
    return [...SERVER_BOT_DEFAULT_TOOLS];
  }
  const known = new Set<string>(SERVER_BOT_TOOLS);
  return stored.filter((tool): tool is ServerBotTool => known.has(tool));
}

function botHandleStem(name: string): string {
  if (!/[a-z0-9]/i.test(name.normalize("NFD"))) {
    return "";
  }
  return slugifyUsername(name).slice(0, 24).replace(/_+$/, "");
}

async function allocateBotHandle(
  serverId: string,
  name: string,
): Promise<{ username: string; discriminator: string }> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const stem = botHandleStem(name);
    const seed =
      attempt === 0
        ? `${stem} bot`
        : `${stem} bot ${Math.random().toString(36).slice(2, 5)}`;
    const handle = await deriveHandle(seed.trim());
    const clash = await getPool().query(
      `SELECT 1 FROM server_members m JOIN users u ON u.id = m.user_id
        WHERE m.server_id = $1 AND lower(u.username) = lower($2) LIMIT 1`,
      [serverId, handle.username],
    );
    if (clash.rows.length === 0) {
      return handle;
    }
  }
  throw new BotError("name");
}

export async function createServerBot(input: {
  serverId: string;
  createdBy: string;
  name: string;
  persona: string;
  knowledge: string;
  channelIds: string[];
  answerToName?: boolean;
  model?: string | null;
  tools?: string[];
  color?: BotColor;
  face?: BotBaseFace;
  tagline?: string | null;
}): Promise<ServerBotDto> {
  const color = input.color ?? BOT_DEFAULT_COLOR;
  const face = input.face ?? BOT_DEFAULT_FACE;
  const channelIds = await requireServerChannels(input.serverId, input.channelIds);
  const { username, discriminator } = await allocateBotHandle(input.serverId, input.name);
  const client = await getPool().connect();
  let botId: string;
  try {
    await client.query("BEGIN");
    // Serialise creates per server so two parallel clicks cannot both pass
    // the count. The unique index would catch it too, as a 500.
    await client.query(`SELECT 1 FROM servers WHERE id = $1 FOR UPDATE`, [input.serverId]);
    const count = await client.query<{ n: number }>(
      `SELECT COUNT(*)::int AS n FROM server_bots WHERE server_id = $1`,
      [input.serverId],
    );
    if ((count.rows[0]?.n ?? 0) >= SERVER_BOTS_MAX) {
      throw new BotError("limit");
    }
    // The same gates `createCharacterAccount` pre-clears: no date of birth,
    // no browser, so the age check and onboarding are written now.
    const user = await client.query<{ id: string }>(
      `INSERT INTO users (
         clerk_id, display_name, username, discriminator,
         is_character, dm_privacy, age_checked_at, age_check_passed,
         avatar_url, custom_status
       )
       VALUES ($1, $2, $3, $4, TRUE, 'nobody', NOW(), TRUE, $5, $6)
       RETURNING id`,
      [
        `bot:${randomUUID()}`,
        input.name,
        username,
        discriminator,
        botFaceAvatarPath(color, face),
        input.tagline ?? null,
      ],
    );
    const userId = user.rows[0]!.id;
    await client.query(
      `INSERT INTO user_preferences (user_id, settings)
       VALUES ($1, jsonb_build_object('onboardedAt', to_char(NOW() AT TIME ZONE 'UTC',
               'YYYY-MM-DD"T"HH24:MI:SS"Z"')))
       ON CONFLICT (user_id) DO NOTHING`,
      [userId],
    );
    await client.query(
      `INSERT INTO server_members (server_id, user_id, role) VALUES ($1, $2, 'member')`,
      [input.serverId, userId],
    );
    const bot = await client.query<{ id: string }>(
      `INSERT INTO server_bots
         (server_id, user_id, persona, knowledge, channel_ids, answer_to_name, model, tools, created_by,
          color, face)
       VALUES ($1, $2, $3, $4, $5::uuid[], $6, $7, $8::text[], $9, $10, $11)
       RETURNING id`,
      [
        input.serverId,
        userId,
        input.persona,
        input.knowledge,
        channelIds,
        input.answerToName ?? false,
        input.model ?? null,
        input.tools ?? null,
        input.createdBy,
        color,
        face,
      ],
    );
    botId = bot.rows[0]!.id;
    await client.query("COMMIT");
    invalidateServerAudience(input.serverId, { joinedUserId: userId });
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
  forgetTriggerBot(input.serverId);
  return (await getServerBot(input.serverId, botId))!;
}

export async function updateServerBot(input: {
  serverId: string;
  botId: string;
  name?: string;
  persona?: string;
  knowledge?: string;
  channelIds?: string[];
  enabled?: boolean;
  answerToName?: boolean;
  /** `null` clears the pick; absent leaves it. */
  model?: string | null;
  tools?: string[];
  color?: BotColor;
  face?: BotBaseFace;
  /** `null` clears it; absent leaves it. */
  tagline?: string | null;
}): Promise<{ bot: ServerBotDto; before: ServerBotDto; renamed: boolean; restyled: boolean } | null> {
  const before = await getServerBot(input.serverId, input.botId);
  if (!before) {
    return null;
  }
  const channelIds =
    input.channelIds === undefined
      ? undefined
      : await requireServerChannels(input.serverId, input.channelIds);
  await getPool().query(
    `UPDATE server_bots
        SET persona = COALESCE($3, persona),
            knowledge = COALESCE($4, knowledge),
            channel_ids = COALESCE($5::uuid[], channel_ids),
            enabled = COALESCE($6, enabled),
            answer_to_name = COALESCE($7, answer_to_name),
            model = CASE WHEN $8::boolean THEN $9 ELSE model END,
            tools = COALESCE($10::text[], tools),
            color = COALESCE($11, color),
            face = COALESCE($12, face),
            updated_at = NOW()
      WHERE server_id = $1 AND id = $2`,
    [
      input.serverId,
      input.botId,
      input.persona ?? null,
      input.knowledge ?? null,
      channelIds ?? null,
      input.enabled ?? null,
      input.answerToName ?? null,
      input.model !== undefined,
      input.model ?? null,
      input.tools ?? null,
      input.color ?? null,
      input.face ?? null,
    ],
  );
  // A new colour or face is a new picture, and a new line under its name:
  // the caller sends the profile frame that repaints them.
  const color = input.color ?? before.color;
  const face = input.face ?? before.face;
  const restyled =
    color !== before.color ||
    face !== before.face ||
    (input.tagline !== undefined && input.tagline !== before.tagline);
  if (restyled) {
    await getPool().query(
      `UPDATE users
          SET avatar_url = $2,
              custom_status = CASE WHEN $3::boolean THEN $4 ELSE custom_status END
        WHERE id = $1`,
      [before.userId, botFaceAvatarPath(color, face), input.tagline !== undefined, input.tagline ?? null],
    );
  }
  // A rename moves the handle too: people call the bot by the name they see,
  // so "Julius" answers to @julius_bot. The old handle stops working, which
  // for a bot is the expected outcome of renaming it.
  let renamed = false;
  if (input.name !== undefined && input.name !== before.name) {
    const sameHandle = botHandleStem(input.name) === botHandleStem(before.name);
    const handle = sameHandle ? null : await allocateBotHandle(input.serverId, input.name);
    await getPool().query(
      `UPDATE users
          SET display_name = $2,
              username = COALESCE($3, username),
              discriminator = COALESCE($4, discriminator)
        WHERE id = $1`,
      [before.userId, input.name, handle?.username ?? null, handle?.discriminator ?? null],
    );
    renamed = true;
  }
  forgetTriggerBot(input.serverId);
  const bot = await getServerBot(input.serverId, input.botId);
  return bot ? { bot, before, renamed, restyled } : null;
}

/**
 * The bot leaves the server and its row goes. Its account stays, because its
 * past messages are authored by it and a deleted author is a hole in the
 * history; with no membership it can no longer post anywhere.
 */
export async function deleteServerBot(
  serverId: string,
  botId: string,
): Promise<ServerBotDto | null> {
  const before = await getServerBot(serverId, botId);
  if (!before) {
    return null;
  }
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    await client.query(`DELETE FROM server_bots WHERE server_id = $1 AND id = $2`, [
      serverId,
      botId,
    ]);
    await client.query(`DELETE FROM server_members WHERE server_id = $1 AND user_id = $2`, [
      serverId,
      before.userId,
    ]);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
  invalidateServerAudience(serverId);
  forgetTriggerBot(serverId);
  return before;
}

/** The member accounts of this server's enabled bots, for the member list. */
export async function listAnsweringBotUserIds(serverId: string): Promise<Set<string>> {
  const result = await getPool().query<{ user_id: string }>(
    `SELECT user_id FROM server_bots WHERE server_id = $1 AND enabled`,
    [serverId],
  );
  return new Set(result.rows.map((row) => row.user_id));
}

// ------------------------------------------------------------- the trigger

interface TriggerBot {
  id: string;
  userId: string;
  username: string;
  channelIds: Set<string>;
  /** Set when the bot also answers its name: the name, folded for matching. */
  name: string | null;
  /** As members see it, for a notice. */
  displayName: string;
}

/**
 * The per-server answer to "is there a bot to wake", cached because the
 * trigger runs on every human message. 30 s is how stale a sibling instance
 * may be after an edit on another; this instance forgets on its own writes.
 */
const TRIGGER_TTL_MS = 30_000;
const triggerCache = new Map<string, { bot: TriggerBot | null; at: number }>();

function forgetTriggerBot(serverId: string): void {
  triggerCache.delete(serverId);
}

/** Tests only. */
export function resetBotTriggerCacheForTests(): void {
  triggerCache.clear();
}

async function triggerBotFor(serverId: string): Promise<TriggerBot | null> {
  const cached = triggerCache.get(serverId);
  if (cached && Date.now() - cached.at < TRIGGER_TTL_MS) {
    return cached.bot;
  }
  const result = await getPool().query<{
    id: string;
    user_id: string;
    username: string;
    channel_ids: string[];
    display_name: string;
    answer_to_name: boolean;
  }>(
    `SELECT b.id, b.user_id, u.username, b.channel_ids, u.display_name, b.answer_to_name
       FROM server_bots b JOIN users u ON u.id = b.user_id
      WHERE b.server_id = $1 AND b.enabled
      ORDER BY b.created_at LIMIT 1`,
    [serverId],
  );
  const row = result.rows[0];
  const bot = row
    ? {
        id: row.id,
        userId: row.user_id,
        username: row.username.toLowerCase(),
        channelIds: new Set(row.channel_ids),
        name: row.answer_to_name ? foldForMatch(row.display_name) : null,
        displayName: row.display_name,
      }
    : null;
  triggerCache.set(serverId, { bot, at: Date.now() });
  return bot;
}

/** Lower case, accents gone: "Július" and "julius" are the same word here. */
export function foldForMatch(text: string): string {
  return text.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().trim();
}

/**
 * The name as a whole word or phrase: "Julius, oi" and "valeu julius!" call
 * it, "juliusmente" does not. Letters and digits on either side break the
 * match; punctuation, spaces and the edges of the message do not.
 */
export function saysName(body: string, foldedName: string): boolean {
  if (foldedName.length < 2) {
    return false;
  }
  const text = foldForMatch(body);
  let from = 0;
  for (;;) {
    const at = text.indexOf(foldedName, from);
    if (at < 0) {
      return false;
    }
    const before = text[at - 1];
    const after = text[at + foldedName.length];
    const isWordChar = (ch: string | undefined) => !!ch && /[\p{L}\p{N}_]/u.test(ch);
    if (!isWordChar(before) && !isWordChar(after)) {
      return true;
    }
    from = at + 1;
  }
}

/**
 * A plan card's Confirm or Cancel button. Only the member who asked, only
 * while the plan waits; the run it queues does the rest, exactly like a typed
 * "sim" or "não", and replies to the plan's own message.
 */
export async function queuePlanDecision(input: {
  planId: string;
  userId: string;
  decision: "yes" | "no";
}): Promise<"queued" | "missing" | "not-yours" | "decided" | "expired" | "off"> {
  const found = await getPool().query<{
    bot_id: string;
    server_id: string;
    channel_id: string;
    requester_id: string;
    message_id: string | null;
    status: string;
    expired: boolean;
  }>(
    `SELECT bot_id, server_id, channel_id, requester_id, message_id, status,
            expires_at <= NOW() AS expired
       FROM server_bot_plans WHERE id = $1`,
    [input.planId],
  );
  const plan = found.rows[0];
  if (!plan || !plan.message_id) {
    return "missing";
  }
  if (plan.requester_id !== input.userId) {
    return "not-yours";
  }
  if (!isEnabled("custom_bots", { serverId: plan.server_id })) {
    return "off";
  }
  if (plan.status !== "pending") {
    return "decided";
  }
  if (plan.expired) {
    return "expired";
  }
  // Keyed on the plan's message, so the first press wins and a second one,
  // or a Cancel after a Confirm, inserts nothing.
  const queued = await getPool().query(
    `WITH run AS (
       INSERT INTO server_bot_runs (bot_id, channel_id, message_id, requester_id, plan_id, decision, trigger)
       VALUES ($1, $2, $3, $4, $5, $6, 'decision')
       ON CONFLICT (bot_id, message_id) DO NOTHING
       RETURNING id
     )
     SELECT pg_notify($7, '') FROM run`,
    [plan.bot_id, plan.channel_id, plan.message_id, input.userId, input.planId, input.decision, BOT_RUNS_CHANNEL],
  );
  return (queued.rowCount ?? 0) > 0 ? "queued" : "decided";
}

/**
 * Questions one member may have waiting at once: the one being answered and
 * one more, which runs after it. A third is not answered.
 */
export const BOT_OPEN_RUNS_PER_REQUESTER = 2;

/** How long after an answer the member's next message counts as a follow-up. */
export const BOT_FOLLOW_UP_SECONDS = 180;

export interface BotTriggerInput {
  author: Pick<DbUser, "id" | "is_character">;
  /** The message carries attachments: a voice note or a photo is content too. */
  hasAttachments?: boolean;
  channel: {
    id: string;
    kind: string;
    type?: string | null;
    server_id?: string | null;
    parent_id?: string | null;
  } | null;
  messageId: string;
  body: string;
  /** The author of the message this one replies to, when it is a reply. */
  repliedToUserId: string | null;
}

/**
 * Queue a reply when a person mentions the server's bot or replies to it, in
 * a channel the bot answers in. Ordered cheapest first because it runs on
 * every message: a character author or a server with the flag off costs no
 * database at all. A thread counts as its parent channel.
 *
 * Never throws into the send: the caller wraps it, and a failure here means
 * no answer, never a message that looks unsent.
 */
// Deliberately narrow. A pending plan may be a ban, so a casual "ok" or "pode"
// said to somebody else in the five minutes must not run it. The plan message
// asks for **sim** in so many words.
const YES = new Set(["sim", "confirmo", "confirmar"]);
const NO = new Set(["nao", "cancela", "cancelar"]);

/**
 * "sim" / "não" answering a plan, said alone. The bot's own @handle and
 * punctuation around it are fine; a mention of anybody else means the word
 * was said to them.
 */
export function confirmationWord(body: string, botUsername?: string | null): "yes" | "no" | null {
  const own = botUsername ? new RegExp(`@${botUsername}\\b`, "gi") : null;
  const rest = own ? body.replace(own, " ") : body;
  if (/@[A-Za-z0-9_]/.test(rest)) {
    return null;
  }
  const word = foldForMatch(rest)
    .replace(/[^a-z]+/g, " ")
    .trim();
  if (YES.has(word)) return "yes";
  if (NO.has(word)) return "no";
  return null;
}

export async function maybeQueueBotReply(input: BotTriggerInput): Promise<boolean> {
  if (input.author.is_character) {
    return false;
  }
  const channel = input.channel;
  if (!channel || channel.kind !== "server" || !channel.server_id) {
    return false;
  }
  if (!isEnabled("custom_bots", { serverId: channel.server_id })) {
    return false;
  }
  const bot = await triggerBotFor(channel.server_id);
  if (!bot || bot.userId === input.author.id) {
    return false;
  }
  const answersHere =
    bot.channelIds.has(channel.id) ||
    (channel.type === "thread" && !!channel.parent_id && bot.channelIds.has(channel.parent_id));
  if (!answersHere) {
    return false;
  }
  // A "sim" or "não" from the member a plan is waiting on. Only theirs: the
  // lookup is by author, so anybody else's "sim" matches nothing.
  if (confirmationWord(input.body, bot.username)) {
    const { pendingPlanFor } = await import("./bot-actions.js");
    const planId = await pendingPlanFor(bot.id, channel.id, input.author.id);
    if (planId) {
      const queued = await getPool().query(
        `WITH run AS (
           INSERT INTO server_bot_runs (bot_id, channel_id, message_id, requester_id, plan_id, trigger)
           VALUES ($1, $2, $3, $4, $5, 'decision')
           ON CONFLICT (bot_id, message_id) DO NOTHING
           RETURNING id
         )
         SELECT pg_notify($6, '') FROM run`,
        [bot.id, channel.id, input.messageId, input.author.id, planId, BOT_RUNS_CHANNEL],
      );
      return (queued.rowCount ?? 0) > 0;
    }
  }
  const mentioned = extractMentionUsernames(input.body);
  const called =
    input.repliedToUserId === bot.userId ||
    mentioned.includes(bot.username) ||
    (bot.name !== null && saysName(input.body, bot.name));
  // Not called by name, but maybe still talking to the bot: a follow-up is the
  // next message from somebody the bot just answered here. A message aimed at
  // somebody else (a mention, a reply to another person) is not one. The
  // window itself is checked in the insert below, against the runs table, so
  // it holds across machines; the model may still answer SKIP.
  const followUp =
    !called &&
    mentioned.length === 0 &&
    input.repliedToUserId === null &&
    (input.body.trim().length > 0 || input.hasAttachments === true);
  if (!called && !followUp) {
    return false;
  }
  // Two open questions per person (the second waits for the first), and a
  // few per hour: a member mashing the mention must not spend the server's
  // day, or flood the channel with answers. The server's owner and admins
  // have no hourly limit. One statement, so the limits hold across machines;
  // it also says which one stopped the question, for the notice.
  const exempt = await bypassesMemberLimit(channel.server_id, input.author.id);
  const result = await getPool().query<{
    queued: boolean;
    open_runs: number;
    hour_runs: number;
    hour_oldest: Date | null;
    window_open: boolean;
  }>(
    `WITH stats AS (
       SELECT
         (SELECT COUNT(*)::int FROM server_bot_runs
           WHERE bot_id = $1 AND requester_id = $4
             AND status IN ('queued', 'running')) AS open_runs,
         (SELECT COUNT(*)::int FROM server_bot_runs
           WHERE bot_id = $1 AND requester_id = $4
             AND created_at > NOW() - INTERVAL '1 hour') AS hour_runs,
         (SELECT MIN(created_at) FROM server_bot_runs
           WHERE bot_id = $1 AND requester_id = $4
             AND created_at > NOW() - INTERVAL '1 hour') AS hour_oldest,
         -- A follow-up needs the member's latest run here to have been
         -- answered, recently. A SKIP closes the window.
         (NOT $7 OR EXISTS (
           SELECT 1 FROM (
             SELECT status, finished_at FROM server_bot_runs
              WHERE bot_id = $1 AND requester_id = $4 AND channel_id = $2
              ORDER BY created_at DESC LIMIT 1
           ) latest
            WHERE latest.status = 'done'
              AND latest.finished_at > NOW() - make_interval(secs => $8))) AS window_open
     ),
     run AS (
       INSERT INTO server_bot_runs (bot_id, channel_id, message_id, requester_id, follow_up, trigger)
       SELECT $1, $2, $3, $4, $7, $11 FROM stats
        WHERE stats.open_runs < $9
          AND ($10 OR stats.hour_runs < $6)
          AND stats.window_open
       ON CONFLICT (bot_id, message_id) DO NOTHING
       RETURNING id
     ),
     notified AS (SELECT pg_notify($5, '') FROM run)
     SELECT EXISTS (SELECT 1 FROM run) AS queued,
            (SELECT COUNT(*) FROM notified) >= 0 AS _notified,
            stats.*
       FROM stats`,
    [
      bot.id,
      channel.id,
      input.messageId,
      input.author.id,
      BOT_RUNS_CHANNEL,
      botRunsPerRequesterHour(),
      followUp,
      BOT_FOLLOW_UP_SECONDS,
      BOT_OPEN_RUNS_PER_REQUESTER,
      exempt,
      followUp
        ? "follow_up"
        : input.repliedToUserId === bot.userId
          ? "reply"
          : mentioned.includes(bot.username)
            ? "mention"
            : "name",
    ],
  );
  const row = result.rows[0];
  if (!row || row.queued) {
    return !!row?.queued;
  }
  // A follow-up outside its window was never meant for the bot: no notice.
  if (!row.window_open) {
    return false;
  }
  const limit = botRunsPerRequesterHour();
  if (row.open_runs >= BOT_OPEN_RUNS_PER_REQUESTER) {
    await sendBotNotice(channel.id, bot, input.author.id, "busy", null, null);
  } else if (!exempt && row.hour_runs >= limit) {
    const retryAt = row.hour_oldest ? new Date(row.hour_oldest.getTime() + 3_600_000) : null;
    await sendBotNotice(channel.id, bot, input.author.id, "member-hour", limit, retryAt);
  }
  return false;
}

/**
 * The server's owner and its administrators: they set the bot up and pay
 * nothing for it, so the per-member hourly limit does not apply to them. The
 * server's daily answers and the deployment's spend ceiling still do.
 */
async function bypassesMemberLimit(serverId: string, userId: string): Promise<boolean> {
  const { computeMemberPermissions } = await import("./permissions.js");
  const perms = await computeMemberPermissions(serverId, userId);
  return hasPermission(perms, Permission.ADMINISTRATOR);
}

let noticeSinkForTests: ((frame: BotNotice, userId: string) => void) | null = null;

/** Tests read the notices here instead of over a socket. */
export function setBotNoticeSinkForTests(sink: typeof noticeSinkForTests): void {
  noticeSinkForTests = sink;
}

/** Why the bot stayed quiet, told to that member only. */
export async function sendBotNotice(
  channelId: string,
  bot: { userId: string; displayName: string },
  userId: string,
  reason: BotNoticeReason,
  limit: number | null,
  retryAt: Date | null,
): Promise<void> {
  const frame: BotNotice = {
    type: "bot-notice",
    channelId,
    botUserId: bot.userId,
    botName: bot.displayName,
    reason,
    limit,
    retryAt: retryAt ? retryAt.toISOString() : null,
  };
  noticeSinkForTests?.(frame, userId);
  const { notifyBotNotice } = await import("../ws/chat.js");
  notifyBotNotice(frame, userId);
}

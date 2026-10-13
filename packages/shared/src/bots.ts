import { z } from "zod";
import { BOT_BASE_FACES, BOT_COLORS, type BotBaseFace, type BotColor } from "./bot-face.js";
import { customStatusSchema } from "./status.js";

/**
 * Server bots: an AI member a server's staff create, name and brief, which
 * answers when somebody mentions it or replies to it. pqp runs the model; the
 * server brings only the persona and the knowledge. See docs/plans/CUSTOM_BOTS.md.
 */

/** One bot per server while pqp pays for every reply. */
export const SERVER_BOTS_MAX = 1;

export const SERVER_BOT_NAME_MAX = 32;
export const SERVER_BOT_PERSONA_MAX = 2000;
export const SERVER_BOT_KNOWLEDGE_MAX = 20000;
/** The channels a bot may answer in. Empty means it answers nowhere. */
export const SERVER_BOT_CHANNELS_MAX = 50;

/**
 * What a bot may do, grouped the way the settings page shows them. Each one is
 * a switch staff turn on or off per bot; the bot still needs the permission
 * on its role, and so does the member asking. Moderation starts off.
 */
export const SERVER_BOT_TOOL_GROUPS = {
  // Not tools the model calls: what it may take in. Images cost input tokens;
  // a voice note is read through its transcript, when the server has those on.
  senses: ["see_images", "hear_voice_notes"],
  lookup: ["list_channels", "list_members", "read_channel", "list_forum_posts", "read_poll"],
  channels: ["create_channel", "edit_channel", "move_channel", "delete_channel"],
  posting: [
    "post_message",
    "pin_message",
    "create_thread",
    "create_forum_post",
    "reply_forum_post",
    "create_poll",
    "vote_poll",
    "create_bau_post",
    "create_invite",
  ],
  moderation: [
    "delete_message",
    "timeout_member",
    "remove_timeout",
    "kick_member",
    "ban_member",
    "list_bans",
    "unban_member",
  ],
} as const;
export type ServerBotToolGroup = keyof typeof SERVER_BOT_TOOL_GROUPS;
export const SERVER_BOT_TOOLS = Object.values(SERVER_BOT_TOOL_GROUPS).flat();
export type ServerBotTool = (typeof SERVER_BOT_TOOL_GROUPS)[ServerBotToolGroup][number];
export const SERVER_BOT_DEFAULT_TOOLS: ServerBotTool[] = SERVER_BOT_TOOLS.filter(
  (tool) => !(SERVER_BOT_TOOL_GROUPS.moderation as readonly string[]).includes(tool),
);
const botToolsSchema = z
  .array(z.enum(SERVER_BOT_TOOLS as [ServerBotTool, ...ServerBotTool[]]))
  .max(SERVER_BOT_TOOLS.length);

const botName = z
  .string()
  .trim()
  .min(2)
  .max(SERVER_BOT_NAME_MAX);

export const createServerBotSchema = z.object({
  name: botName,
  persona: z.string().max(SERVER_BOT_PERSONA_MAX).default(""),
  knowledge: z.string().max(SERVER_BOT_KNOWLEDGE_MAX).default(""),
  channelIds: z.array(z.string().uuid()).max(SERVER_BOT_CHANNELS_MAX).default([]),
  answerToName: z.boolean().default(false),
  model: z.string().max(200).nullable().optional(),
  tools: botToolsSchema.optional(),
  color: z.enum(BOT_COLORS).optional(),
  face: z.enum(BOT_BASE_FACES).optional(),
  /** The line under its name in the member list (its recado). */
  tagline: customStatusSchema.nullable().optional(),
});
export type CreateServerBotRequest = z.input<typeof createServerBotSchema>;

export const updateServerBotSchema = z.object({
  name: botName.optional(),
  persona: z.string().max(SERVER_BOT_PERSONA_MAX).optional(),
  knowledge: z.string().max(SERVER_BOT_KNOWLEDGE_MAX).optional(),
  channelIds: z.array(z.string().uuid()).max(SERVER_BOT_CHANNELS_MAX).optional(),
  enabled: z.boolean().optional(),
  answerToName: z.boolean().optional(),
  /** `null` goes back to the default model. */
  model: z.string().max(200).nullable().optional(),
  tools: botToolsSchema.optional(),
  color: z.enum(BOT_COLORS).optional(),
  face: z.enum(BOT_BASE_FACES).optional(),
  /** `null` clears it. */
  tagline: customStatusSchema.nullable().optional(),
});
export type UpdateServerBotRequest = z.input<typeof updateServerBotSchema>;

export interface ServerBotDto {
  id: string;
  serverId: string;
  /** The bot's member account: what its messages are authored by. */
  userId: string;
  name: string;
  /** What people type after `@` to call it. Follows the name on a rename. */
  username: string;
  /** Its Breu PNG (`/api/bot-faces/...`): the phone apps draw this, the web client draws `color` and `face`. */
  avatarUrl: string | null;
  color: BotColor;
  face: BotBaseFace;
  tagline: string | null;
  persona: string;
  knowledge: string;
  channelIds: string[];
  enabled: boolean;
  /** Also answers its name said as a whole word, not only its @handle. */
  answerToName: boolean;
  /** The picked model's id (`provider:model`), or null for the default. */
  model: string | null;
  /** The tools switched on. */
  tools: ServerBotTool[];
  createdAt: string;
  /**
   * The role the bot acts through, made when staff save its tools; null when
   * somebody deleted it (saving the tools again makes a new one).
   */
  roleId: string | null;
  /** Replies posted today (São Paulo day) and today's cap, for the settings page. */
  repliesToday: number;
  repliesPerDay: number;
}

/**
 * The card a bot's message carries when it acts: the plan waiting for "sim",
 * or what each step did. Written by server code only, never by a client or
 * the model, and drawn only for a bot author. `lead` is the model's sentence;
 * the message body keeps a plain-text copy of everything for clients that do
 * not draw cards.
 */
export const botActionItemSchema = z.object({
  tool: z.string().max(40),
  label: z.string().max(300),
  status: z.enum(["pending", "ok", "failed", "unknown"]),
  detail: z.string().max(200).nullable().default(null),
});
export type BotActionItem = z.infer<typeof botActionItemSchema>;

export const botActionCardSchema = z.object({
  /** `ask` is a question to the member, answered by one of `options`. */
  kind: z.enum(["plan", "result", "ask"]),
  lead: z.string().max(2000).nullable().default(null),
  items: z.array(botActionItemSchema).max(20),
  /** A plan's: who may answer "sim", and until when. */
  confirmBy: z.string().max(64).nullable().default(null),
  expiresAt: z.string().nullable().default(null),
  /** A plan's: what its Confirm and Cancel buttons answer, and who may press them. */
  planId: z.string().uuid().nullable().default(null),
  confirmById: z.string().uuid().nullable().default(null),
  /** A plan's or a question's outcome once decided; null while it waits. */
  state: z.enum(["confirmed", "cancelled", "expired", "answered"]).nullable().default(null),
  /** A question's choices, and the index the member picked. */
  options: z.array(z.string().max(80)).max(4).nullable().default(null),
  answer: z.number().int().min(0).max(3).nullable().default(null),
});
export type BotActionCard = z.infer<typeof botActionCardSchema>;

/** `POST /api/bots/plans/:planId/decision`: a plan card's buttons. */
export const botPlanDecisionSchema = z.object({ decision: z.enum(["yes", "no"]) });

/** How long a question card's buttons stay live. */
export const SERVER_BOT_ASK_TTL_MS = 10 * 60_000;

/** `POST /api/bots/asks/:messageId/answer`: a question card's buttons. */
export const botAskAnswerSchema = z.object({ option: z.number().int().min(0).max(3) });

/**
 * Why a bot did not answer somebody who called it:
 * - `busy`: it is still answering their earlier questions (two may wait).
 * - `member-hour`: they asked it the most questions allowed in an hour.
 * - `server-day`: the server used its answers for the day.
 * - `budget`: the deployment's daily model spend is used up.
 */
export const botNoticeReasonSchema = z.enum(["busy", "member-hour", "server-day", "budget"]);
export type BotNoticeReason = z.infer<typeof botNoticeReasonSchema>;

/**
 * `bot-notice`: sent only to the member the bot did not answer, on their own
 * sockets, so silence is never the only answer. Nothing is posted in the
 * channel; the client shows it as a row only that member sees.
 */
export const botNoticeSchema = z.object({
  type: z.literal("bot-notice"),
  channelId: z.string().uuid(),
  botUserId: z.string().uuid(),
  botName: z.string().max(100),
  reason: botNoticeReasonSchema,
  /** The limit that was reached, for `member-hour` and `server-day`. */
  limit: z.number().int().positive().nullable(),
  /** When the bot will answer again, when that is known. */
  retryAt: z.string().nullable(),
});
export type BotNotice = z.infer<typeof botNoticeSchema>;

/** `GET /api/bots/config?serverId=`: whether bots exist here at all. */
export interface ServerBotModelChoice {
  id: string;
  label: string;
}

export interface ServerBotsConfig {
  enabled: boolean;
  maxBots: number;
  /** The models a bot may be set to; the first is the default. */
  models: ServerBotModelChoice[];
}

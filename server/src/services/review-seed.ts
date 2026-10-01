/**
 * The App Review demo space: a small PRIVATE server for the demo account, so a
 * reviewer who signs in lands somewhere with content in it, a second person to
 * Report and Block, and nobody real to post in front of.
 *
 * Operator tooling, run by hand on the API box through
 * `src/scripts/seed-review-community.ts` (see docs/TESTFLIGHT.md, "Seeding the
 * review community"). Nothing in the API imports this file.
 *
 * WHAT IT MAKES, all through the same service functions the API uses so the
 * cargos, audiences, caches and cluster invalidations are the real ones:
 *
 *   * a server named "pqp review", owned by the demo account. NOT a community
 *     (`is_community` FALSE: no public address, no `/c/<slug>`), NOT listed in
 *     the directory, so it never changes the instance's legal category
 *     (docs/CONTENT_SAFETY.md, "Communities"). Reachable only by an invite code.
 *   * channels #geral and #ajuda (text) and Lobby (voice).
 *   * one second account, "Demo Friend", a revoked CHARACTER row. `users.clerk_id`
 *     is NOT NULL, so a person-shaped row would need a fake Clerk id and would
 *     then be counted as a human by every metric and by the Turma dos 1000
 *     stamp. A character is excluded from all of that by construction. Its token
 *     is minted by `createCharacterAccount`, never read and revoked in the same
 *     breath, so nothing can authenticate as it. Report and Block both work on
 *     it (neither looks at `is_character`); the web client draws a small "bot"
 *     mark by its name, the native clients do not.
 *   * eight messages in #geral and one in #ajuda in English and pt-BR (a
 *     welcome, a how-to-try list, replies, a message made to be reported) and a
 *     few reactions. No attachments: that would need the storage layer.
 *   * an invite code, so the operator can join and look.
 *
 * IDEMPOTENT. Every step looks before it writes: the server by (name, owner),
 * the friend by its character label, each message by a nonce no client ever
 * sends, each reaction by its row. Running twice changes nothing the second
 * time, and a run that died half way is finished by running it again. That is
 * the substitute for "one transaction": the service layer owns its own
 * transactions, cache invalidation and cluster fan-out, and bypassing it with
 * raw SQL to get one big BEGIN would be exactly how a seeded room ends up with
 * no cargos or a stale audience cache on the other API machine.
 *
 * DRY RUN BY DEFAULT. Without `apply` the same walk runs read-only and reports
 * what each step would do.
 */
import type { DbUser } from "../db.js";
import { getPool } from "../db.js";
import {
  closeBus,
  isBusConnected,
  setBusTransport,
} from "../lib/bus.js";
import { createPostgresBusTransport } from "../lib/bus-postgres.js";
import {
  createCharacterAccount,
  revokeCharacterAccount,
} from "./characters.js";
import { createInvite, listInvites } from "./invites.js";
import { createMessage } from "./messages.js";
import { toggleReaction } from "./reactions.js";
import {
  createChannel,
  createServer,
  deleteServer,
  invalidateServerAudience,
  updateChannel,
} from "./servers.js";
import { leaveServer } from "./users.js";

/** The marker: a server with this name owned by the demo account is ours. */
export const REVIEW_SERVER_NAME = "pqp review";
/** The friend's stable identity in `character_accounts.label`. */
export const REVIEW_FRIEND_LABEL = "review-demo-friend";
export const REVIEW_FRIEND_NAME = "Demo Friend";
/**
 * Stored in `messages.nonce`. A client nonce is a uuid, so this can never
 * collide with one, and it is what makes a re-run find its own messages (and
 * what a hand cleanup can key on).
 */
export const REVIEW_NONCE_PREFIX = "pqp-review-seed:v1:";

const ADVISORY_LOCK_KEY = "pqp-review-seed";
const INVITE_MAX_USES = 10;

export interface ReviewSeedOptions {
  /** The demo account, by Clerk id. Exactly one of the two is required. */
  clerkId?: string;
  /** ...or by `users.id`. */
  userId?: string;
  /** Write. Without it nothing is changed. */
  apply?: boolean;
  /** Leave every other server the demo account belongs to. */
  leaveOthers?: boolean;
  /** Undo: delete what this script made (the server and the friend). */
  cleanup?: boolean;
  /** Cleanup anyway when somebody besides the two seeded accounts is in it. */
  force?: boolean;
  /** One line at a time, for the CLI. Defaults to silence. */
  log?: (line: string) => void;
  /**
   * Open the cluster bus for the run when `CLUSTER_BUS=postgres`, the way
   * `worker.ts` does. On by default and only off for a caller that has already
   * installed a transport.
   */
  manageBus?: boolean;
}

export type ActionKind =
  | "create" // a row this run made (or would make)
  | "exists" // already there, left alone
  | "change" // an existing row this run changed (or would)
  | "leave" // a membership this run removed (or would)
  | "blocked" // something it refused to do
  | "info"; // read-only context

export interface SeedAction {
  kind: ActionKind;
  what: string;
}

export interface ReviewSeedReport {
  apply: boolean;
  mode: "seed" | "cleanup";
  demoUserId: string;
  demoDisplayName: string;
  serverId: string | null;
  inviteCode: string | null;
  friendUserId: string | null;
  channels: { geral: string | null; ajuda: string | null; lobby: string | null };
  messageCount: number;
  actions: SeedAction[];
  /** Memberships of the demo account in other servers, with what happened. */
  others: Array<{
    serverId: string;
    name: string;
    role: string;
    members: number;
    outcome: "left" | "would-leave" | "blocked";
  }>;
}

export class ReviewSeedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReviewSeedError";
  }
}

// --------------------------------------------------------------------------
// The content

type PersonKey = "owner" | "friend";

interface SeedMessage {
  key: string;
  channel: "geral" | "ajuda";
  author: PersonKey;
  /** Another message's key. */
  replyTo?: string;
  body: string;
}

interface SeedReaction {
  message: string;
  by: PersonKey;
  emoji: string;
}

/** Nothing here is about a real person, a real place or a real server. */
export const REVIEW_MESSAGES: readonly SeedMessage[] = [
  {
    key: "welcome",
    channel: "geral",
    author: "friend",
    body:
      "Welcome to pqp review! This is a small private space for trying the app.\n" +
      "Bem-vindo ao pqp review! Este é um espaço pequeno e privado para testar o app.",
  },
  {
    key: "how-to",
    channel: "geral",
    author: "friend",
    body:
      "Things to try / Para testar:\n" +
      "1. Send a message here / Envie uma mensagem aqui\n" +
      "2. React with an emoji / Reaja com um emoji\n" +
      "3. Reply to a message / Responda a uma mensagem\n" +
      "4. Join the Lobby voice channel / Entre no canal de voz Lobby\n" +
      "5. Report a message or block a person / Denuncie uma mensagem ou bloqueie uma pessoa",
  },
  {
    key: "thanks",
    channel: "geral",
    author: "owner",
    replyTo: "welcome",
    body: "Thanks! Everything looks good so far.",
  },
  {
    key: "tip",
    channel: "geral",
    author: "friend",
    replyTo: "thanks",
    body: "Valeu! Tente reagir a esta mensagem com um emoji, e responder a ela também.",
  },
  {
    key: "voice",
    channel: "geral",
    author: "friend",
    body:
      "Tem um canal de voz chamado Lobby. Entre para testar o áudio, " +
      "ou fique de fora, tudo bem também.",
  },
  {
    key: "report-me",
    channel: "geral",
    author: "friend",
    body:
      "This is a test message to report. Open the message menu and choose Report " +
      "to see the reporting flow.\n" +
      "Esta é uma mensagem de teste para denunciar. Abra o menu da mensagem e " +
      "escolha Denunciar.",
  },
  {
    key: "block",
    channel: "geral",
    author: "owner",
    body:
      "To block someone, open their profile and choose Block. " +
      "Para bloquear alguém, abra o perfil da pessoa e escolha Bloquear.",
  },
  {
    key: "last",
    channel: "geral",
    author: "friend",
    body: "That is all. Obrigado por testar o pqp!",
  },
  {
    key: "help",
    channel: "ajuda",
    author: "friend",
    body:
      "Need help? Ask here. Precisa de ajuda? Pergunte aqui.\n" +
      "Privacy: https://pqp.gg/privacy | Terms: https://pqp.gg/terms",
  },
];

export const REVIEW_REACTIONS: readonly SeedReaction[] = [
  { message: "welcome", by: "owner", emoji: "❤️" },
  { message: "how-to", by: "owner", emoji: "👍" },
  { message: "thanks", by: "friend", emoji: "🎉" },
  { message: "block", by: "friend", emoji: "👍" },
];

const GERAL_TOPIC = "Say hi, react, reply, report, block.";
const AJUDA_TOPIC = "Questions about trying pqp. Perguntas sobre o app.";

// --------------------------------------------------------------------------
// Plumbing

const USER_COLUMNS = `id, clerk_id, display_name, username, discriminator, avatar_url, is_character, is_webhook`;

type SeedUser = DbUser & { is_webhook: boolean };

class Recorder {
  readonly actions: SeedAction[] = [];

  constructor(private readonly log: (line: string) => void) {}

  note(kind: ActionKind, what: string): void {
    this.actions.push({ kind, what });
    const tag: Record<ActionKind, string> = {
      create: "+",
      exists: "=",
      change: "~",
      leave: "-",
      blocked: "!",
      info: " ",
    };
    this.log(`  ${tag[kind]} ${what}`);
  }
}

async function findDemoUser(options: ReviewSeedOptions): Promise<SeedUser> {
  const byClerk = options.clerkId?.trim();
  const byId = options.userId?.trim();
  if ((byClerk ? 1 : 0) + (byId ? 1 : 0) !== 1) {
    throw new ReviewSeedError(
      "Give the demo account as exactly one of --clerk-id <id> or --user-id <uuid>. " +
        "(An email address will not do: users stores verified email DOMAINS only, never the address.)",
    );
  }
  const result = byClerk
    ? await getPool().query<SeedUser>(
        `SELECT ${USER_COLUMNS} FROM users WHERE clerk_id = $1`,
        [byClerk],
      )
    : await getPool().query<SeedUser>(
        `SELECT ${USER_COLUMNS} FROM users WHERE id::text = $1`,
        [byId],
      );
  const user = result.rows[0];
  if (!user) {
    throw new ReviewSeedError(
      `No user found for ${byClerk ? `clerk id ${byClerk}` : `user id ${byId}`}. ` +
        "The account has to have signed in once on this database (that is what creates the row). " +
        "Check you are on the right box and the right DATABASE_URL.",
    );
  }
  if (user.is_character || user.is_webhook) {
    throw new ReviewSeedError(
      `${user.display_name} is a character or webhook account, not a person. Refusing.`,
    );
  }
  return user;
}

async function findReviewServers(
  ownerId: string,
): Promise<Array<{ id: string; is_community: boolean; is_community_listed: boolean }>> {
  const result = await getPool().query<{
    id: string;
    is_community: boolean;
    is_community_listed: boolean;
  }>(
    `SELECT id, is_community, is_community_listed FROM servers
      WHERE name = $1 AND owner_id = $2
      ORDER BY created_at`,
    [REVIEW_SERVER_NAME, ownerId],
  );
  return result.rows;
}

async function findFriend(): Promise<SeedUser | null> {
  const result = await getPool().query<SeedUser>(
    `SELECT ${USER_COLUMNS.split(", ").map((c) => `u.${c}`).join(", ")}
       FROM character_accounts ca
       JOIN users u ON u.id = ca.user_id
      WHERE ca.label = $1`,
    [REVIEW_FRIEND_LABEL],
  );
  return result.rows[0] ?? null;
}

/**
 * The cluster bus, publish-only, exactly as `worker.ts` opens it. Without it a
 * script run beside two API machines changes the database and tells neither of
 * them: their cached audiences and member lists for the touched servers would
 * stay stale until they expire. A no-op unless `CLUSTER_BUS=postgres`.
 */
export async function openPublishOnlyBus(
  env: NodeJS.ProcessEnv = process.env,
): Promise<(() => Promise<void>) | null> {
  if (env.CLUSTER_BUS !== "postgres") {
    return null;
  }
  const transport = createPostgresBusTransport(undefined, { publishOnly: true });
  setBusTransport(transport);
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([
    transport.whenConnected(),
    new Promise<void>((resolve) => {
      timer = setTimeout(resolve, 10_000);
    }),
  ]);
  if (timer) {
    clearTimeout(timer);
  }
  if (!isBusConnected()) {
    await closeBus();
    throw new ReviewSeedError(
      "CLUSTER_BUS=postgres but the bus connection did not come up in 10s. " +
        "Refusing to write: the API machines would not hear about it.",
    );
  }
  return async () => {
    // A NOTIFY is fired without waiting. Give the last ones a moment to leave
    // before the connection is ended.
    await new Promise((resolve) => setTimeout(resolve, 300));
    await closeBus();
  };
}

async function withAdvisoryLock<T>(fn: () => Promise<T>): Promise<T> {
  const client = await getPool().connect();
  try {
    const got = await client.query<{ ok: boolean }>(
      `SELECT pg_try_advisory_lock(hashtext($1)) AS ok`,
      [ADVISORY_LOCK_KEY],
    );
    if (!got.rows[0]?.ok) {
      throw new ReviewSeedError(
        "Another run of this script holds the lock. Wait for it to finish.",
      );
    }
    try {
      return await fn();
    } finally {
      await client.query(`SELECT pg_advisory_unlock(hashtext($1))`, [
        ADVISORY_LOCK_KEY,
      ]);
    }
  } finally {
    client.release();
  }
}

// --------------------------------------------------------------------------
// Entry point

export async function runReviewSeed(
  options: ReviewSeedOptions,
): Promise<ReviewSeedReport> {
  const apply = options.apply === true;
  if (options.cleanup && options.leaveOthers) {
    throw new ReviewSeedError("--cleanup and --leave-others are separate runs.");
  }
  const rec = new Recorder(options.log ?? (() => {}));
  const demo = await findDemoUser(options);

  const closeTheBus =
    apply && options.manageBus !== false ? await openPublishOnlyBus() : null;
  try {
    const work = () =>
      options.cleanup
        ? cleanup(options, demo, rec, apply)
        : seed(options, demo, rec, apply);
    return apply ? await withAdvisoryLock(work) : await work();
  } finally {
    await closeTheBus?.();
  }
}

function emptyReport(
  demo: SeedUser,
  apply: boolean,
  mode: "seed" | "cleanup",
  rec: Recorder,
): ReviewSeedReport {
  return {
    apply,
    mode,
    demoUserId: demo.id,
    demoDisplayName: demo.display_name,
    serverId: null,
    inviteCode: null,
    friendUserId: null,
    channels: { geral: null, ajuda: null, lobby: null },
    messageCount: 0,
    actions: rec.actions,
    others: [],
  };
}

// --------------------------------------------------------------------------
// Seed

async function seed(
  options: ReviewSeedOptions,
  demo: SeedUser,
  rec: Recorder,
  apply: boolean,
): Promise<ReviewSeedReport> {
  const report = emptyReport(demo, apply, "seed", rec);
  rec.note(
    "info",
    `demo account: ${demo.display_name} (${demo.username ?? "?"}#${demo.discriminator ?? "?"}), id ${demo.id}`,
  );
  await describeUntouched(demo, rec);

  // ---- the server
  const found = await findReviewServers(demo.id);
  if (found.length > 1) {
    throw new ReviewSeedError(
      `${found.length} servers named "${REVIEW_SERVER_NAME}" are owned by this account. ` +
        "Delete the extras by hand first; refusing to guess which one is the seed.",
    );
  }
  let serverId: string | null = found[0]?.id ?? null;
  if (found[0]) {
    if (found[0].is_community || found[0].is_community_listed) {
      throw new ReviewSeedError(
        `Server ${found[0].id} is named "${REVIEW_SERVER_NAME}" but is a community or listed. ` +
          "It must be private. Refusing to touch it.",
      );
    }
    rec.note("exists", `server "${REVIEW_SERVER_NAME}" (${found[0].id}), private`);
  } else if (apply) {
    const created = await createServer(REVIEW_SERVER_NAME, demo.id);
    serverId = created.server.id;
    rec.note(
      "create",
      `server "${REVIEW_SERVER_NAME}" (${serverId}), private, owner ${demo.display_name}`,
    );
  } else {
    rec.note(
      "create",
      `server "${REVIEW_SERVER_NAME}", private, not a community, not listed, owner ${demo.display_name}`,
    );
  }
  report.serverId = serverId;

  // ---- channels
  const channels = serverId ? await readChannels(serverId) : [];
  const text = (name: string) =>
    channels.find((c) => c.name === name && c.type === "text") ?? null;
  const geral = text("geral") ?? text("general");
  let geralId: string | null = geral?.id ?? null;
  if (geral?.name === "geral") {
    rec.note("exists", "channel #geral (text)");
  } else if (geral && apply) {
    await updateChannel(geral.id, { name: "geral", topic: GERAL_TOPIC });
    rec.note("change", 'channel #general renamed to #geral (the server\'s default text channel)');
  } else if (geral) {
    rec.note("change", "channel #general would be renamed to #geral");
  } else if (apply && serverId) {
    // The server exists but has neither channel (one was deleted by hand).
    geralId = (await createChannel(serverId, "geral", "text", false, GERAL_TOPIC)).id;
    rec.note("create", "channel #geral (text)");
  } else {
    rec.note("create", "channel #geral (text)");
  }
  const ajuda = text("ajuda");
  let ajudaId = ajuda?.id ?? null;
  if (ajuda) {
    rec.note("exists", "channel #ajuda (text)");
  } else if (apply && serverId) {
    ajudaId = (await createChannel(serverId, "ajuda", "text", false, AJUDA_TOPIC)).id;
    rec.note("create", "channel #ajuda (text)");
  } else {
    rec.note("create", "channel #ajuda (text)");
  }
  const lobby = channels.find((c) => c.name === "Lobby" && c.type === "voice");
  let lobbyId = lobby?.id ?? null;
  if (lobby) {
    rec.note("exists", "channel Lobby (voice)");
  } else if (apply && serverId) {
    lobbyId = (await createChannel(serverId, "Lobby", "voice")).id;
    rec.note("create", "channel Lobby (voice)");
  } else {
    rec.note("create", "channel Lobby (voice)");
  }
  if (apply && serverId) {
    // Re-read: the rename above and the creates are what the report names.
    const after = await readChannels(serverId);
    geralId = after.find((c) => c.name === "geral" && c.type === "text")?.id ?? geralId;
  }
  report.channels = { geral: geralId, ajuda: ajudaId, lobby: lobbyId };

  // ---- the friend
  let friend = await findFriend();
  if (friend) {
    rec.note("exists", `account "${REVIEW_FRIEND_NAME}" (flagged demo/character, id ${friend.id})`);
  } else if (apply) {
    const minted = await createCharacterAccount({
      label: REVIEW_FRIEND_LABEL,
      displayName: REVIEW_FRIEND_NAME,
      createdBy: "seed-review-community",
    });
    // The token in `minted.token` is dropped on the floor on purpose. Revoking
    // as well means that even a hash collision with a future token could not
    // authenticate this row.
    const revoked = await revokeCharacterAccount(REVIEW_FRIEND_LABEL);
    if (!revoked?.revoked_at) {
      throw new ReviewSeedError("Could not revoke the friend's token. Stop and look.");
    }
    friend = (await findFriend())!;
    rec.note(
      "create",
      `account "${REVIEW_FRIEND_NAME}" (flagged demo/character, token revoked, id ${minted.user.id})`,
    );
  } else {
    rec.note(
      "create",
      `account "${REVIEW_FRIEND_NAME}" (flagged demo/character, nobody can sign in as it)`,
    );
  }
  report.friendUserId = friend?.id ?? null;

  // ---- membership
  if (friend && serverId) {
    const member = await getPool().query(
      `SELECT 1 FROM server_members WHERE server_id = $1 AND user_id = $2`,
      [serverId, friend.id],
    );
    if (member.rowCount) {
      rec.note("exists", `${REVIEW_FRIEND_NAME} is a member`);
    } else if (apply) {
      await getPool().query(
        `INSERT INTO server_members (server_id, user_id, role)
         VALUES ($1, $2, 'member')
         ON CONFLICT DO NOTHING`,
        [serverId, friend.id],
      );
      invalidateServerAudience(serverId, { joinedUserId: friend.id });
      rec.note("create", `${REVIEW_FRIEND_NAME} joined as a member`);
    } else {
      rec.note("create", `${REVIEW_FRIEND_NAME} would join as a member`);
    }
  } else {
    rec.note("create", `${REVIEW_FRIEND_NAME} joins as a member`);
  }

  // ---- messages
  const authors: Record<PersonKey, SeedUser | null> = { owner: demo, friend };
  const channelOf: Record<SeedMessage["channel"], string | null> = {
    geral: geralId,
    ajuda: ajudaId,
  };
  const messageIds = new Map<string, string>();
  let made = 0;
  let had = 0;
  for (const message of REVIEW_MESSAGES) {
    const channelId = channelOf[message.channel];
    const author = authors[message.author];
    const nonce = `${REVIEW_NONCE_PREFIX}${message.key}`;
    const existing =
      channelId && author
        ? await getPool().query<{ id: string }>(
            `SELECT id FROM messages
              WHERE channel_id = $1 AND author_id = $2 AND nonce = $3`,
            [channelId, author.id, nonce],
          )
        : null;
    const existingId = existing?.rows[0]?.id;
    if (existingId) {
      messageIds.set(message.key, existingId);
      had += 1;
      continue;
    }
    made += 1;
    if (!apply || !channelId || !author) {
      continue;
    }
    const created = await createMessage(
      channelId,
      author,
      message.body,
      message.replyTo ? (messageIds.get(message.replyTo) ?? null) : null,
      undefined,
      undefined,
      undefined,
      nonce,
    );
    if (!created) {
      throw new ReviewSeedError(`Message "${message.key}" was not stored.`);
    }
    messageIds.set(message.key, created.id);
  }
  report.messageCount = apply ? messageIds.size : had;
  rec.note(
    made > 0 ? "create" : "exists",
    made > 0
      ? `${made} message(s) (${had} already there), English and pt-BR, in #geral and #ajuda`
      : `all ${had} messages`,
  );

  // ---- reactions
  let reactionsMade = 0;
  for (const reaction of REVIEW_REACTIONS) {
    const messageId = messageIds.get(reaction.message);
    const user = authors[reaction.by];
    if (!messageId || !user) {
      reactionsMade += 1;
      continue;
    }
    const there = await getPool().query(
      `SELECT 1 FROM message_reactions
        WHERE message_id = $1 AND user_id = $2 AND emoji = $3`,
      [messageId, user.id, reaction.emoji],
    );
    if (there.rowCount) {
      continue;
    }
    reactionsMade += 1;
    if (apply) {
      // Looked first, so this toggle can only ever add.
      await toggleReaction(messageId, user.id, reaction.emoji);
    }
  }
  rec.note(
    reactionsMade > 0 ? "create" : "exists",
    reactionsMade > 0 ? `${reactionsMade} reaction(s)` : "all reactions",
  );

  // ---- invite
  if (serverId) {
    const invites = await listInvites(serverId);
    const usable = invites.find(
      (invite) =>
        invite.created_by === demo.id &&
        (!invite.expires_at || invite.expires_at.getTime() > Date.now()) &&
        (invite.max_uses == null || invite.uses < invite.max_uses),
    );
    if (usable) {
      report.inviteCode = usable.code;
      rec.note("exists", `invite code ${usable.code}`);
    } else if (apply) {
      const invite = await createInvite(serverId, demo.id, {
        maxUses: INVITE_MAX_USES,
        expiresInHours: null,
      });
      report.inviteCode = invite.code;
      rec.note("create", `invite code ${invite.code} (${INVITE_MAX_USES} uses, no expiry)`);
    } else {
      rec.note("create", `invite code (${INVITE_MAX_USES} uses, no expiry)`);
    }
  } else {
    rec.note("create", `invite code (${INVITE_MAX_USES} uses, no expiry)`);
  }

  if (apply && serverId) {
    // Any session the demo account already has open learns about the room.
    invalidateServerAudience(serverId, { joinedUserId: demo.id });
  }

  // ---- leave the others
  if (options.leaveOthers) {
    await leaveOthers(demo, serverId, rec, apply, report);
  }

  return report;
}

async function readChannels(serverId: string) {
  const result = await getPool().query<{
    id: string;
    name: string;
    type: string;
    topic: string | null;
  }>(
    `SELECT id, name, type, topic FROM channels
      WHERE server_id = $1 AND type <> 'thread' ORDER BY position`,
    [serverId],
  );
  return result.rows;
}

/** What this script does NOT touch, so the operator knows what a reviewer could still see. */
async function describeUntouched(demo: SeedUser, rec: Recorder): Promise<void> {
  const counts = await getPool().query<{ friends: number; chats: number; blocks: number }>(
    `SELECT
       (SELECT count(*)::int FROM friendships
         WHERE low_user_id = $1 OR high_user_id = $1) AS friends,
       (SELECT count(*)::int FROM channel_members cm
          JOIN channels c ON c.id = cm.channel_id
         WHERE cm.user_id = $1 AND c.kind IN ('dm', 'group')) AS chats,
       (SELECT count(*)::int FROM user_blocks WHERE user_id = $1) AS blocks`,
    [demo.id],
  );
  const row = counts.rows[0]!;
  rec.note(
    "info",
    `not touched by this script: ${row.friends} friendship row(s), ${row.chats} DM or group conversation(s), ${row.blocks} block(s)`,
  );
}

async function leaveOthers(
  demo: SeedUser,
  keepServerId: string | null,
  rec: Recorder,
  apply: boolean,
  report: ReviewSeedReport,
): Promise<void> {
  const memberships = await getPool().query<{
    id: string;
    name: string;
    role: string;
    members: number;
  }>(
    `SELECT s.id, s.name, sm.role,
            (SELECT count(*)::int FROM server_members m WHERE m.server_id = s.id) AS members
       FROM server_members sm
       JOIN servers s ON s.id = sm.server_id
      WHERE sm.user_id = $1
      ORDER BY s.created_at`,
    [demo.id],
  );
  const others = memberships.rows.filter((row) => row.id !== keepServerId);
  rec.note(
    "info",
    others.length === 0
      ? "no other servers to leave"
      : `other servers the demo account belongs to: ${others.length}`,
  );
  for (const row of others) {
    const label = `"${row.name}" (${row.id}), role ${row.role}, ${row.members} member(s)`;
    if (row.role === "owner") {
      // Leaving is refused by `leaveServer` for an owner anyway; saying so here
      // keeps the whole list honest. Nothing is ever deleted or transferred.
      rec.note("blocked", `will NOT leave ${label}: the demo account owns it`);
      report.others.push({
        serverId: row.id,
        name: row.name,
        role: row.role,
        members: row.members,
        outcome: "blocked",
      });
      continue;
    }
    if (apply) {
      await leaveServer(row.id, demo.id);
      rec.note("leave", `left ${label}`);
    } else {
      rec.note("leave", `would leave ${label}`);
    }
    report.others.push({
      serverId: row.id,
      name: row.name,
      role: row.role,
      members: row.members,
      outcome: apply ? "left" : "would-leave",
    });
  }
}

// --------------------------------------------------------------------------
// Cleanup

async function cleanup(
  options: ReviewSeedOptions,
  demo: SeedUser,
  rec: Recorder,
  apply: boolean,
): Promise<ReviewSeedReport> {
  const report = emptyReport(demo, apply, "cleanup", rec);
  const found = await findReviewServers(demo.id);
  const friend = await findFriend();
  if (found.length === 0 && !friend) {
    rec.note("exists", "nothing to clean up");
    return report;
  }
  // Preflight every target BEFORE deleting anything, so a refusal leaves the
  // whole thing exactly as it was (no friend deleted out of a server that stays).
  const plans: Array<{ id: string; messages: number; members: number }> = [];
  let refused = false;
  for (const server of found) {
    if (server.is_community || server.is_community_listed) {
      throw new ReviewSeedError(
        `Server ${server.id} is named "${REVIEW_SERVER_NAME}" but is a community or listed, ` +
          "so it is not one this script made. Refusing to delete it.",
      );
    }
    const members = await getPool().query<{ user_id: string }>(
      `SELECT user_id FROM server_members WHERE server_id = $1`,
      [server.id],
    );
    const strangers = members.rows.filter(
      (row) => row.user_id !== demo.id && row.user_id !== friend?.id,
    );
    const messages = await getPool().query<{ n: number }>(
      `SELECT count(*)::int AS n FROM messages m
         JOIN channels c ON c.id = m.channel_id WHERE c.server_id = $1`,
      [server.id],
    );
    if (strangers.length > 0 && !options.force) {
      refused = true;
      rec.note(
        "blocked",
        `server ${server.id} has ${strangers.length} member(s) besides the two seeded accounts. ` +
          "Nothing was changed. Re-run with --force to delete it anyway.",
      );
      continue;
    }
    plans.push({
      id: server.id,
      messages: messages.rows[0]!.n,
      members: members.rowCount ?? 0,
    });
  }
  if (refused) {
    return report;
  }
  for (const plan of plans) {
    if (apply) {
      await deleteServer(plan.id);
    }
    rec.note(
      "leave",
      `${apply ? "deleted" : "would delete"} server "${REVIEW_SERVER_NAME}" (${plan.id}) ` +
        `with ${plan.messages} message(s) and ${plan.members} member(s)`,
    );
  }
  if (friend) {
    if (apply) {
      // Cascades character_accounts, memberships and any leftover messages.
      await getPool().query(`DELETE FROM users WHERE id = $1 AND is_character`, [friend.id]);
    }
    rec.note("leave", `${apply ? "deleted" : "would delete"} account "${REVIEW_FRIEND_NAME}" (${friend.id})`);
  }
  return report;
}

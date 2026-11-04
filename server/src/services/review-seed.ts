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
 *   * a THIRD account, "Block Me", built the same way (a revoked character), a
 *     member of the space who posts two mildly annoying but rule-abiding
 *     messages in #geral. It exists to be blocked: the reviewer is told to try
 *     Block on it, so Demo Friend keeps the friendship and the DM. It is NOT a
 *     friend and has NO conversation with the demo account, so blocking it
 *     removes nothing a reviewer needs (blocking Demo Friend ended the
 *     friendship and hid the DM, and unblocking does not bring them back).
 *   * an invite code, so the operator can join and look.
 *   * an ACCEPTED friendship between the demo account and Demo Friend, and a 1:1
 *     conversation between them with five short messages spread over a few
 *     days, so the Chats and Friends tabs are not empty (Guideline 2.1(a)).
 *     Both are written with plain SQL on purpose: `sendFriendRequest` and
 *     `openConversation` refuse a character, correctly, for everybody else.
 *   * with `--clear-pending`, the demo account's PENDING friend requests (to or
 *     from real people) are deleted. Nothing else: never an accepted row, never
 *     a row between two other accounts.
 *
 * IDEMPOTENT. Every step looks before it writes: the server by (name, owner),
 * each character by its label, each message by a nonce no client ever sends,
 * each reaction by its row. A seeded message whose text no longer matches the
 * seed is CORRECTED IN PLACE (body only, no "edited" mark), so a wording fix
 * reaches a database that was seeded with the old text. Running twice changes nothing the second
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
  publishToCluster,
  setBusTransport,
} from "../lib/bus.js";
import { createPostgresBusTransport } from "../lib/bus-postgres.js";
import {
  createCharacterAccount,
  revokeCharacterAccount,
} from "./characters.js";
import { restoreDmParticipants } from "./dms.js";
import { createInvite, listInvites } from "./invites.js";
import { clampChatNewlines } from "@pqp/shared";
import { createMessage } from "./messages.js";
import { toggleReaction } from "./reactions.js";
import {
  createChannel,
  createServer,
  deleteServer,
  invalidateServerAudience,
  updateChannel,
} from "./servers.js";
import { invalidateChannelAccessForChannel, leaveServer } from "./users.js";

/** The marker: a server with this name owned by the demo account is ours. */
export const REVIEW_SERVER_NAME = "pqp review";
/** The friend's stable identity in `character_accounts.label`. */
export const REVIEW_FRIEND_LABEL = "review-demo-friend";
export const REVIEW_FRIEND_NAME = "Demo Friend";
/** The account the reviewer is told to block, so the friend stays intact. */
export const REVIEW_BLOCKME_LABEL = "review-block-me";
export const REVIEW_BLOCKME_NAME = "Block Me";
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
  /**
   * Delete the demo account's PENDING friend requests (sent or received). Only
   * pending rows that involve the demo account; an accepted friendship and every
   * other account's rows are never touched. A dry run lists them.
   */
  clearPending?: boolean;
  /** Undo: delete what this script made (the server, the friend, their DM). */
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

/** What the demo account's Chats and Friends tabs would show. */
export interface ChatState {
  /** Accepted friendships of the demo account, anybody. */
  friends: number;
  /** Whether Demo Friend is one of them. */
  demoFriendIsFriend: boolean;
  pendingIncoming: number;
  pendingOutgoing: number;
  /** DM or group conversations the demo account is a member of. */
  conversations: number;
  /** Messages in the demo account's DM with Demo Friend. */
  demoFriendDmMessages: number;
}

export interface ReviewSeedReport {
  apply: boolean;
  mode: "seed" | "cleanup";
  demoUserId: string;
  demoDisplayName: string;
  serverId: string | null;
  inviteCode: string | null;
  friendUserId: string | null;
  /** The account made to be blocked, null until it exists. */
  blockMeUserId: string | null;
  channels: { geral: string | null; ajuda: string | null; lobby: string | null };
  messageCount: number;
  /** The 1:1 conversation with Demo Friend, null until it exists. */
  dmChannelId: string | null;
  /** The state before this run and after it (a projection on a dry run). */
  chatState: { before: ChatState; after: ChatState } | null;
  /** Pending requests removed (or that would be), with `--clear-pending`. */
  pendingCleared: number;
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

type PersonKey = "owner" | "friend" | "blockme";

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
    key: "blockme-1",
    channel: "geral",
    author: "blockme",
    body:
      "Hello hello hello! Is anybody here? Anybody? " +
      "Olá, olá, olá! Tem alguém aí? Alguém?",
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
    key: "blockme-2",
    channel: "geral",
    author: "blockme",
    body:
      "ME AGAIN. I REALLY LIKE POSTING IN CAPITAL LETTERS. " +
      "EU DE NOVO. ADORO ESCREVER EM LETRAS MAIÚSCULAS.",
  },
  {
    key: "block",
    channel: "geral",
    author: "owner",
    body:
      "To try Block, open the message menu on one of the Block Me messages above and choose Block. " +
      "Block Me is here just for this; Demo Friend is your friend, no need to block them.\n" +
      "Para testar o bloqueio, abra o menu de uma mensagem do Block Me, acima, e escolha Bloquear. " +
      "O Block Me existe só para isso; o Demo Friend é seu amigo, não precisa bloquear.",
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

interface SeedDmMessage {
  key: string;
  /** Block Me has no conversation with the demo account. */
  author: Exclude<PersonKey, "blockme">;
  /** Minutes before the moment the seed first writes it. */
  minutesAgo: number;
  body: string;
}

/**
 * The 1:1 conversation. Alternating authors, English and pt-BR, oldest first,
 * the last one from Demo Friend so Chats shows an unread badge worth opening.
 * Timestamps are set once, when the row is made; a re-run never moves them.
 */
export const REVIEW_DM_MESSAGES: readonly SeedDmMessage[] = [
  {
    key: "dm-1",
    author: "friend",
    minutesAgo: 4 * 1440 + 30,
    body: "Hi! I am Demo Friend. This is a direct message, so you can see how a chat looks. Oi! Eu sou o Demo Friend.",
  },
  {
    key: "dm-2",
    author: "owner",
    minutesAgo: 4 * 1440 + 12,
    body: "Hey, nice to meet you! Tudo bem por aqui.",
  },
  {
    key: "dm-3",
    author: "friend",
    minutesAgo: 2 * 1440 + 200,
    body: "Great. Try sending a message or reacting to this one. Que tal responder em português também?",
  },
  {
    key: "dm-4",
    author: "owner",
    minutesAgo: 2 * 1440 + 185,
    body: "Done! Funcionou direitinho. The app feels fast.",
  },
  {
    key: "dm-5",
    author: "friend",
    minutesAgo: 95,
    body: "Perfeito, obrigado por testar o pqp! Thanks for trying it out.",
  },
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

type SeedCharacter = SeedUser & { revoked_at: Date | null };

async function findCharacter(label: string): Promise<SeedCharacter | null> {
  const result = await getPool().query<SeedCharacter>(
    `SELECT ${USER_COLUMNS.split(", ").map((c) => `u.${c}`).join(", ")}, ca.revoked_at
       FROM character_accounts ca
       JOIN users u ON u.id = ca.user_id
      WHERE ca.label = $1`,
    [label],
  );
  return result.rows[0] ?? null;
}

const findFriend = () => findCharacter(REVIEW_FRIEND_LABEL);
const findBlockMe = () => findCharacter(REVIEW_BLOCKME_LABEL);

/**
 * One seeded character: look it up by label, finish a run that died between
 * minting and revoking, or mint it and revoke the token at once. The token is
 * dropped on the floor on purpose: even a hash collision with a future token
 * could not authenticate a revoked row.
 */
async function ensureCharacter(
  label: string,
  displayName: string,
  rec: Recorder,
  apply: boolean,
): Promise<SeedCharacter | null> {
  let character = await findCharacter(label);
  if (character && character.revoked_at === null) {
    // A run that died between minting the account and revoking its token left
    // a live credential nobody holds. Finish the job rather than call it "exists".
    if (apply) {
      const revoked = await revokeCharacterAccount(label);
      if (!revoked?.revoked_at) {
        throw new ReviewSeedError(`Could not revoke ${displayName}'s token. Stop and look.`);
      }
      character = (await findCharacter(label))!;
      rec.note("change", `account "${displayName}": token was not revoked, revoked now (id ${character.id})`);
    } else {
      rec.note("change", `account "${displayName}": token is not revoked, would revoke it (id ${character.id})`);
    }
  } else if (character) {
    rec.note("exists", `account "${displayName}" (flagged demo/character, id ${character.id})`);
  } else if (apply) {
    const minted = await createCharacterAccount({
      label,
      displayName,
      createdBy: "seed-review-community",
    });
    const revoked = await revokeCharacterAccount(label);
    if (!revoked?.revoked_at) {
      throw new ReviewSeedError(`Could not revoke ${displayName}'s token. Stop and look.`);
    }
    character = (await findCharacter(label))!;
    rec.note(
      "create",
      `account "${displayName}" (flagged demo/character, token revoked, id ${minted.user.id})`,
    );
  } else {
    rec.note(
      "create",
      `account "${displayName}" (flagged demo/character, nobody can sign in as it)`,
    );
  }
  return character;
}

/** A character joins the review server as a plain member. */
async function ensureMember(
  serverId: string | null,
  character: SeedCharacter | null,
  displayName: string,
  rec: Recorder,
  apply: boolean,
): Promise<void> {
  if (character && serverId) {
    const member = await getPool().query(
      `SELECT 1 FROM server_members WHERE server_id = $1 AND user_id = $2`,
      [serverId, character.id],
    );
    if (member.rowCount) {
      rec.note("exists", `${displayName} is a member`);
    } else if (apply) {
      await getPool().query(
        `INSERT INTO server_members (server_id, user_id, role)
         VALUES ($1, $2, 'member')
         ON CONFLICT DO NOTHING`,
        [serverId, character.id],
      );
      invalidateServerAudience(serverId, { joinedUserId: character.id });
      rec.note("create", `${displayName} joined as a member`);
    } else {
      rec.note("create", `${displayName} would join as a member`);
    }
  } else {
    rec.note("create", `${displayName} joins as a member`);
  }
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
  if (options.cleanup && options.clearPending) {
    throw new ReviewSeedError(
      "--cleanup and --clear-pending are separate runs. --clear-pending deletes the demo " +
        "account's pending friend requests, which are real people's and cannot be put back.",
    );
  }
  if (options.force && !options.cleanup) {
    throw new ReviewSeedError("--force only means something with --cleanup.");
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
    blockMeUserId: null,
    messageCount: 0,
    dmChannelId: null,
    chatState: null,
    pendingCleared: 0,
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
  const before = await readChatState(demo.id);
  rec.note("info", `before: ${describeChatState(before)}`);
  rec.note(
    "info",
    `blocks on this account (never touched by this script): ${await countBlocks(demo.id)}`,
  );

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

  // ---- the friend, and the one made to be blocked
  const friend = await ensureCharacter(REVIEW_FRIEND_LABEL, REVIEW_FRIEND_NAME, rec, apply);
  report.friendUserId = friend?.id ?? null;
  const blockMe = await ensureCharacter(REVIEW_BLOCKME_LABEL, REVIEW_BLOCKME_NAME, rec, apply);
  report.blockMeUserId = blockMe?.id ?? null;

  // ---- membership
  await ensureMember(serverId, friend, REVIEW_FRIEND_NAME, rec, apply);
  await ensureMember(serverId, blockMe, REVIEW_BLOCKME_NAME, rec, apply);

  // ---- messages
  const authors: Record<PersonKey, SeedUser | null> = { owner: demo, friend, blockme: blockMe };
  const channelOf: Record<SeedMessage["channel"], string | null> = {
    geral: geralId,
    ajuda: ajudaId,
  };
  const messageIds = new Map<string, string>();
  let made = 0;
  let had = 0;
  let corrected = 0;
  for (const message of REVIEW_MESSAGES) {
    const channelId = channelOf[message.channel];
    const author = authors[message.author];
    const nonce = `${REVIEW_NONCE_PREFIX}${message.key}`;
    const existing =
      channelId && author
        ? await getPool().query<{ id: string; body: string }>(
            `SELECT id, body FROM messages
              WHERE channel_id = $1 AND author_id = $2 AND nonce = $3`,
            [channelId, author.id, nonce],
          )
        : null;
    const existingId = existing?.rows[0]?.id;
    if (existingId) {
      messageIds.set(message.key, existingId);
      had += 1;
      // A database seeded with older wording gets the current one. Plain SQL,
      // not `updateMessageBody`: that stamps `edited_at`, and a correction made
      // by the seed is not an edit anybody should see.
      const wanted = clampChatNewlines(message.body);
      if (existing!.rows[0]!.body !== wanted) {
        corrected += 1;
        if (apply) {
          await getPool().query(`UPDATE messages SET body = $2 WHERE id = $1`, [
            existingId,
            wanted,
          ]);
        }
      }
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
  if (corrected > 0) {
    rec.note(
      "change",
      `${corrected} message(s) ${apply ? "had" : "would have"} their text updated to the current wording`,
    );
  }

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

  // ---- friendship and the 1:1 conversation
  const projected = { ...before };
  const friendship = await seedFriendship(demo, friend, rec, apply);
  if (friendship.makesFriend) {
    projected.friends += 1;
    projected.demoFriendIsFriend = true;
    // A pending row with the friend becomes the accepted one.
    projected.pendingIncoming -= friendship.wasPending === "incoming" ? 1 : 0;
    projected.pendingOutgoing -= friendship.wasPending === "outgoing" ? 1 : 0;
  }
  const conversation = await seedConversation(demo, friend, rec, apply);
  report.dmChannelId = conversation.channelId;
  report.messageCount += REVIEW_DM_MESSAGES.length - (apply ? 0 : conversation.newMessages);
  if (conversation.appears) {
    projected.conversations += 1;
  }
  projected.demoFriendDmMessages += conversation.newMessages;

  // ---- pending requests
  if (options.clearPending) {
    const cleared = await clearPendingRequests(demo, friend?.id ?? null, rec, apply);
    report.pendingCleared = cleared.incoming + cleared.outgoing;
    projected.pendingIncoming -= cleared.incoming;
    projected.pendingOutgoing -= cleared.outgoing;
  } else {
    const left = projected.pendingIncoming + projected.pendingOutgoing;
    if (left > 0) {
      rec.note(
        "info",
        `${left} pending friend request(s) left alone. A reviewer would see them under Pending; ` +
          "add --clear-pending to delete them",
      );
    }
  }
  const after = apply ? await readChatState(demo.id) : projected;
  report.chatState = { before, after };
  rec.note("info", `after${apply ? "" : " (projected)"}: ${describeChatState(after)}`);

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

async function countBlocks(userId: string): Promise<number> {
  const result = await getPool().query<{ n: number }>(
    `SELECT count(*)::int AS n FROM user_blocks WHERE user_id = $1`,
    [userId],
  );
  return result.rows[0]!.n;
}

function sortedPair(a: string, b: string): [string, string] {
  return a < b ? [a, b] : [b, a];
}

/** The demo account's DM channel with `friendId`, by the sorted pair. */
async function findDmChannel(demoId: string, friendId: string): Promise<string | null> {
  const [low, high] = sortedPair(demoId, friendId);
  const result = await getPool().query<{ channel_id: string }>(
    `SELECT channel_id FROM dm_pairs WHERE low_user_id = $1 AND high_user_id = $2`,
    [low, high],
  );
  return result.rows[0]?.channel_id ?? null;
}

/** What the Chats and Friends tabs would show the demo account right now. */
async function readChatState(demoId: string): Promise<ChatState> {
  const counts = await getPool().query<{
    friends: number;
    incoming: number;
    outgoing: number;
    conversations: number;
  }>(
    `SELECT
       (SELECT count(*)::int FROM friendships
         WHERE status = 'accepted' AND (low_user_id = $1 OR high_user_id = $1)) AS friends,
       (SELECT count(*)::int FROM friendships
         WHERE status = 'pending' AND requested_by <> $1
           AND (low_user_id = $1 OR high_user_id = $1)) AS incoming,
       (SELECT count(*)::int FROM friendships
         WHERE status = 'pending' AND requested_by = $1
           AND (low_user_id = $1 OR high_user_id = $1)) AS outgoing,
       (SELECT count(*)::int FROM channel_members cm
          JOIN channels c ON c.id = cm.channel_id
         WHERE cm.user_id = $1 AND c.kind IN ('dm', 'group')) AS conversations`,
    [demoId],
  );
  const row = counts.rows[0]!;
  const friend = await findFriend();
  let demoFriendIsFriend = false;
  let demoFriendDmMessages = 0;
  if (friend) {
    const [low, high] = sortedPair(demoId, friend.id);
    demoFriendIsFriend =
      (
        await getPool().query(
          `SELECT 1 FROM friendships
            WHERE low_user_id = $1 AND high_user_id = $2 AND status = 'accepted'`,
          [low, high],
        )
      ).rowCount === 1;
    const channelId = await findDmChannel(demoId, friend.id);
    if (channelId) {
      const messages = await getPool().query<{ n: number }>(
        `SELECT count(*)::int AS n FROM messages WHERE channel_id = $1`,
        [channelId],
      );
      demoFriendDmMessages = messages.rows[0]!.n;
    }
  }
  return {
    friends: row.friends,
    demoFriendIsFriend,
    pendingIncoming: row.incoming,
    pendingOutgoing: row.outgoing,
    conversations: row.conversations,
    demoFriendDmMessages,
  };
}

export function describeChatState(state: ChatState): string {
  return (
    `${state.friends} friend(s)${state.demoFriendIsFriend ? ` (${REVIEW_FRIEND_NAME} is one)` : ""}, ` +
    `pending ${state.pendingIncoming} incoming / ${state.pendingOutgoing} outgoing, ` +
    `${state.conversations} conversation(s), ${state.demoFriendDmMessages} message(s) in the ${REVIEW_FRIEND_NAME} DM`
  );
}

interface FriendshipOutcome {
  /** The demo account has (or will have) Demo Friend as an accepted friend. */
  makesFriend: boolean;
  /** A pending row with the friend that this turns into the accepted one. */
  wasPending: "incoming" | "outgoing" | null;
}

/**
 * Demo Friend as an ACCEPTED friend, by plain SQL: `sendFriendRequest` refuses a
 * character, as it should for every real account. The row follows the table's
 * rules (sorted pair, `requested_by` one of the two, `accepted_at` set exactly
 * when accepted). Friend "asked", the demo account "accepted", six days ago, so
 * the Friends tab has a plausible "friends since".
 */
async function seedFriendship(
  demo: SeedUser,
  friend: SeedUser | null,
  rec: Recorder,
  apply: boolean,
): Promise<FriendshipOutcome> {
  if (!friend) {
    rec.note("create", `friendship with ${REVIEW_FRIEND_NAME} (accepted)`);
    return { makesFriend: true, wasPending: null };
  }
  const blocked = await getPool().query(
    `SELECT 1 FROM user_blocks
      WHERE (user_id = $1 AND blocked_user_id = $2) OR (user_id = $2 AND blocked_user_id = $1)`,
    [demo.id, friend.id],
  );
  if (blocked.rowCount) {
    rec.note(
      "blocked",
      `a block stands between the demo account and ${REVIEW_FRIEND_NAME} (a reviewer's test?). ` +
        "Not making them friends over it. Unblock in the app (Settings, Blocked) and run again",
    );
    return { makesFriend: false, wasPending: null };
  }
  const [low, high] = sortedPair(demo.id, friend.id);
  const existing = await getPool().query<{ status: string; requested_by: string }>(
    `SELECT status, requested_by FROM friendships WHERE low_user_id = $1 AND high_user_id = $2`,
    [low, high],
  );
  const row = existing.rows[0];
  if (row?.status === "accepted") {
    rec.note("exists", `friendship with ${REVIEW_FRIEND_NAME} (accepted)`);
    return { makesFriend: false, wasPending: null };
  }
  if (row) {
    if (apply) {
      await getPool().query(
        `UPDATE friendships
            SET status = 'accepted', accepted_at = NOW() - INTERVAL '6 days'
          WHERE low_user_id = $1 AND high_user_id = $2 AND status = 'pending'`,
        [low, high],
      );
    }
    rec.note(
      "change",
      `pending request with ${REVIEW_FRIEND_NAME} ${apply ? "accepted" : "would be accepted"}`,
    );
    return {
      makesFriend: true,
      wasPending: row.requested_by === demo.id ? "outgoing" : "incoming",
    };
  }
  if (apply) {
    await getPool().query(
      `INSERT INTO friendships (low_user_id, high_user_id, status, requested_by, created_at, accepted_at)
       VALUES ($1, $2, 'accepted', $3, NOW() - INTERVAL '6 days',
               NOW() - INTERVAL '6 days' + INTERVAL '1 hour')
       ON CONFLICT (low_user_id, high_user_id) DO NOTHING`,
      [low, high, friend.id],
    );
  }
  rec.note("create", `friendship with ${REVIEW_FRIEND_NAME} (accepted)`);
  return { makesFriend: true, wasPending: null };
}

interface ConversationOutcome {
  channelId: string | null;
  /** Messages this run wrote (or would). */
  newMessages: number;
  /** The conversation appears in the demo account's list because of this run. */
  appears: boolean;
}

/**
 * The 1:1 conversation with Demo Friend and its five messages. A conversation
 * is a channel with no server (`kind = 'dm'`) plus the sorted `dm_pairs` row and
 * a `channel_members` row each, exactly what `openConversation` writes; that
 * function refuses a character (`dm_privacy = 'nobody'`), so the rows are
 * written here. Messages go through `createMessage` with a marker nonce, then
 * get their timestamps spread over the last days. If somebody hid the
 * conversation, a re-run restores it.
 */
async function seedConversation(
  demo: SeedUser,
  friend: SeedUser | null,
  rec: Recorder,
  apply: boolean,
): Promise<ConversationOutcome> {
  if (!friend) {
    rec.note(
      "create",
      `1:1 conversation with ${REVIEW_FRIEND_NAME} and ${REVIEW_DM_MESSAGES.length} messages`,
    );
    return { channelId: null, newMessages: REVIEW_DM_MESSAGES.length, appears: true };
  }
  let channelId = await findDmChannel(demo.id, friend.id);
  let appears = false;
  if (!channelId) {
    appears = true;
    if (apply) {
      const [low, high] = sortedPair(demo.id, friend.id);
      const client = await getPool().connect();
      try {
        await client.query("BEGIN");
        const channel = await client.query<{ id: string }>(
          `INSERT INTO channels (server_id, name, type, position, is_private, kind)
           VALUES (NULL, '', 'text', 0, FALSE, 'dm') RETURNING id`,
        );
        channelId = channel.rows[0]!.id;
        await client.query(
          `INSERT INTO dm_pairs (low_user_id, high_user_id, channel_id) VALUES ($1, $2, $3)`,
          [low, high, channelId],
        );
        await client.query(
          `INSERT INTO channel_members (channel_id, user_id)
           SELECT $1, unnest($2::uuid[]) ON CONFLICT DO NOTHING`,
          [channelId, [demo.id, friend.id]],
        );
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
      invalidateChannelAccessForChannel(channelId!);
    }
    rec.note(
      "create",
      `1:1 conversation with ${REVIEW_FRIEND_NAME}${channelId ? ` (${channelId})` : ""}`,
    );
  } else {
    const members = await getPool().query<{ user_id: string }>(
      `SELECT user_id FROM channel_members WHERE channel_id = $1`,
      [channelId],
    );
    const have = new Set(members.rows.map((r) => r.user_id));
    if (have.has(demo.id) && have.has(friend.id)) {
      rec.note("exists", `1:1 conversation with ${REVIEW_FRIEND_NAME} (${channelId})`);
    } else {
      appears = !have.has(demo.id);
      if (apply) {
        await restoreDmParticipants(channelId);
      }
      rec.note(
        "change",
        `1:1 conversation with ${REVIEW_FRIEND_NAME} was closed, ${apply ? "reopened" : "would reopen it"} (${channelId})`,
      );
    }
  }

  const authors: Record<SeedDmMessage["author"], SeedUser> = { owner: demo, friend };
  let made = 0;
  let had = 0;
  for (const message of REVIEW_DM_MESSAGES) {
    const author = authors[message.author];
    const nonce = `${REVIEW_NONCE_PREFIX}${message.key}`;
    const existing = channelId
      ? await getPool().query(
          `SELECT 1 FROM messages WHERE channel_id = $1 AND author_id = $2 AND nonce = $3`,
          [channelId, author.id, nonce],
        )
      : null;
    if (existing?.rowCount) {
      had += 1;
      continue;
    }
    made += 1;
    if (!apply || !channelId) {
      continue;
    }
    const created = await createMessage(
      channelId,
      author,
      message.body,
      null,
      undefined,
      undefined,
      undefined,
      nonce,
    );
    if (!created) {
      throw new ReviewSeedError(`Message "${message.key}" was not stored.`);
    }
    await getPool().query(
      `UPDATE messages SET created_at = NOW() - make_interval(mins => $2::int) WHERE id = $1`,
      [created.id, message.minutesAgo],
    );
  }
  rec.note(
    made > 0 ? "create" : "exists",
    made > 0
      ? `${made} direct message(s) (${had} already there), English and pt-BR, over the last few days`
      : `all ${had} direct messages`,
  );
  return { channelId, newMessages: made, appears };
}

/**
 * Delete the demo account's PENDING friend requests, and only those. The row
 * with Demo Friend is left to `seedFriendship`; an accepted row never matches
 * `status = 'pending'`; a row between two other accounts never matches the
 * demo id. Names are printed, never emails.
 */
async function clearPendingRequests(
  demo: SeedUser,
  friendId: string | null,
  rec: Recorder,
  apply: boolean,
): Promise<{ incoming: number; outgoing: number }> {
  const rows = await getPool().query<{
    low_user_id: string;
    high_user_id: string;
    requested_by: string;
    display_name: string;
    age_days: number;
  }>(
    `SELECT f.low_user_id, f.high_user_id, f.requested_by, u.display_name,
            floor(extract(epoch FROM (NOW() - f.created_at)) / 86400)::int AS age_days
       FROM friendships f
       JOIN users u ON u.id = CASE WHEN f.low_user_id = $1 THEN f.high_user_id ELSE f.low_user_id END
      WHERE f.status = 'pending'
        AND (f.low_user_id = $1 OR f.high_user_id = $1)
        AND ($2::uuid IS NULL OR u.id <> $2::uuid)
      ORDER BY f.created_at`,
    [demo.id, friendId],
  );
  let incoming = 0;
  let outgoing = 0;
  if (rows.rows.length === 0) {
    rec.note("exists", "no pending friend requests to clear");
    return { incoming, outgoing };
  }
  for (const row of rows.rows) {
    const sent = row.requested_by === demo.id;
    if (apply) {
      const deleted = await getPool().query(
        `DELETE FROM friendships
          WHERE low_user_id = $1 AND high_user_id = $2 AND status = 'pending'`,
        [row.low_user_id, row.high_user_id],
      );
      if (!deleted.rowCount) {
        continue;
      }
    }
    if (sent) {
      outgoing += 1;
    } else {
      incoming += 1;
    }
    rec.note(
      "leave",
      `${apply ? "deleted" : "would delete"} pending request ${sent ? "to" : "from"} ` +
        `"${row.display_name}" (${sent ? "sent" : "received"} ${row.age_days} day(s) ago)`,
    );
  }
  return { incoming, outgoing };
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
      // The HTTP leave route also evicts the user's open channel views, locally
      // and over the bus (`evictUserFromChannels`, topic `chat.evict`). Without
      // this a socket already watching that server keeps receiving its messages.
      const channels = await getPool().query<{ id: string }>(
        `SELECT id FROM channels WHERE server_id = $1`,
        [row.id],
      );
      publishToCluster("chat.evict", {
        kind: "user",
        userId: demo.id,
        channelIds: channels.rows.map((channel) => channel.id),
      });
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
  const blockMe = await findBlockMe();
  if (found.length === 0 && !friend && !blockMe) {
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
      (row) =>
        row.user_id !== demo.id &&
        row.user_id !== friend?.id &&
        row.user_id !== blockMe?.id,
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
        `server ${server.id} has ${strangers.length} member(s) besides the seeded accounts. ` +
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
    // The 1:1 conversation is a channel with no server, so deleting the friend
    // does not take it (only its dm_pairs and member rows cascade): the demo
    // account's own messages would be left in a channel nobody can open.
    const dmChannelId = await findDmChannel(demo.id, friend.id);
    if (dmChannelId) {
      const dm = await getPool().query<{ total: number; seeded: number }>(
        `SELECT count(*)::int AS total,
                count(*) FILTER (WHERE nonce LIKE $2)::int AS seeded
           FROM messages WHERE channel_id = $1`,
        [dmChannelId, `${REVIEW_NONCE_PREFIX}%`],
      );
      const { total, seeded } = dm.rows[0]!;
      if (apply) {
        // kind = 'dm' and the pair are re-asserted in the statement itself.
        await getPool().query(
          `DELETE FROM channels
            WHERE id = $1 AND kind = 'dm'
              AND EXISTS (SELECT 1 FROM dm_pairs WHERE channel_id = $1)`,
          [dmChannelId],
        );
        invalidateChannelAccessForChannel(dmChannelId);
      }
      rec.note(
        "leave",
        `${apply ? "deleted" : "would delete"} the 1:1 conversation with "${REVIEW_FRIEND_NAME}" ` +
          `(${dmChannelId}) with ${total} message(s)` +
          (total > seeded ? `, ${total - seeded} of them typed by somebody, not seeded` : ""),
      );
    }
    const [low, high] = sortedPair(demo.id, friend.id);
    const hadFriendship = await getPool().query(
      `SELECT 1 FROM friendships WHERE low_user_id = $1 AND high_user_id = $2`,
      [low, high],
    );
    if (hadFriendship.rowCount) {
      if (apply) {
        await getPool().query(
          `DELETE FROM friendships WHERE low_user_id = $1 AND high_user_id = $2`,
          [low, high],
        );
      }
      rec.note("leave", `${apply ? "deleted" : "would delete"} the friendship with "${REVIEW_FRIEND_NAME}"`);
    }
    if (apply) {
      // Cascades character_accounts, memberships and any leftover messages.
      await getPool().query(`DELETE FROM users WHERE id = $1 AND is_character`, [friend.id]);
    }
    rec.note("leave", `${apply ? "deleted" : "would delete"} account "${REVIEW_FRIEND_NAME}" (${friend.id})`);
  }
  if (blockMe) {
    if (apply) {
      // Cascades character_accounts, its membership, its messages and any
      // block or report that names it.
      await getPool().query(`DELETE FROM users WHERE id = $1 AND is_character`, [blockMe.id]);
    }
    rec.note("leave", `${apply ? "deleted" : "would delete"} account "${REVIEW_BLOCKME_NAME}" (${blockMe.id})`);
  }
  return report;
}

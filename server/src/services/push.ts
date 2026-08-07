import webPush from "web-push";
import { z } from "zod";
import type { ChannelKind, UserPreferences } from "@pqp/shared";
import { getPool } from "../db.js";
import { getPreferences, mergePreferences } from "./preferences.js";
import { isInvisible, resolveStatus } from "../ws/status.js";

/**
 * Web Push — how a mention, reply or DM reaches a phone that is closed.
 *
 * Everything here is inert unless all three VAPID_* env vars are set, the same
 * posture as S3: an instance with no keys answers `enabled: false`, stores no
 * subscriptions, and sends nothing. There is no partial mode.
 *
 * The `web-push` dependency is deliberate, not convenience. Sending one push
 * means per-message ECDH key agreement + HKDF + AES-128-GCM payload encryption
 * (RFC 8291) and a signed VAPID JWT over ES256 (RFC 8292), with each browser
 * vendor's push service rejecting slightly-wrong encodings in slightly
 * different ways. That is exactly the category of crypto this codebase does
 * not hand-roll — a home-grown encoder that got a salt length wrong would fail
 * only on one vendor's service, in production, silently.
 *
 * WHO GETS A PUSH IS NOT DECIDED HERE. `notifyChannelActivity` in ws/chat.ts
 * already answers "who deserves to hear about this message" — audience,
 * blocks, mentions — and this module is handed its conclusions. What is
 * decided here is only the push-specific narrowing: no live socket anywhere,
 * not on do-not-disturb, and a per-channel level that allows it.
 *
 * PUSHES FIRE ON THE ORIGIN INSTANCE ONLY. A user with no socket is on no
 * instance, so if the cluster-bus copy of the activity fan-out also pushed,
 * every instance would send the same notification once. The bus handler in
 * chat.ts passes `webPush: false` for exactly this reason.
 */

// ------------------------------------------------------------ configuration

export interface VapidConfig {
  publicKey: string;
  privateKey: string;
  subject: string;
}

/**
 * Read the env on every call rather than caching at import: this module loads
 * before dotenv has necessarily run in some entrypoints, and tests flip the
 * variables per case. Three string reads per message is not a cost.
 */
export function readVapidConfig(): VapidConfig | null {
  const publicKey = process.env.VAPID_PUBLIC_KEY;
  const privateKey = process.env.VAPID_PRIVATE_KEY;
  const subject = process.env.VAPID_SUBJECT;
  if (!publicKey || !privateKey || !subject) {
    return null;
  }
  return { publicKey, privateKey, subject };
}

export function isPushEnabled(): boolean {
  return readVapidConfig() !== null;
}

/** What the client needs to call `pushManager.subscribe`. Never the private key. */
export function getVapidPublicKey(): string | null {
  return readVapidConfig()?.publicKey ?? null;
}

// ------------------------------------------------------- route body schemas

/**
 * The shape `PushSubscription.toJSON()` produces. `https` is required rather
 * than assumed: the endpoint is a URL this server will later POST encrypted
 * payloads to, so accepting an attacker-supplied plain-http collector would
 * turn every push into a beacon.
 */
export const pushSubscriptionSchema = z.object({
  endpoint: z
    .string()
    .url()
    .max(2048)
    .refine((value) => value.startsWith("https://"), {
      message: "Push endpoints must be https",
    }),
  keys: z.object({
    p256dh: z.string().min(1).max(512),
    auth: z.string().min(1).max(512),
  }),
});

export type PushSubscriptionBody = z.infer<typeof pushSubscriptionSchema>;

export const pushSettingsSchema = z.object({
  /**
   * Whether a DM push may name the sender. Defaults to false — "no content in
   * pushes" is ON for direct messages until the user says otherwise, because a
   * lock screen is the one surface other people routinely see.
   */
  dmDetails: z.boolean(),
});

// -------------------------------------------------------------- settings

/**
 * Push settings ride in `user_preferences.settings.push`, next to the levels
 * and manual status this module also reads at send time. The key is not part
 * of `userPreferencesSchema` on purpose: `PATCH /api/me/preferences` strips
 * unknown keys, so the only writer is `savePushSettings` below — and the jsonb
 * merge in `mergePreferences` means a client patching its theme can never drop
 * it.
 */
interface PushSettings {
  dmDetails?: boolean;
}

function readPushSettings(settings: UserPreferences | null): PushSettings {
  const push = (settings as { push?: unknown } | null)?.push;
  if (typeof push !== "object" || push === null) {
    return {};
  }
  const record = push as Record<string, unknown>;
  return { dmDetails: record.dmDetails === true };
}

export function wantsDmDetails(settings: UserPreferences | null): boolean {
  return readPushSettings(settings).dmDetails === true;
}

export async function getPushSettings(
  userId: string,
): Promise<{ dmDetails: boolean }> {
  return { dmDetails: wantsDmDetails(await getPreferences(userId)) };
}

export async function savePushSettings(
  userId: string,
  settings: { dmDetails: boolean },
): Promise<{ dmDetails: boolean }> {
  const merged = await mergePreferences(userId, {
    push: { dmDetails: settings.dmDetails },
  } as unknown as UserPreferences);
  return { dmDetails: wantsDmDetails(merged) };
}

// ---------------------------------------------------------- subscriptions

/**
 * Enough for a phone, a laptop, a desktop and some churn; small enough that
 * one account cannot make every mention cost hundreds of vendor round-trips.
 */
export const MAX_PUSH_SUBSCRIPTIONS_PER_USER = 8;

export interface StoredPushSubscription {
  id: string;
  user_id: string;
  endpoint: string;
  p256dh: string;
  auth: string;
}

/**
 * Upsert on the endpoint, not on (user, endpoint): a browser profile has one
 * endpoint, and if a second account subscribes on the same device the endpoint
 * must follow the account that is actually signed in — two rows would push
 * user A's mentions to whoever holds the phone now.
 *
 * Past the cap the *oldest* rows go. Old is the right axis: the newest
 * subscription is the device the user is holding right now, and the stalest is
 * the most likely to be a browser profile that no longer exists.
 */
export async function savePushSubscription(
  userId: string,
  body: PushSubscriptionBody,
): Promise<void> {
  const pool = getPool();
  await pool.query(
    `INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (endpoint) DO UPDATE
       SET user_id = EXCLUDED.user_id,
           p256dh = EXCLUDED.p256dh,
           auth = EXCLUDED.auth,
           created_at = NOW()`,
    [userId, body.endpoint, body.keys.p256dh, body.keys.auth],
  );
  await pool.query(
    `DELETE FROM push_subscriptions
     WHERE user_id = $1
       AND id NOT IN (
         SELECT id FROM push_subscriptions
         WHERE user_id = $1
         ORDER BY created_at DESC, id DESC
         LIMIT $2
       )`,
    [userId, MAX_PUSH_SUBSCRIPTIONS_PER_USER],
  );
}

/** Scoped by user id as well as endpoint, so nobody can delete another account's. */
export async function deletePushSubscription(
  userId: string,
  endpoint: string,
): Promise<void> {
  await getPool().query(
    `DELETE FROM push_subscriptions WHERE user_id = $1 AND endpoint = $2`,
    [userId, endpoint],
  );
}

export async function listPushSubscriptions(
  userId: string,
): Promise<StoredPushSubscription[]> {
  const result = await getPool().query<StoredPushSubscription>(
    `SELECT id, user_id, endpoint, p256dh, auth
     FROM push_subscriptions WHERE user_id = $1
     ORDER BY created_at DESC`,
    [userId],
  );
  return result.rows;
}

async function pruneSubscription(id: string): Promise<void> {
  await getPool().query(`DELETE FROM push_subscriptions WHERE id = $1`, [id]);
}

// ------------------------------------------------------------- test seams

/**
 * How a given push should travel, decided per *event kind* rather than per
 * subscription: a message and a call have opposite relationships with time.
 */
export interface PushDeliveryOptions {
  /** How long the vendor may hold the push for an unreachable device. */
  ttlSeconds: number;
  /** RFC 8030 Urgency — whether a dozing device should wake for this. */
  urgency: "normal" | "high";
}

type PushSender = (
  subscription: StoredPushSubscription,
  payload: string,
  config: VapidConfig,
  delivery: PushDeliveryOptions,
) => Promise<void>;

/**
 * A push older than a day is about a conversation that has moved on; better it
 * evaporates at the vendor than lands stale.
 */
export const PUSH_TTL_SECONDS = 24 * 60 * 60;

/**
 * A call push, by contrast, is about something that stops existing when the
 * ring times out (`CALL_RING_TIMEOUT_MS` = 45s): delivered at minute two it is
 * not late, it is *wrong* — a phone buzzing about a call nobody is placing.
 * Ring timeout plus a little transit slack, and nothing more. This asymmetry
 * is the whole reason calls have their own send path instead of riding
 * `sendChannelPush`.
 */
export const CALL_PUSH_TTL_SECONDS = 50;

const MESSAGE_DELIVERY: PushDeliveryOptions = {
  ttlSeconds: PUSH_TTL_SECONDS,
  urgency: "normal",
};

/** High urgency is what asks the vendor to wake a device in doze for the ring. */
const CALL_DELIVERY: PushDeliveryOptions = {
  ttlSeconds: CALL_PUSH_TTL_SECONDS,
  urgency: "high",
};

const realSender: PushSender = async (subscription, payload, config, delivery) => {
  await webPush.sendNotification(
    {
      endpoint: subscription.endpoint,
      keys: { p256dh: subscription.p256dh, auth: subscription.auth },
    },
    payload,
    {
      TTL: delivery.ttlSeconds,
      urgency: delivery.urgency,
      // Per call rather than `setVapidDetails` at module scope, so nothing
      // global is mutated and a test can never see another test's keys.
      vapidDetails: {
        subject: config.subject,
        publicKey: config.publicKey,
        privateKey: config.privateKey,
      },
    },
  );
};

let sender: PushSender = realSender;

export function setPushSenderForTests(next: PushSender | null): void {
  sender = next ?? realSender;
}

/**
 * "Is this person connected anywhere in the cluster?" — the status registry
 * already merges every instance's contribution, so this is one in-memory read.
 *
 * `resolveStatus` alone is not the answer: it reports `offline` for an
 * *invisible* user who is very much connected and reading the channel live, and
 * pushing their phone as well would double-notify exactly the people who asked
 * to be least visible. Hence the second check.
 */
function registryHasLiveSocket(userId: string): boolean {
  return resolveStatus(userId) !== "offline" || isInvisible(userId);
}

let hasLiveSocket: (userId: string) => boolean = registryHasLiveSocket;

export function setLiveSocketProbeForTests(
  next: ((userId: string) => boolean) | null,
): void {
  hasLiveSocket = next ?? registryHasLiveSocket;
}

// --------------------------------------------------------------- decisions

export type ManualStatusLike = string | undefined;

export interface PushDecisionInput {
  /** Mentioned by name or replied to — the two "you specifically" signals. */
  mention: boolean;
  channelKind: ChannelKind;
  /** `user_preferences.settings.status`, read at send time. */
  manualStatus: ManualStatusLike;
  /** The resolved notification level for this channel (most specific wins). */
  level: "all" | "mentions" | "none";
}

/**
 * The push-worthiness matrix, kept pure so the tests can walk it exhaustively.
 *
 * - DND wins over everything: it is checked server-side at send time because
 *   the client that normally suppresses interruptions is, by definition of
 *   this whole feature, not running.
 * - "none" is a mute, and a mute muted the phone too.
 * - A mention or reply pushes at "all" and "mentions" alike.
 * - A conversation message (dm/group) pushes only at "all" — turning a
 *   conversation to "mentions" says plain messages should not buzz, and the
 *   phone honours the same choice the desktop does.
 * - A plain server-channel message NEVER pushes, whatever the level. That is
 *   requirement one of this feature: mentions, replies and DMs only.
 */
export function shouldPush(input: PushDecisionInput): boolean {
  if (input.manualStatus === "dnd") {
    return false;
  }
  if (input.level === "none") {
    return false;
  }
  if (input.mention) {
    return true;
  }
  if (input.channelKind !== "server") {
    return input.level === "all";
  }
  return false;
}

/**
 * The same most-specific-wins resolution the client's
 * `resolveNotificationLevel` performs, over the same stored object — kept in
 * lockstep so the phone and the desktop cannot disagree about a mute.
 */
export function resolvePushLevel(
  settings: UserPreferences | null,
  serverId: string | null,
  channelId: string,
): "all" | "mentions" | "none" {
  const notifications = settings?.notifications;
  const channelLevel = notifications?.channels?.[channelId];
  if (channelLevel) {
    return channelLevel;
  }
  if (serverId) {
    const serverLevel = notifications?.servers?.[serverId];
    if (serverLevel) {
      return serverLevel;
    }
  }
  return notifications?.default ?? "all";
}

// ----------------------------------------------------------------- payload

/**
 * Everything past this is noise on a lock screen, and every extra byte is a
 * byte encrypted, transferred and stored by a third party's push service.
 */
export const PUSH_LABEL_MAX_LENGTH = 64;

export function truncateLabel(value: string): string {
  if (value.length <= PUSH_LABEL_MAX_LENGTH) {
    return value;
  }
  return `${value.slice(0, PUSH_LABEL_MAX_LENGTH - 1)}…`;
}

export interface PushPayloadInput {
  channelKind: ChannelKind;
  /** True when this recipient was @-mentioned; false for a reply / plain DM. */
  mention: boolean;
  reply: boolean;
  dmDetails: boolean;
  channelId: string;
  serverId: string | null;
  channelName: string | null;
  serverName: string | null;
  authorName: string | null;
}

export interface PushPayload {
  title: string;
  body: string;
  /** SPA path the service worker opens on tap. */
  path: string;
  /** One live notification per channel — same collapsing the in-app path uses. */
  tag: string;
}

/**
 * MESSAGE BODIES ARE NEVER IN A PUSH. The payload is built from ids and names
 * only — the fan-out this rides on (`notifyChannelActivity`) deliberately does
 * not carry message content, so there is nothing here to leak even by mistake.
 *
 * What `dmDetails` governs is the *sender's identity* on a direct message:
 * off (the default), a DM push says "New direct message" and nothing else;
 * on, it names who. Server-channel mention pushes always name the channel and
 * author — that is addressing metadata a fellow server member already sees,
 * and a push that says only "something happened somewhere" is not actionable.
 */
export function buildPushPayload(input: PushPayloadInput): PushPayload {
  const tag = input.channelId;
  if (input.channelKind === "server") {
    const channel = input.channelName
      ? `#${truncateLabel(input.channelName)}`
      : "a channel";
    const title = input.serverName
      ? `${channel} — ${truncateLabel(input.serverName)}`
      : channel;
    const author = input.authorName
      ? truncateLabel(input.authorName)
      : "Someone";
    return {
      title,
      body: input.mention ? `${author} mentioned you` : `${author} replied to you`,
      path: input.serverId
        ? `/app/server/${input.serverId}/channel/${input.channelId}`
        : "/app",
      tag,
    };
  }

  const path = `/app/dm/${input.channelId}`;
  if (!input.dmDetails) {
    return {
      title: "pqp",
      body:
        input.channelKind === "group"
          ? "New group message"
          : "New direct message",
      path,
      tag,
    };
  }
  const author = input.authorName ? truncateLabel(input.authorName) : "Someone";
  return {
    title: author,
    body:
      input.channelKind === "group"
        ? "New message in a group chat"
        : input.mention || input.reply
          ? "Mentioned you in a direct message"
          : "Sent you a direct message",
    path,
    tag,
  };
}

// ---------------------------------------------------------------- fan-out

/**
 * The slice of `ChannelAudience` this module needs. Structural so chat.ts can
 * hand over the exact object its own fan-out already resolved — the audience
 * decision is made once, there.
 */
export interface ChannelAudienceView {
  serverId: string | null;
  kind: ChannelKind;
  has(userId: string): boolean;
  readonly userIds: readonly string[];
}

export interface ChannelPushEvent {
  channelId: string;
  audience: ChannelAudienceView;
  authorId: string;
  /** Already extracted and lowercased by the message path. */
  mentionedUsernames: readonly string[];
  repliedToUserId: string | null;
  /** Users who blocked the author — they get no notification of any kind. */
  blockerIds: ReadonlySet<string>;
}

/**
 * Fire-and-forget wrapper: the message fan-out must never wait on, or die
 * with, a push vendor. Same rule as `resolveEmbedInBackground` — an unhandled
 * rejection here would take the whole process down (CLAUDE.md pitfall #9).
 */
export function pushChannelActivity(event: ChannelPushEvent): void {
  if (!isPushEnabled()) {
    return;
  }
  void sendChannelPush(event).catch((error) => {
    console.error(
      `[push] fan-out failed for channel ${event.channelId}:`,
      error,
    );
  });
}

interface PreferenceRow {
  user_id: string;
  settings: UserPreferences;
}

/**
 * The full pipeline, awaitable so tests can assert on its effects.
 *
 * Order is cheapest-first: the in-memory socket probe runs before any query,
 * and no query runs at all for a plain server-channel message with no mentions
 * — which is almost every message.
 */
export async function sendChannelPush(event: ChannelPushEvent): Promise<void> {
  const config = readVapidConfig();
  if (!config) {
    return;
  }
  const { audience } = event;

  // Who was addressed by name. Resolved against `users` with the same exact
  // `username = ANY(...)` semantics `recordMentions` uses, then intersected
  // with the audience — a mention of somebody who cannot see the channel is
  // not a notification, exactly as in the socket fan-out.
  const mentioned = new Set<string>();
  if (event.mentionedUsernames.length > 0) {
    const result = await getPool().query<{ id: string }>(
      `SELECT id FROM users WHERE username = ANY($1::text[])`,
      [event.mentionedUsernames],
    );
    for (const row of result.rows) {
      if (audience.has(row.id)) {
        mentioned.add(row.id);
      }
    }
  }
  const replied =
    event.repliedToUserId && audience.has(event.repliedToUserId)
      ? event.repliedToUserId
      : null;

  // Requirement one, structurally: for a server channel the candidate list is
  // built from mentions and the reply target, so a plain message cannot reach
  // the push path at all. A conversation's candidates are its participants —
  // a handful of people, so materialising `userIds` is cheap there.
  const candidateIds =
    audience.kind === "server"
      ? [...new Set([...mentioned, ...(replied ? [replied] : [])])]
      : audience.userIds;

  const offline = candidateIds.filter(
    (userId) =>
      userId !== event.authorId &&
      !event.blockerIds.has(userId) &&
      !hasLiveSocket(userId),
  );
  if (offline.length === 0) {
    return;
  }

  // DND and levels, read at send time — the client that usually applies them
  // is not running, which is the only reason we are here.
  const preferenceRows = await getPool().query<PreferenceRow>(
    `SELECT user_id, settings FROM user_preferences
     WHERE user_id = ANY($1::uuid[])`,
    [offline],
  );
  const preferences = new Map<string, UserPreferences>(
    preferenceRows.rows.map((row) => [row.user_id, row.settings]),
  );

  const recipients = offline.filter((userId) => {
    const settings = preferences.get(userId) ?? null;
    return shouldPush({
      mention: mentioned.has(userId) || userId === replied,
      channelKind: audience.kind,
      manualStatus: settings?.status,
      level: resolvePushLevel(settings, audience.serverId, event.channelId),
    });
  });
  if (recipients.length === 0) {
    return;
  }

  // One context read for the whole batch: channel + server names and the
  // author's display name are the same for every recipient.
  const context = await getPool().query<{
    channel_name: string | null;
    server_name: string | null;
    author_name: string | null;
  }>(
    `SELECT c.name AS channel_name, s.name AS server_name,
            (SELECT display_name FROM users WHERE id = $2) AS author_name
     FROM channels c
     LEFT JOIN servers s ON s.id = c.server_id
     WHERE c.id = $1`,
    [event.channelId, event.authorId],
  );
  const names = context.rows[0] ?? {
    channel_name: null,
    server_name: null,
    author_name: null,
  };

  const payloads = new Map<string, string>();
  for (const userId of recipients) {
    const settings = preferences.get(userId) ?? null;
    payloads.set(
      userId,
      JSON.stringify(
        buildPushPayload({
          channelKind: audience.kind,
          mention: mentioned.has(userId),
          reply: userId === replied,
          dmDetails: wantsDmDetails(settings),
          channelId: event.channelId,
          serverId: audience.serverId,
          channelName: names.channel_name,
          serverName: names.server_name,
          authorName: names.author_name,
        }),
      ),
    );
  }

  await deliverToUsers(recipients, (userId) => payloads.get(userId), config, MESSAGE_DELIVERY);
}

/**
 * The shared last mile: look up every recipient's subscriptions, hand each to
 * the sender, prune on the vendor's "gone" signal. Both the message path and
 * the call path end here — they differ in who and what, never in how.
 */
async function deliverToUsers(
  userIds: readonly string[],
  payloadFor: (userId: string) => string | undefined,
  config: VapidConfig,
  delivery: PushDeliveryOptions,
): Promise<void> {
  const subscriptions = await getPool().query<StoredPushSubscription>(
    `SELECT id, user_id, endpoint, p256dh, auth
     FROM push_subscriptions
     WHERE user_id = ANY($1::uuid[])`,
    [userIds],
  );

  await Promise.all(
    subscriptions.rows.map(async (subscription) => {
      const payload = payloadFor(subscription.user_id);
      if (!payload) {
        return;
      }
      try {
        await sender(subscription, payload, config, delivery);
      } catch (error) {
        const statusCode = (error as { statusCode?: number }).statusCode;
        // 404/410 is the vendor saying this subscription no longer exists —
        // the user cleared site data, or the browser rotated it. Pruning on
        // this signal is the only garbage collection these rows get.
        if (statusCode === 404 || statusCode === 410) {
          await pruneSubscription(subscription.id).catch(() => {
            // Best-effort: the next 410 will try again.
          });
          return;
        }
        console.error(
          `[push] send failed (${statusCode ?? "network"}) for user ${subscription.user_id}`,
        );
      }
    }),
  );
}

// ------------------------------------------------------------ incoming calls

/**
 * A ringing call, as `handleCallRing` in ws/voice.ts concluded it. WHO IS
 * BEING RUNG IS NOT DECIDED HERE — `rungUserIds` is the ring's own answer
 * (absent participants, minus people who blocked the caller, minus anyone the
 * live status registry shows as DND), and this module narrows it only by the
 * two things the ring cannot see: no live socket anywhere in the cluster, and
 * a *stored* DND. The second matters because the registry answers "offline"
 * for a disconnected user whatever their manual status says — a person who
 * set do-not-disturb and closed the app was never rung, and must not be the
 * one person whose phone still buzzes.
 *
 * Notification levels are deliberately NOT consulted, because the ring does
 * not consult them either: a muted conversation still rings a live client,
 * and the push is that same ring reaching a closed one, not a message badge.
 */
export interface CallPushEvent {
  conversationId: string;
  kind: "dm" | "group";
  /** The ring's conclusion — see above. */
  rungUserIds: readonly string[];
  callerName: string | null;
}

/**
 * A CALL PUSH ALWAYS NAMES THE CALLER, `dmDetails` notwithstanding. That
 * setting keeps message *activity* off a lock screen; a call is different in
 * kind — the ring surface itself shows who is calling on every live device,
 * an anonymous "incoming call" is not an answerable question, and the payload
 * still carries nothing about the conversation beyond who is calling.
 *
 * `tag` is the conversation id — the same tag `buildPushPayload` gives the
 * missed-call message that follows an unanswered ring, so the vendor replaces
 * "Incoming call" with the missed-call notice instead of stacking the two.
 * `path` is the conversation route: tapped while the ring is live it lands on
 * the ringing call, tapped later it lands on the missed-call message.
 */
export function buildCallPushPayload(input: {
  conversationId: string;
  kind: "dm" | "group";
  callerName: string | null;
}): PushPayload {
  return {
    title: input.callerName ? truncateLabel(input.callerName) : "Someone",
    body: input.kind === "group" ? "Incoming group call" : "Incoming call",
    path: `/app/dm/${input.conversationId}`,
    tag: input.conversationId,
  };
}

/**
 * Fire-and-forget wrapper, same contract as `pushChannelActivity`: the ring
 * fan-out must never wait on, or die with, a push vendor (pitfall #9).
 */
export function pushIncomingCall(event: CallPushEvent): void {
  if (!isPushEnabled()) {
    return;
  }
  void sendCallPush(event).catch((error) => {
    console.error(
      `[push] call fan-out failed for conversation ${event.conversationId}:`,
      error,
    );
  });
}

/** The awaitable pipeline, mirroring `sendChannelPush` for tests. */
export async function sendCallPush(event: CallPushEvent): Promise<void> {
  const config = readVapidConfig();
  if (!config) {
    return;
  }

  const offline = event.rungUserIds.filter((userId) => !hasLiveSocket(userId));
  if (offline.length === 0) {
    return;
  }

  // Stored DND only — the audience, blocks and live-DND questions were the
  // ring's to answer and already are answered in `rungUserIds`.
  const preferenceRows = await getPool().query<PreferenceRow>(
    `SELECT user_id, settings FROM user_preferences
     WHERE user_id = ANY($1::uuid[])`,
    [offline],
  );
  const preferences = new Map<string, UserPreferences>(
    preferenceRows.rows.map((row) => [row.user_id, row.settings]),
  );
  const recipients = offline.filter(
    (userId) => preferences.get(userId)?.status !== "dnd",
  );
  if (recipients.length === 0) {
    return;
  }

  // One payload for everybody: a call names its caller, never its callee.
  const payload = JSON.stringify(
    buildCallPushPayload({
      conversationId: event.conversationId,
      kind: event.kind,
      callerName: event.callerName,
    }),
  );
  await deliverToUsers(recipients, () => payload, config, CALL_DELIVERY);
}

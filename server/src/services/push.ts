import webPush from "web-push";
import { z } from "zod";
import type { ChannelKind, UserPreferences } from "@pqp/shared";
import { getPool } from "../db.js";
import { getPreferences, mergePreferences } from "./preferences.js";
import { isInvisible, resolveStatus } from "../ws/status.js";
import {
  type ApnsConfig,
  isApnsEnabled,
  isApnsTokenGone,
  readApnsConfig,
  sendApnsPush,
} from "./apns.js";

/**
 * Push — how a mention, reply or DM reaches a phone that is closed.
 *
 * TWO LEGS, ONE DECISION. Web Push (VAPID, for browsers and the installed PWA)
 * and APNs (for the native iOS app) are different transports for the same
 * conclusion. Everything above the last mile — who is a candidate, who has no
 * live socket, whose level allows it, what the notification says — is decided
 * once here and handed to both. `deliverToUsers` is where they diverge, and it
 * is the only place they do. Adding a platform means adding a branch there and
 * a row shape in `push_subscriptions`, not a parallel pipeline.
 *
 * Each leg is inert unless its own env is set, the same posture as S3: an
 * instance with no VAPID keys answers `enabled: false` to the browser and
 * stores no subscriptions; an instance with no APNs key refuses device tokens.
 * There is no partial mode within a leg. An instance with neither sends
 * nothing and does no work at all.
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

/**
 * Whether the *Web Push* leg can send. Named without a qualifier for history:
 * the web client reads it through `/api/push/config` to decide whether to offer
 * its toggle, and that answer is about VAPID specifically. Use
 * `isAnyPushEnabled` for "is there any point doing push work at all".
 */
export function isPushEnabled(): boolean {
  return readVapidConfig() !== null;
}

/**
 * The guard on the fan-out entry points. A deployment with APNs configured but
 * no VAPID keys must still push to phones — checking only VAPID here is the
 * bug that would make the whole iOS leg dead on a server that never wanted the
 * web one.
 */
export function isAnyPushEnabled(): boolean {
  return isPushEnabled() || isApnsEnabled();
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

/**
 * An APNs device token, as `didRegisterForRemoteNotificationsWithDeviceToken`
 * hands it over: 32 bytes hex-encoded today, but Apple has changed the length
 * before (it went from 32 to 100 bytes for a while) and explicitly documents
 * that the size is not fixed. So the shape is checked — lowercase hex, because
 * that is what the app's own encoder produces — and the length is bounded
 * generously rather than pinned.
 */
export const apnsSubscriptionSchema = z.object({
  platform: z.literal("apns"),
  token: z
    .string()
    .min(32)
    .max(400)
    .regex(/^[0-9a-f]+$/, "APNs device tokens are lowercase hex"),
});

export type ApnsSubscriptionBody = z.infer<typeof apnsSubscriptionSchema>;

/**
 * What `POST /api/push/subscriptions` accepts. A union rather than a second
 * route, so "register this device for notifications" stays one endpoint.
 *
 * ORDER MATTERS AND IS THE COMPATIBILITY GUARANTEE: the APNs member is tried
 * first and requires `platform: "apns"`, which a Web Push body does not carry,
 * so every request the web client has ever sent still parses as it did before.
 */
export const pushRegistrationSchema = z.union([
  apnsSubscriptionSchema,
  pushSubscriptionSchema,
]);

export type PushRegistrationBody = z.infer<typeof pushRegistrationSchema>;

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

export type PushPlatform = "web" | "apns";

/**
 * One row shape for both legs. The nullability is not sloppiness — it is the
 * `platform` discriminant, and the CHECK constraint in schema.sql is what makes
 * it a real one: a `web` row has an endpoint and keys and no token, an `apns`
 * row has a token and neither. Reading a row means switching on `platform`
 * first, exactly as the delivery code below does.
 */
export interface StoredPushSubscription {
  id: string;
  user_id: string;
  platform: PushPlatform;
  /** Web Push only. */
  endpoint: string | null;
  p256dh: string | null;
  auth: string | null;
  /** APNs only. */
  token: string | null;
}

const SUBSCRIPTION_COLUMNS =
  "id, user_id, platform, endpoint, p256dh, auth, token";

/**
 * Trim to the cap, oldest first. Old is the right axis: the newest subscription
 * is the device the user is holding right now, and the stalest is the most
 * likely to be a browser profile that no longer exists.
 *
 * The cap is per *account*, across both platforms deliberately: the thing being
 * bounded is how many vendor round-trips one mention can cost, and a phone's
 * APNs token costs exactly as much as a laptop's endpoint.
 */
async function trimSubscriptions(userId: string): Promise<void> {
  await getPool().query(
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

/**
 * Upsert on the endpoint, not on (user, endpoint): a browser profile has one
 * endpoint, and if a second account subscribes on the same device the endpoint
 * must follow the account that is actually signed in — two rows would push
 * user A's mentions to whoever holds the phone now.
 */
export async function savePushSubscription(
  userId: string,
  body: PushSubscriptionBody,
): Promise<void> {
  await getPool().query(
    `INSERT INTO push_subscriptions (user_id, platform, endpoint, p256dh, auth)
     VALUES ($1, 'web', $2, $3, $4)
     ON CONFLICT (endpoint) DO UPDATE
       SET user_id = EXCLUDED.user_id,
           platform = 'web',
           p256dh = EXCLUDED.p256dh,
           auth = EXCLUDED.auth,
           created_at = NOW()`,
    [userId, body.endpoint, body.keys.p256dh, body.keys.auth],
  );
  await trimSubscriptions(userId);
}

/**
 * The APNs equivalent, upserting on the token for exactly the same reason: one
 * device has one token, and if two accounts sign in on the same phone the token
 * must follow whoever is signed in now — the alternative is one person's DMs on
 * another person's lock screen.
 *
 * Re-posting an unchanged token is the normal case, not an edge one: iOS hands
 * the token to the app on *every* launch and it may silently differ, so the app
 * is expected to send it every time. That makes this the hottest write in the
 * push surface, which is why it is one statement with no read first.
 */
export async function saveApnsSubscription(
  userId: string,
  token: string,
): Promise<void> {
  await getPool().query(
    // `WHERE platform = 'apns'` is not a filter on the update — it is how
    // Postgres *infers* which index arbitrates the conflict. The uniqueness on
    // `token` is a partial index (see schema.sql: `web` rows all have a null
    // token), and inference against a partial index requires its predicate
    // restated here. Omit it and every insert fails with "no unique or
    // exclusion constraint matching the ON CONFLICT specification".
    `INSERT INTO push_subscriptions (user_id, platform, token)
     VALUES ($1, 'apns', $2)
     ON CONFLICT (token) WHERE platform = 'apns' DO UPDATE
       SET user_id = EXCLUDED.user_id,
           created_at = NOW()`,
    [userId, token],
  );
  await trimSubscriptions(userId);
}

/** Dispatches on the discriminant so the route stays four lines. */
export async function savePushRegistration(
  userId: string,
  body: PushRegistrationBody,
): Promise<void> {
  if ("platform" in body && body.platform === "apns") {
    await saveApnsSubscription(userId, body.token);
    return;
  }
  await savePushSubscription(userId, body as PushSubscriptionBody);
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

/** Same scoping, for a phone turning notifications off. */
export async function deleteApnsSubscription(
  userId: string,
  token: string,
): Promise<void> {
  await getPool().query(
    `DELETE FROM push_subscriptions
     WHERE user_id = $1 AND platform = 'apns' AND token = $2`,
    [userId, token],
  );
}

export async function listPushSubscriptions(
  userId: string,
): Promise<StoredPushSubscription[]> {
  const result = await getPool().query<StoredPushSubscription>(
    `SELECT ${SUBSCRIPTION_COLUMNS}
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

/**
 * A `push_subscriptions` row already narrowed to the Web Push leg — the three
 * columns an `apns` row leaves null are non-null here. The narrowing happens
 * once, in `deliverToUsers`, so nothing downstream re-checks it.
 */
export type WebPushTarget = StoredPushSubscription & {
  endpoint: string;
  p256dh: string;
  auth: string;
};

type PushSender = (
  subscription: WebPushTarget,
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
  if (!isAnyPushEnabled()) {
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
  const transports = readTransports();
  if (!transports) {
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

  // Built as objects, not strings: each leg serialises its own envelope (a raw
  // payload for Web Push, an `aps` wrapper for APNs), so pre-stringifying here
  // would only mean parsing it straight back on the APNs side.
  const payloads = new Map<string, PushPayload>();
  for (const userId of recipients) {
    const settings = preferences.get(userId) ?? null;
    payloads.set(
      userId,
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
    );
  }

  await deliverToUsers(
    recipients,
    (userId) => payloads.get(userId),
    transports,
    MESSAGE_DELIVERY,
  );
}

/**
 * What each leg needs to send, resolved once per fan-out. Either may be null —
 * a deployment can run web-only, APNs-only, or both — and a null leg means its
 * rows are skipped, not that the fan-out stops.
 */
interface PushTransports {
  vapid: VapidConfig | null;
  apns: ApnsConfig | null;
}

function readTransports(): PushTransports | null {
  const vapid = readVapidConfig();
  const apns = readApnsConfig();
  if (!vapid && !apns) {
    return null;
  }
  return { vapid, apns };
}

/**
 * The shared last mile: look up every recipient's subscriptions, hand each to
 * the transport its platform calls for, prune on the vendor's "gone" signal.
 * Both the message path and the call path end here — they differ in who and
 * what, never in how.
 *
 * ONE QUERY FOR BOTH PLATFORMS. The alternative — a query per leg — would ask
 * the same index the same question twice for the common case of a person with a
 * laptop and a phone.
 */
async function deliverToUsers(
  userIds: readonly string[],
  payloadFor: (userId: string) => PushPayload | undefined,
  transports: PushTransports,
  delivery: PushDeliveryOptions,
): Promise<void> {
  const subscriptions = await getPool().query<StoredPushSubscription>(
    `SELECT ${SUBSCRIPTION_COLUMNS}
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
      if (subscription.platform === "apns") {
        await deliverApns(subscription, payload, transports.apns, delivery);
        return;
      }
      await deliverWebPush(subscription, payload, transports.vapid, delivery);
    }),
  );
}

async function deliverWebPush(
  subscription: StoredPushSubscription,
  payload: PushPayload,
  config: VapidConfig | null,
  delivery: PushDeliveryOptions,
): Promise<void> {
  if (!config) {
    return;
  }
  // The CHECK constraint guarantees these on a `web` row; this narrowing is
  // what lets the sender's type say so, and a row that somehow violated it is
  // skipped rather than sent as `undefined`.
  const { endpoint, p256dh, auth } = subscription;
  if (!endpoint || !p256dh || !auth) {
    return;
  }
  try {
    await sender(
      { ...subscription, endpoint, p256dh, auth },
      JSON.stringify(payload),
      config,
      delivery,
    );
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
}

/**
 * The APNs last mile. Note what is NOT here: no decision about who, no reading
 * of preferences, no second opinion about the payload. The body is the same
 * `PushPayload` the web leg sends, re-wrapped for `aps`, so the two platforms
 * cannot start saying different things about the same event.
 */
async function deliverApns(
  subscription: StoredPushSubscription,
  payload: PushPayload,
  config: ApnsConfig | null,
  delivery: PushDeliveryOptions,
): Promise<void> {
  if (!config || !subscription.token) {
    return;
  }
  try {
    const result = await sendApnsPush({
      config,
      deviceToken: subscription.token,
      payload: JSON.stringify(buildApnsBody(payload)),
      delivery: {
        pushType: "alert",
        priority: APNS_ALERT_PRIORITY,
        // Absolute, from the same TTL the web leg sends: a call push expires
        // with the ring instead of arriving after it.
        expirationSeconds: Math.floor(Date.now() / 1000) + delivery.ttlSeconds,
        collapseId: payload.tag,
      },
    });
    if (isApnsTokenGone(result)) {
      // Said out loud rather than pruned silently, because the other thing
      // that produces `400 BadDeviceToken` is a correct token sent to the
      // wrong gateway — see the note on `isApnsTokenGone`. A log line is the
      // difference between diagnosing APNS_ENVIRONMENT in a minute and
      // wondering why registration "works" and nothing ever arrives.
      console.warn(
        `[apns] pruning device token for user ${subscription.user_id}: ${result.status} ${result.reason ?? ""}`.trim(),
      );
      await pruneSubscription(subscription.id).catch(() => {});
      return;
    }
    if (result.status >= 400) {
      console.error(
        `[apns] send failed (${result.status} ${result.reason ?? "no reason"}) for user ${subscription.user_id}`,
      );
    }
  } catch (error) {
    // A transport failure — dead session, timeout, TLS. Never fatal: this whole
    // module is fire-and-forget from the message fan-out's point of view.
    console.error(
      `[apns] send failed (network) for user ${subscription.user_id}:`,
      (error as Error).message,
    );
  }
}

/** See the note on `ApnsDelivery.priority` for why a message is not a 5. */
const APNS_ALERT_PRIORITY = 10 as const;

/**
 * The `aps` envelope, built from the payload both legs share.
 *
 * `thread-id` is the same conversation id as `apns-collapse-id`, doing the
 * other half of the same job: collapse-id replaces an *undelivered or
 * displayed* notification, thread-id groups what remains under one heading in
 * Notification Center. `path` and `tag` are carried through under the names the
 * web payload already uses, because the iOS app parses the same `path` the
 * service worker opens — one routing vocabulary, two clients.
 *
 * No `badge`: an accurate count would mean an unread aggregate query per
 * recipient per push, and a wrong one is worse than none. No
 * `interruption-level`: `time-sensitive` needs its own entitlement, and this
 * round deliberately adds one (Associated Domains) and no more.
 */
export function buildApnsBody(payload: PushPayload): Record<string, unknown> {
  return {
    aps: {
      alert: { title: payload.title, body: payload.body },
      sound: "default",
      "thread-id": payload.tag,
    },
    path: payload.path,
    tag: payload.tag,
  };
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
  if (!isAnyPushEnabled()) {
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
  const transports = readTransports();
  if (!transports) {
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
  const payload = buildCallPushPayload({
    conversationId: event.conversationId,
    kind: event.kind,
    callerName: event.callerName,
  });
  await deliverToUsers(recipients, () => payload, transports, CALL_DELIVERY);
}

import {
  AUTOMOD_CLERK_ID,
  AUTOMOD_KIND_LABEL,
  evaluateAutomod,
  findPqpInviteLinks,
  type AutomodContext,
  Permission,
  hasPermission,
  type AutomodRule,
  type AutomodRuleKind,
  type AutomodVerdict,
} from "@pqp/shared";
import { getPool } from "../db.js";
import {
  isBusEnabled,
  publishToCluster,
  subscribeToCluster,
} from "../lib/bus.js";
import { logAudit } from "./audit.js";
import { getHydratedMessage, type HydratedMessage } from "./messages.js";
import { issueTimeout, type IssuedTimeout } from "./sanctions.js";

/**
 * AutoMod: rules a server enforces on a message before it lands.
 *
 * The matcher is `evaluateAutomod` in `@pqp/shared`; this module owns the
 * rows, the per-server cache, the exemptions, and what happens after a hit.
 * See the table comment on `automod_rules` and the issue (#247) for scope.
 *
 * CACHE. Every server send reads this server's rules. A rule set is small,
 * changes rarely, and is read on every message, so the rows are held in this
 * process for a short while. This is per-process state, which slow mode's
 * comment rightly warns about, and it is safe here for a different reason:
 * the cached thing is *configuration*, not a counter.
 *
 * THE INVALIDATION CROSSES THE CLUSTER. The write path drops its own
 * process's entry and publishes `automod.rules`, so every other machine drops
 * the same entry within a bus round trip instead of enforcing the old list
 * for the rest of its `CACHE_TTL_MS`. `CACHE_TTL_MS` is what is left when the
 * bus is off (a self-host, one process, where there is nobody to tell) or
 * when a frame is lost, which is exactly the role it plays for every other
 * cache in this codebase.
 */

const CACHE_TTL_MS = 30_000;

/**
 * "This server's rules changed" and "this author has just had an alert
 * posted", relayed so the second machine does not answer from a copy the
 * first one already knows is wrong. Mirrors `PERMISSIONS_TOPIC` in
 * `ws/chat.ts`: a content-free ping, the local half in its own function so
 * the originating instance and every relayed one run exactly the same code.
 */
const AUTOMOD_RULES_TOPIC = "automod.rules";
const AUTOMOD_ALERT_TOPIC = "automod.alert";

/**
 * One alert post per author per server within this window; further hits in
 * the window are audited but not posted. A blocked send is refused before
 * slow mode charges it, so without this a member with a keyword and the
 * socket's send budget could put two hundred embeds a second into #mod-log.
 *
 * SHARED, not per process: see `claimAlertWindow` below. The map here is the
 * fast gate in front of the row and the fallback behind it.
 */
const ALERT_COOLDOWN_MS = 10_000;
const lastAlertAt = new Map<string, number>();

function cooldownKey(serverId: string, authorId: string): string {
  return `${serverId}:${authorId}`;
}

function rememberAlert(key: string, now: number): void {
  lastAlertAt.set(key, now);
  if (lastAlertAt.size > 10_000) {
    for (const [k, at] of lastAlertAt) {
      if (now - at >= ALERT_COOLDOWN_MS) lastAlertAt.delete(k);
    }
  }
}

/**
 * THE WINDOW IS THE CLUSTER'S, NOT THIS PROCESS'S.
 *
 * With two API machines the same author's next blocked message lands on
 * whichever machine the proxy picks, and a per-process map says "nobody has
 * alerted about them" on the machine that did not: #mod-log gets the same
 * embed twice, and a flood gets one copy per machine per window. So the
 * window lives in a row, and the claim is one conditional UPSERT whose
 * `rowCount` IS the verdict — Postgres serialises two machines racing for the
 * same `(server, author)` pair, so exactly one of them can win.
 *
 * ON THE DATABASE'S CLOCK, both sides of the comparison. Two machines' clocks
 * agree to within a second in practice and are not required to: a peer running
 * eleven seconds fast would otherwise satisfy its own `WHERE` and claim a
 * window that has not elapsed at all. `NOW()` is one clock for every claimant,
 * and the timestamp it wrote comes back so the caller can undo exactly the row
 * it wrote and nothing else.
 *
 * The local map stays in front of it as a cheap first gate (an alert this
 * process just posted needs no round trip to be refused) and as the fallback
 * when the database cannot be asked: a duplicate alert during an outage is a
 * nuisance, a swallowed one is a moderator not being told.
 */
interface AlertClaim {
  key: string;
  /**
   * The instant the row now carries, so a release can be conditional on it.
   * `null` when the database could not be asked at all and this process
   * decided on its own — there is then no row to undo.
   */
  at: Date | null;
}

/**
 * ONE CLAIM IN FLIGHT PER KEY. A flood is many hits for the same
 * `(server, author)` arriving together, and every one of them passes the local
 * gate before the first has written anything: without this they would each
 * issue an UPSERT and then serialise on the same primary-key row, turning a
 * burst into a queue on the pool. They share one query instead, and exactly
 * one of them gets the claim — the same coalescing the playlist proxy does for
 * a stampede of identical reads.
 */
const inflightClaims = new Map<string, Promise<Date | false | null>>();

async function claimAlertWindow(
  serverId: string,
  authorId: string,
  key: string,
): Promise<Date | false | null> {
  const existing = inflightClaims.get(key);
  if (existing) {
    // Somebody else is already asking. Whatever the answer, it is not this
    // caller's claim: one winner per query, and the row is the arbiter.
    await existing.catch(() => null);
    return false;
  }
  const inflight = (async (): Promise<Date | false | null> => {
    try {
      const result = await getPool().query<{ last_alert_at: Date }>(
        `INSERT INTO automod_alert_cooldowns (server_id, author_id, last_alert_at)
         VALUES ($1, $2, NOW())
         ON CONFLICT (server_id, author_id) DO UPDATE
           SET last_alert_at = NOW()
           WHERE automod_alert_cooldowns.last_alert_at
                 <= NOW() - ($3::bigint * INTERVAL '1 millisecond')
         RETURNING last_alert_at`,
        [serverId, authorId, ALERT_COOLDOWN_MS],
      );
      return result.rows[0]?.last_alert_at ?? false;
    } catch (error) {
      console.error("[automod] alert cooldown claim failed:", error);
      return null;
    }
  })();
  inflightClaims.set(key, inflight);
  try {
    return await inflight;
  } finally {
    inflightClaims.delete(key);
  }
}

/**
 * May this instance post the alert? A claim back means yes and must be
 * finished with exactly once: `confirmAlertClaim` after the post lands,
 * `releaseAlertClaim` if it does not.
 */
async function claimAlert(
  serverId: string,
  authorId: string,
  now: number,
): Promise<AlertClaim | null> {
  const key = cooldownKey(serverId, authorId);
  const last = lastAlertAt.get(key);
  if (last !== undefined && now - last < ALERT_COOLDOWN_MS) {
    return null;
  }
  const claimed = await claimAlertWindow(serverId, authorId, key);
  if (claimed === false) {
    // Somebody else holds this window. Not remembered locally: the row is the
    // authority on when it ends, and stamping our own map with `now` would
    // extend it past what the row says.
    return null;
  }
  // Claimed, or the database could not be asked and this process is deciding
  // on its own. Either way this instance is about to post.
  rememberAlert(key, now);
  return { key, at: claimed instanceof Date ? claimed : null };
}

/**
 * The post landed. Only now are the other machines told, so a frame can never
 * suppress an alert that was never written — the row already refuses them, and
 * this is the belt to its braces that keeps working during a database blip.
 */
function confirmAlertClaim(serverId: string, authorId: string): void {
  if (isBusEnabled()) {
    publishToCluster(AUTOMOD_ALERT_TOPIC, { serverId, authorId });
  }
}

/**
 * THE POST DID NOT HAPPEN, SO THE WINDOW WAS NOT USED. Without this, an author
 * lookup that threw or a message insert that failed would leave the row (and
 * this machine's map) silencing the next ten seconds of alerts for a post
 * nobody ever saw. Conditional on the exact instant this claim wrote, so a
 * claim somebody else has legitimately taken in the meantime is left alone.
 */
async function releaseAlertClaim(
  serverId: string,
  authorId: string,
  claim: AlertClaim,
): Promise<void> {
  lastAlertAt.delete(claim.key);
  if (!claim.at) {
    return;
  }
  try {
    await getPool().query(
      `DELETE FROM automod_alert_cooldowns
        WHERE server_id = $1 AND author_id = $2 AND last_alert_at = $3`,
      [serverId, authorId, claim.at],
    );
  } catch (error) {
    // The window stands for its ten seconds. Worth a line, not a throw: the
    // caller is already in a catch block for a failed alert.
    console.error("[automod] alert cooldown release failed:", error);
  }
}

subscribeToCluster(AUTOMOD_ALERT_TOPIC, (data) => {
  if (
    !data ||
    typeof data !== "object" ||
    typeof (data as { serverId?: string }).serverId !== "string" ||
    typeof (data as { authorId?: string }).authorId !== "string"
  ) {
    return;
  }
  const { serverId, authorId } = data as { serverId: string; authorId: string };
  // Stamped with THIS clock: the frame says "somebody posted one just now",
  // and this map is only the fast gate in front of the row, which is the one
  // thing that decides the window.
  rememberAlert(cooldownKey(serverId, authorId), Date.now());
});

/** Test seam. */
export function resetAutomodAlertCooldown(): void {
  lastAlertAt.clear();
  inflightClaims.clear();
}

interface RuleRow {
  id: string;
  server_id: string;
  kind: AutomodRuleKind;
  enabled: boolean;
  keywords: string[];
  allow_list: string[];
  mention_limit: number;
  exempt_role_ids: string[];
  exempt_channel_ids: string[];
  custom_message: string;
  alert_channel_id: string | null;
  timeout_minutes: number;
  block_pqp_invites: boolean;
  created_at: Date;
  updated_at: Date;
}

const COLUMNS = `id, server_id, kind, enabled, keywords, allow_list, mention_limit,
  exempt_role_ids, exempt_channel_ids, custom_message, alert_channel_id,
  timeout_minutes, block_pqp_invites, created_at, updated_at`;

function mapRule(row: RuleRow): AutomodRule {
  return {
    id: row.id,
    serverId: row.server_id,
    kind: row.kind,
    enabled: row.enabled,
    keywords: row.keywords,
    allowList: row.allow_list,
    mentionLimit: row.mention_limit,
    exemptRoleIds: row.exempt_role_ids,
    exemptChannelIds: row.exempt_channel_ids,
    customMessage: row.custom_message,
    alertChannelId: row.alert_channel_id,
    timeoutMinutes: row.timeout_minutes,
    blockPqpInvites: row.block_pqp_invites,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

const cache = new Map<string, { rules: AutomodRule[]; expiresAt: number }>();

/**
 * Drop this process's copy. The half that runs on EVERY instance: the write
 * path calls `invalidateAutomodCache` (below), which calls this and then says
 * so on the bus; the subscription calls this again on every other machine.
 * Same shape, and for the same reason, as `deliverPermissionsUpdate` in
 * `ws/chat.ts` — an invalidation placed only in the write path leaves every
 * OTHER machine enforcing the old rule list for up to `CACHE_TTL_MS` after an
 * owner edits it, which on two machines is a word filter that half the
 * members still trip and half no longer do.
 */
export function invalidateAutomodCacheLocally(serverId?: string): void {
  if (serverId) {
    cache.delete(serverId);
  } else {
    cache.clear();
  }
}

export function invalidateAutomodCache(serverId?: string): void {
  invalidateAutomodCacheLocally(serverId);
  if (isBusEnabled()) {
    publishToCluster(AUTOMOD_RULES_TOPIC, { serverId: serverId ?? null });
  }
}

subscribeToCluster(AUTOMOD_RULES_TOPIC, (data) => {
  if (!data || typeof data !== "object") {
    return;
  }
  const serverId = (data as { serverId?: unknown }).serverId;
  if (serverId !== null && typeof serverId !== "string") {
    return;
  }
  invalidateAutomodCacheLocally(serverId ?? undefined);
});

export async function listAutomodRules(serverId: string): Promise<AutomodRule[]> {
  const result = await getPool().query<RuleRow>(
    `SELECT ${COLUMNS} FROM automod_rules WHERE server_id = $1 ORDER BY created_at, id`,
    [serverId],
  );
  return result.rows.map(mapRule);
}

async function cachedRules(serverId: string): Promise<AutomodRule[]> {
  const now = Date.now();
  const hit = cache.get(serverId);
  if (hit && hit.expiresAt > now) {
    return hit.rules;
  }
  const rules = await listAutomodRules(serverId);
  cache.set(serverId, { rules, expiresAt: now + CACHE_TTL_MS });
  return rules;
}

export async function getAutomodRule(
  serverId: string,
  ruleId: string,
): Promise<AutomodRule | null> {
  const result = await getPool().query<RuleRow>(
    `SELECT ${COLUMNS} FROM automod_rules WHERE server_id = $1 AND id = $2`,
    [serverId, ruleId],
  );
  return result.rows[0] ? mapRule(result.rows[0]) : null;
}

export type AutomodRuleFields = Pick<
  AutomodRule,
  | "kind"
  | "enabled"
  | "keywords"
  | "allowList"
  | "mentionLimit"
  | "exemptRoleIds"
  | "exemptChannelIds"
  | "customMessage"
  | "alertChannelId"
  | "timeoutMinutes"
  | "blockPqpInvites"
>;

/** Trim, drop empties and duplicates, keep the owner's order. */
function cleanList(entries: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of entries) {
    const entry = raw.trim();
    const key = entry.toLowerCase();
    if (!entry || seen.has(key)) {
      continue;
    }
    seen.add(key);
    out.push(entry);
  }
  return out;
}

export async function createAutomodRule(
  serverId: string,
  fields: AutomodRuleFields,
): Promise<AutomodRule> {
  const result = await getPool().query<RuleRow>(
    `INSERT INTO automod_rules (
       server_id, kind, enabled, keywords, allow_list, mention_limit,
       exempt_role_ids, exempt_channel_ids, custom_message, alert_channel_id,
       timeout_minutes, block_pqp_invites
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
     RETURNING ${COLUMNS}`,
    [
      serverId,
      fields.kind,
      fields.enabled,
      cleanList(fields.keywords),
      cleanList(fields.allowList),
      fields.mentionLimit,
      fields.exemptRoleIds,
      fields.exemptChannelIds,
      fields.customMessage.trim(),
      fields.alertChannelId,
      fields.timeoutMinutes,
      fields.blockPqpInvites,
    ],
  );
  invalidateAutomodCache(serverId);
  return mapRule(result.rows[0]!);
}

export async function updateAutomodRule(
  serverId: string,
  ruleId: string,
  patch: Partial<Omit<AutomodRuleFields, "kind">>,
): Promise<AutomodRule | null> {
  const result = await getPool().query<RuleRow>(
    `UPDATE automod_rules SET
       enabled            = COALESCE($3, enabled),
       keywords           = COALESCE($4, keywords),
       allow_list         = COALESCE($5, allow_list),
       mention_limit      = COALESCE($6, mention_limit),
       exempt_role_ids    = COALESCE($7, exempt_role_ids),
       exempt_channel_ids = COALESCE($8, exempt_channel_ids),
       custom_message     = COALESCE($9, custom_message),
       -- Nullable, so COALESCE cannot say "leave it": $10 is the sentinel for
       -- "not in the patch" and $11 the value, which may be NULL.
       alert_channel_id   = CASE WHEN $10::boolean THEN $11::uuid ELSE alert_channel_id END,
       timeout_minutes    = COALESCE($12, timeout_minutes),
       block_pqp_invites  = COALESCE($13, block_pqp_invites),
       updated_at         = NOW()
     WHERE server_id = $1 AND id = $2
     RETURNING ${COLUMNS}`,
    [
      serverId,
      ruleId,
      patch.enabled ?? null,
      patch.keywords ? cleanList(patch.keywords) : null,
      patch.allowList ? cleanList(patch.allowList) : null,
      patch.mentionLimit ?? null,
      patch.exemptRoleIds ?? null,
      patch.exemptChannelIds ?? null,
      patch.customMessage?.trim() ?? null,
      patch.alertChannelId !== undefined,
      patch.alertChannelId ?? null,
      patch.timeoutMinutes ?? null,
      patch.blockPqpInvites ?? null,
    ],
  );
  invalidateAutomodCache(serverId);
  return result.rows[0] ? mapRule(result.rows[0]) : null;
}

export async function deleteAutomodRule(
  serverId: string,
  ruleId: string,
): Promise<boolean> {
  const result = await getPool().query(
    `DELETE FROM automod_rules WHERE server_id = $1 AND id = $2`,
    [serverId, ruleId],
  );
  invalidateAutomodCache(serverId);
  return (result.rowCount ?? 0) > 0;
}

async function memberRoleIds(serverId: string, userId: string): Promise<string[]> {
  const result = await getPool().query<{ role_id: string }>(
    `SELECT role_id FROM member_roles WHERE server_id = $1 AND user_id = $2`,
    [serverId, userId],
  );
  return result.rows.map((row) => row.role_id);
}

export interface AutomodCheckInput {
  serverId: string;
  channelId: string;
  authorId: string;
  /** The author's resolved permissions in this channel. */
  memberPerms: bigint;
  body: string;
}

/**
 * Decide whether a message may land. Null means yes.
 *
 * MANAGE_MESSAGES, MANAGE_SERVER and ADMINISTRATOR walk through every rule.
 * The first is slow mode's convention (the person who can delete the flood is
 * not who the filter is for); the other two are Discord's, and matter because
 * an owner can lose MANAGE_MESSAGES in one channel through an overwrite and
 * must never be blocked by their own list. A rule's own exemptions (cargos,
 * channels) are applied per rule, so a hall can keep the word filter on in
 * general chat and off in a channel that exists to talk about the word.
 */
export async function checkAutomod(
  input: AutomodCheckInput,
): Promise<AutomodVerdict | null> {
  const rules = await cachedRules(input.serverId);
  if (rules.length === 0) {
    return null;
  }
  if (
    hasPermission(input.memberPerms, Permission.MANAGE_MESSAGES) ||
    hasPermission(input.memberPerms, Permission.MANAGE_SERVER) ||
    hasPermission(input.memberPerms, Permission.ADMINISTRATOR)
  ) {
    return null;
  }
  const enabled = rules.filter(
    (rule) => rule.enabled && !rule.exemptChannelIds.includes(input.channelId),
  );
  if (enabled.length === 0) {
    return null;
  }
  const needsRoles = enabled.some((rule) => rule.exemptRoleIds.length > 0);
  const roleIds = needsRoles
    ? new Set(await memberRoleIds(input.serverId, input.authorId))
    : null;
  const applicable = roleIds
    ? enabled.filter((rule) => !rule.exemptRoleIds.some((id) => roleIds.has(id)))
    : enabled;
  const context = applicable.some(
    (rule) => rule.kind === "invite_links" && rule.blockPqpInvites,
  )
    ? await ownInviteContext(input.serverId, input.body)
    : {};
  return evaluateAutomod(input.body, applicable, context);
}

/**
 * Which of the pqp links in a body point back at this server, so a member
 * sharing their own hall's invite is not treated as poaching. One query for
 * the codes found, plus the server's own community slug. Only runs when a
 * rule with the pqp half on applies, so the common path pays nothing.
 */
async function ownInviteContext(
  serverId: string,
  body: string,
): Promise<AutomodContext> {
  const links = findPqpInviteLinks(body);
  if (links.length === 0) {
    return {};
  }
  const codes = links.flatMap((link) => (link.code ? [link.code] : []));
  const [invites, server] = await Promise.all([
    codes.length > 0
      ? getPool().query<{ code: string }>(
          `SELECT code FROM server_invites WHERE server_id = $1 AND code = ANY($2::text[])`,
          [serverId, codes],
        )
      : Promise.resolve({ rows: [] as { code: string }[] }),
    getPool().query<{ community_slug: string | null }>(
      `SELECT community_slug FROM servers WHERE id = $1`,
      [serverId],
    ),
  ]);
  const ownCodes = new Set(invites.rows.map((row) => row.code));
  const ownSlug = server.rows[0]?.community_slug ?? null;
  return {
    ownPqpInvite: (link) =>
      (link.code !== undefined && ownCodes.has(link.code)) ||
      (link.slug !== undefined && ownSlug !== null && link.slug === ownSlug),
  };
}

/**
 * The instance's AutoMod pseudo-user: the author of every alert post and the
 * issuer of every automatic timeout. Same mechanism as a webhook's pseudo-row
 * (`is_webhook`, so it is excluded from search, mentions and member lists),
 * with a fixed `clerk_id` so there is exactly one per database. Created on
 * first use, never deleted.
 */
let automodUserId: string | null = null;

export async function ensureAutomodUser(): Promise<string> {
  if (automodUserId) {
    return automodUserId;
  }
  const result = await getPool().query<{ id: string }>(
    `INSERT INTO users (clerk_id, display_name, avatar_url, is_webhook)
     VALUES ($1, 'AutoMod', NULL, TRUE)
     ON CONFLICT (clerk_id) DO UPDATE SET display_name = EXCLUDED.display_name
     RETURNING id`,
    [AUTOMOD_CLERK_ID],
  );
  automodUserId = result.rows[0]!.id;
  return automodUserId;
}

/** Test seam: forget the cached pseudo-user id after a TRUNCATE. */
export function resetAutomodUser(): void {
  automodUserId = null;
}

/**
 * What a hit did beyond refusing the send, for the caller to make live: the
 * alert post to fan out, and the timeout to announce and enforce in voice.
 * The database side is done by the time this is returned.
 */
export interface AutomodHitEffects {
  alert: HydratedMessage | null;
  timeout: IssuedTimeout | null;
}

function describeMinutes(minutes: number): string {
  if (minutes % 10080 === 0) {
    const weeks = minutes / 10080;
    return weeks === 1 ? "1 semana" : `${weeks} semanas`;
  }
  if (minutes % 1440 === 0) {
    const days = minutes / 1440;
    return days === 1 ? "1 dia" : `${days} dias`;
  }
  if (minutes % 60 === 0) return `${minutes / 60} h`;
  return `${minutes} min`;
}

/**
 * What a hit leaves behind: an audit row always; a timeout and an alert post
 * when the rule asks for them. Best-effort and after the refusal has already
 * been sent, so a failure here never turns into a message landing. The body
 * goes only into the alert (a channel the moderators chose), never into the
 * audit log.
 */
export async function recordAutomodHit(
  input: AutomodCheckInput,
  verdict: AutomodVerdict,
): Promise<AutomodHitEffects> {
  const effects: AutomodHitEffects = { alert: null, timeout: null };
  const rule = verdict.ruleId
    ? (await cachedRules(input.serverId)).find((r) => r.id === verdict.ruleId)
    : undefined;
  // The pseudo-user is the actor of every row here. The audit log renders a
  // null actor as "a departed account", which is the opposite of what
  // happened.
  const actorId = await ensureAutomodUser();
  try {
    await logAudit({
      serverId: input.serverId,
      actorId,
      action: "automod.block",
      targetType: "user",
      targetId: input.authorId,
      reason: verdict.kind,
      changes: [
        { key: "channelId", old: null, new: input.channelId },
        { key: "matched", old: null, new: verdict.matched },
        ...(verdict.ruleId
          ? [{ key: "ruleId", old: null, new: verdict.ruleId }]
          : []),
      ],
    });
  } catch (error) {
    console.error("[automod] audit write failed:", error);
  }
  if (!rule) {
    return effects;
  }

  if (rule.timeoutMinutes > 0) {
    try {
      effects.timeout = await issueTimeout({
        serverId: input.serverId,
        userId: input.authorId,
        issuedBy: actorId,
        minutes: rule.timeoutMinutes,
        reason: `AutoMod: ${AUTOMOD_KIND_LABEL[verdict.kind]}`,
      });
      await logAudit({
        serverId: input.serverId,
        actorId,
        action: "member.timeout",
        targetType: "user",
        targetId: input.authorId,
        reason: `AutoMod: ${AUTOMOD_KIND_LABEL[verdict.kind]}`,
        changes: [
          {
            key: "expiresAt",
            old: effects.timeout.previousExpiresAt?.toISOString() ?? null,
            new: effects.timeout.expiresAt.toISOString(),
          },
          { key: "minutes", old: null, new: rule.timeoutMinutes },
        ],
      });
    } catch (error) {
      console.error("[automod] timeout failed:", error);
    }
  }

  const claim = rule.alertChannelId
    ? await claimAlert(input.serverId, input.authorId, Date.now())
    : null;
  if (rule.alertChannelId && claim) {
    try {
      const authorId = actorId;
      const author = await getPool().query<{ display_name: string; username: string | null; discriminator: string | null; name: string | null }>(
        `SELECT u.display_name, u.username, u.discriminator, c.name
           FROM users u, channels c
          WHERE u.id = $1 AND c.id = $2`,
        [input.authorId, input.channelId],
      );
      const who = author.rows[0];
      const tag =
        who?.username && who.discriminator
          ? `${who.username}#${who.discriminator}`
          : (who?.display_name ?? "um membro");
      const now = new Date();
      const embed = {
        title: "O AutoMod bloqueou uma mensagem",
        color: 0xe5484d,
        fields: [
          { name: "Regra", value: AUTOMOD_KIND_LABEL[verdict.kind], inline: true },
          { name: "Membro", value: tag, inline: true },
          { name: "Canal", value: who?.name ? `#${who.name}` : input.channelId, inline: true },
          { name: "Pegou", value: verdict.matched.slice(0, 1024), inline: true },
          ...(effects.timeout
            ? [{ name: "Timeout", value: describeMinutes(rule.timeoutMinutes), inline: true }]
            : []),
          { name: "Mensagem", value: input.body.slice(0, 1024) },
        ],
        timestamp: now.toISOString(),
      };
      const inserted = await getPool().query<{ id: string }>(
        `INSERT INTO messages (channel_id, author_id, body, webhook_embeds, webhook_username)
         VALUES ($1, $2, '', $3, 'AutoMod')
         RETURNING id`,
        [rule.alertChannelId, authorId, JSON.stringify([embed])],
      );
      effects.alert = await getHydratedMessage(inserted.rows[0]!.id);
      // The row is written. Only now is the window anybody else's business.
      confirmAlertClaim(input.serverId, input.authorId);
    } catch (error) {
      console.error("[automod] alert post failed:", error);
      // Nothing was posted, so nothing should be silenced: give the window
      // back rather than swallowing the next ten seconds of alerts too.
      await releaseAlertClaim(input.serverId, input.authorId, claim);
    }
  }
  return effects;
}

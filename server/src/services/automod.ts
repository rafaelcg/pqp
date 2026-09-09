import {
  AUTOMOD_KIND_LABEL,
  evaluateAutomod,
  Permission,
  hasPermission,
  type AutomodRule,
  type AutomodRuleKind,
  type AutomodVerdict,
} from "@pqp/shared";
import { getPool } from "../db.js";
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
 * the cached thing is *configuration*, not a counter. On two machines an
 * edit takes at most `CACHE_TTL_MS` to reach the other one, and in that
 * window one machine enforces the old list. A refused send that should have
 * landed, or a landed send that should have been refused, for thirty
 * seconds after an owner edits the list, is the accepted cost. The write
 * path drops its own process's entry immediately.
 */

const CACHE_TTL_MS = 30_000;

/**
 * One alert post per author per server within this window; further hits in
 * the window are audited but not posted. A blocked send is refused before
 * slow mode charges it, so without this a member with a keyword and the
 * socket's send budget could put two hundred embeds a second into #mod-log.
 * Per process, like the rule cache, and for the same reason: an occasional
 * duplicate across two machines is a nuisance, not a hole.
 */
const ALERT_COOLDOWN_MS = 10_000;
const lastAlertAt = new Map<string, number>();

function alertAllowed(serverId: string, authorId: string, now: number): boolean {
  const key = `${serverId}:${authorId}`;
  const last = lastAlertAt.get(key);
  if (last !== undefined && now - last < ALERT_COOLDOWN_MS) {
    return false;
  }
  lastAlertAt.set(key, now);
  if (lastAlertAt.size > 10_000) {
    for (const [k, at] of lastAlertAt) {
      if (now - at >= ALERT_COOLDOWN_MS) lastAlertAt.delete(k);
    }
  }
  return true;
}

/** Test seam. */
export function resetAutomodAlertCooldown(): void {
  lastAlertAt.clear();
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
  created_at: Date;
  updated_at: Date;
}

const COLUMNS = `id, server_id, kind, enabled, keywords, allow_list, mention_limit,
  exempt_role_ids, exempt_channel_ids, custom_message, alert_channel_id,
  timeout_minutes, created_at, updated_at`;

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
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

const cache = new Map<string, { rules: AutomodRule[]; expiresAt: number }>();

export function invalidateAutomodCache(serverId?: string): void {
  if (serverId) {
    cache.delete(serverId);
  } else {
    cache.clear();
  }
}

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
       timeout_minutes
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
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
  return evaluateAutomod(input.body, applicable);
}

/**
 * The instance's AutoMod pseudo-user: the author of every alert post and the
 * issuer of every automatic timeout. Same mechanism as a webhook's pseudo-row
 * (`is_webhook`, so it is excluded from search, mentions and member lists),
 * with a fixed `clerk_id` so there is exactly one per database. Created on
 * first use, never deleted.
 */
const AUTOMOD_CLERK_ID = "system:automod";
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

  if (rule.alertChannelId && alertAllowed(input.serverId, input.authorId, Date.now())) {
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
    } catch (error) {
      console.error("[automod] alert post failed:", error);
    }
  }
  return effects;
}

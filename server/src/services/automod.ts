import {
  evaluateAutomod,
  Permission,
  hasPermission,
  type AutomodRule,
  type AutomodRuleKind,
  type AutomodVerdict,
} from "@pqp/shared";
import { getPool } from "../db.js";
import { logAudit } from "./audit.js";
import { createAutomatedReport } from "./reports.js";

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
  report_hits: boolean;
  created_at: Date;
  updated_at: Date;
}

const COLUMNS = `id, server_id, kind, enabled, keywords, allow_list, mention_limit,
  exempt_role_ids, exempt_channel_ids, custom_message, report_hits,
  created_at, updated_at`;

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
    reportHits: row.report_hits,
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
  | "reportHits"
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
       exempt_role_ids, exempt_channel_ids, custom_message, report_hits
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
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
      fields.reportHits,
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
       report_hits        = COALESCE($10, report_hits),
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
      patch.reportHits ?? null,
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
 * MANAGE_MESSAGES walks through every rule, same convention as slow mode:
 * the person who can delete the flood is not the person the filter exists
 * for. A rule's own exemptions (cargos, channels) are applied per rule, so a
 * hall can keep the word filter on in general chat and off in a channel that
 * exists to talk about the word.
 */
export async function checkAutomod(
  input: AutomodCheckInput,
): Promise<AutomodVerdict | null> {
  const rules = await cachedRules(input.serverId);
  if (rules.length === 0) {
    return null;
  }
  if (hasPermission(input.memberPerms, Permission.MANAGE_MESSAGES)) {
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
 * What a hit leaves behind: an audit row always, a report when the rule
 * asks for one. Best-effort, after the refusal has already been sent, so a
 * failure here never turns into a message landing. The body goes only into
 * the report (a moderator surface), never into the audit log.
 */
export async function recordAutomodHit(
  input: AutomodCheckInput,
  verdict: AutomodVerdict,
): Promise<void> {
  const rule = verdict.ruleId
    ? (await cachedRules(input.serverId)).find((r) => r.id === verdict.ruleId)
    : undefined;
  try {
    await logAudit({
      serverId: input.serverId,
      actorId: null,
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
  if (!rule?.reportHits) {
    return;
  }
  try {
    await createAutomatedReport({
      reportedUserId: input.authorId,
      channelId: input.channelId,
      reason: "spam",
      details: `AutoMod (${verdict.kind}) blocked "${verdict.matched}": ${input.body.slice(0, 500)}`,
    });
  } catch (error) {
    console.error("[automod] report write failed:", error);
  }
}

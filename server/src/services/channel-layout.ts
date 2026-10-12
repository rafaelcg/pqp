import type { PoolClient } from "pg";
import {
  defaultCategoryName,
  fallbackCategoryName,
  legacyTypeRank,
  type ChannelLayoutConfig,
  type ChannelLayoutInput,
} from "@pqp/shared";
import { getPool } from "../db.js";
import { flagServerOverrides, isEnabled } from "../lib/flags.js";
import {
  channelLayoutMetrics,
  countChannelLayout,
  type ChannelLayoutMetrics,
} from "./channel-layout-metrics.js";
import { invalidateServerChannelList } from "./servers.js";
import { channelVisibleSql } from "./users.js";

/**
 * THE MIXED CHANNEL LIST, SERVER SIDE. Plan and mocks: the sidebar redesign
 * (categories are the only headers; every type mixes in one order per parent;
 * channels in no category render above the first category with no header).
 *
 * Three things live here:
 *
 * 1. `migrateChannelLayout`: moves a server's loose channels (text and forums,
 *    then voice, then watch party, the order the web drew them) into a new
 *    "Canais" category at the top, after snapshotting every sidebar row. One
 *    transaction, idempotent through the `channel_layout_migrations` primary
 *    key plus an advisory lock. `revertChannelLayout` restores the snapshot.
 * 2. `applyChannelLayout`: the full-order PUT, atomic, refused with a stale
 *    version so two managers never overwrite each other, and careful to leave
 *    every channel the actor cannot see exactly where it was.
 * 3. `runChannelLayoutMigrations`: the job that makes the data follow the
 *    `mixed_channel_list` flag (per server or global) with no deploy.
 *
 * Clients switch only when `getChannelLayoutConfig` says `mixed`, which needs
 * both the flag and the migration row, so nobody draws a half state.
 */

export const MIXED_CHANNEL_LIST_FLAG = "mixed_channel_list" as const;

export class ChannelLayoutError extends Error {}
export class ChannelLayoutServerMissing extends Error {}

type Db = Pick<PoolClient, "query">;

/** Bumped by every write that reshapes the list. Locks the server row. */
export async function bumpChannelLayoutVersion(db: Db, serverId: string): Promise<number> {
  const result = await db.query<{ channel_layout_version: number }>(
    `UPDATE servers SET channel_layout_version = channel_layout_version + 1
      WHERE id = $1 RETURNING channel_layout_version`,
    [serverId],
  );
  return result.rows[0]?.channel_layout_version ?? 0;
}

/**
 * What a client draws. `mixed` needs the flag AND a live migration row (a
 * recorded no-op counts: a server with nothing loose is already in shape).
 */
export async function getChannelLayoutConfig(
  serverId: string,
  db: Db = getPool(),
): Promise<ChannelLayoutConfig> {
  const result = await db.query<{ version: number; migrated: boolean }>(
    `SELECT s.channel_layout_version AS version,
            (m.server_id IS NOT NULL AND m.reverted_at IS NULL) AS migrated
       FROM servers s
       LEFT JOIN channel_layout_migrations m ON m.server_id = s.id
      WHERE s.id = $1`,
    [serverId],
  );
  const row = result.rows[0];
  return {
    mixed: Boolean(row?.migrated) && isEnabled(MIXED_CHANNEL_LIST_FLAG, { serverId }),
    version: row?.version ?? 0,
  };
}

/**
 * The legacy-create rule. An older client (iOS 1.0.21, Android 0.4.14, a web
 * tab from before the redesign) never sends `parentId`; on a mixed server its
 * new channel goes to the end of the first category, where that client can
 * see it, instead of a loose area it does not draw as such. Null otherwise.
 */
export async function legacyCreateParent(serverId: string): Promise<string | null> {
  const config = await getChannelLayoutConfig(serverId);
  if (!config.mixed) {
    return null;
  }
  const result = await getPool().query<{ id: string }>(
    `SELECT id FROM channels
      WHERE server_id = $1 AND type = 'category'
      ORDER BY position ASC, id ASC LIMIT 1`,
    [serverId],
  );
  const id = result.rows[0]?.id ?? null;
  if (id) {
    countChannelLayout("legacyCreateRedirected");
  }
  return id;
}

async function ownerLocale(db: Db, serverId: string): Promise<string | null> {
  const result = await db.query<{ locale: string | null }>(
    `SELECT p.settings->>'locale' AS locale
       FROM servers s
       LEFT JOIN user_preferences p ON p.user_id = s.owner_id
      WHERE s.id = $1`,
    [serverId],
  );
  return result.rows[0]?.locale ?? null;
}

async function lockServerLayout(db: Db, serverId: string): Promise<boolean> {
  await db.query(
    `SELECT pg_advisory_xact_lock(hashtextextended('channel-layout:' || $1::text, 0))`,
    [serverId],
  );
  const server = await db.query(`SELECT 1 FROM servers WHERE id = $1 FOR UPDATE`, [serverId]);
  return server.rows.length > 0;
}

interface SidebarRow {
  id: string;
  type: string;
  parent_id: string | null;
  position: number;
  is_private: boolean;
  name: string;
  created_at: Date;
}

async function readSidebarRows(db: Db, serverId: string): Promise<SidebarRow[]> {
  const result = await db.query<SidebarRow>(
    `SELECT id, type, parent_id, position, is_private, name, created_at
       FROM channels
      WHERE server_id = $1 AND type <> 'thread'
      ORDER BY position ASC, created_at ASC, id ASC`,
    [serverId],
  );
  return result.rows;
}

function compareIds(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function legacyOrder(a: SidebarRow, b: SidebarRow): number {
  return (
    legacyTypeRank(a.type) - legacyTypeRank(b.type) ||
    a.position - b.position ||
    a.created_at.getTime() - b.created_at.getTime() ||
    compareIds(a.id, b.id)
  );
}

function positionOrder(a: SidebarRow, b: SidebarRow): number {
  return (
    a.position - b.position ||
    a.created_at.getTime() - b.created_at.getTime() ||
    compareIds(a.id, b.id)
  );
}

/** One statement for a whole renumbering: (id, parent, position) triples. */
async function writePlaces(
  db: Db,
  serverId: string,
  places: Array<{ id: string; parentId: string | null; position: number }>,
): Promise<void> {
  if (places.length === 0) {
    return;
  }
  await db.query(
    `UPDATE channels c
        SET parent_id = v.parent_id, position = v.position
       FROM unnest($2::uuid[], $3::uuid[], $4::int[]) AS v(id, parent_id, position)
      WHERE c.id = v.id AND c.server_id = $1`,
    [
      serverId,
      places.map((place) => place.id),
      places.map((place) => place.parentId),
      places.map((place) => place.position),
    ],
  );
}

export interface MigrationSummary {
  /** Loose channels that would move (or moved) into the new category. */
  loose: number;
  categories: number;
  /** A category with the default name already exists; the fallback is used. */
  collision: boolean;
  categoryName: string;
  privateLoose: number;
  /** Every loose channel is private: members would see an empty category. */
  privateOnlyLoose: boolean;
}

export type MigrationResult =
  | ({ status: "dry-run" } & MigrationSummary)
  | ({ status: "migrated"; categoryId: string; version: number } & MigrationSummary)
  | ({ status: "noop" } & MigrationSummary)
  | { status: "already"; revertedAt: string | null };

/**
 * Step 1 of the plan, per server. Snapshot, then loose channels into a new
 * category at position 0 in the web's old order, then bump the version. A
 * second call, a concurrent call, or a replay after a crash all converge: the
 * advisory lock serialises them and the row means done. `allowReverted` (the
 * operator's own "migrate" after a revert) is the only way back in; the job
 * never passes it.
 */
export async function migrateChannelLayout(
  serverId: string,
  options: { dryRun?: boolean; allowReverted?: boolean } = {},
): Promise<MigrationResult> {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    if (!(await lockServerLayout(client, serverId))) {
      await client.query("ROLLBACK");
      throw new ChannelLayoutServerMissing("Server not found");
    }
    const existing = await client.query<{ reverted_at: Date | null }>(
      `SELECT reverted_at FROM channel_layout_migrations WHERE server_id = $1`,
      [serverId],
    );
    const previous = existing.rows[0];
    if (previous && !(options.allowReverted && previous.reverted_at)) {
      await client.query("ROLLBACK");
      return {
        status: "already",
        revertedAt: previous.reverted_at ? previous.reverted_at.toISOString() : null,
      };
    }

    const rows = await readSidebarRows(client, serverId);
    const categories = rows.filter((row) => row.type === "category").sort(positionOrder);
    const loose = rows
      .filter((row) => row.type !== "category" && row.parent_id === null)
      .sort(legacyOrder);
    const locale = await ownerLocale(client, serverId);
    const preferred = defaultCategoryName(locale);
    const taken = new Set(categories.map((category) => category.name.trim().toLowerCase()));
    const collision = taken.has(preferred.toLowerCase()) || taken.has("canais");
    const categoryName = collision ? fallbackCategoryName(locale) : preferred;
    const privateLoose = loose.filter((row) => row.is_private).length;
    const summary: MigrationSummary = {
      loose: loose.length,
      categories: categories.length,
      collision,
      categoryName,
      privateLoose,
      privateOnlyLoose: loose.length > 0 && privateLoose === loose.length,
    };

    if (options.dryRun) {
      await client.query("ROLLBACK");
      return { status: "dry-run", ...summary };
    }

    if (previous) {
      await client.query(`DELETE FROM channel_layout_migrations WHERE server_id = $1`, [serverId]);
    }
    await client.query(
      `INSERT INTO channel_layout_migrations (server_id, snapshot)
       VALUES ($1, $2::jsonb)`,
      [
        serverId,
        JSON.stringify(
          rows.map((row) => ({ id: row.id, parent_id: row.parent_id, position: row.position })),
        ),
      ],
    );

    if (loose.length === 0) {
      await client.query("COMMIT");
      countChannelLayout("migratedNoop");
      return { status: "noop", ...summary };
    }

    const inserted = await client.query<{ id: string }>(
      `INSERT INTO channels (server_id, name, type, position, is_private)
       VALUES ($1, $2, 'category', 0, FALSE)
       RETURNING id`,
      [serverId, categoryName],
    );
    const categoryId = inserted.rows[0]!.id;
    await writePlaces(client, serverId, [
      ...categories.map((category, index) => ({
        id: category.id,
        parentId: null,
        position: index + 1,
      })),
      ...loose.map((row, index) => ({ id: row.id, parentId: categoryId, position: index })),
    ]);
    await client.query(
      `UPDATE channel_layout_migrations SET category_id = $2 WHERE server_id = $1`,
      [serverId, categoryId],
    );
    const version = await bumpChannelLayoutVersion(client, serverId);
    await client.query("COMMIT");
    invalidateServerChannelList(serverId);
    countChannelLayout("migrated");
    return { status: "migrated", categoryId, version, ...summary };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

export type RevertResult =
  | { status: "reverted"; restored: number; categoryDeleted: boolean; version: number }
  | { status: "not-migrated" }
  | { status: "already-reverted" };

/**
 * The data half of the rollback (the rendering half is the flag). Every
 * snapshot row that still exists and still sits in the migration category goes
 * back to the loose area in its old order; loose channels created since follow
 * them. The category is deleted only when that leaves it empty: if the owner
 * has put something of their own in it, it stays. `reverted_at` is kept so the
 * job never migrates the server again by itself.
 */
export async function revertChannelLayout(serverId: string): Promise<RevertResult> {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    if (!(await lockServerLayout(client, serverId))) {
      await client.query("ROLLBACK");
      throw new ChannelLayoutServerMissing("Server not found");
    }
    const migration = await client.query<{
      category_id: string | null;
      snapshot: Array<{ id: string; parent_id: string | null; position: number }>;
      reverted_at: Date | null;
    }>(
      `SELECT category_id, snapshot, reverted_at FROM channel_layout_migrations
        WHERE server_id = $1`,
      [serverId],
    );
    const row = migration.rows[0];
    if (!row) {
      await client.query("ROLLBACK");
      return { status: "not-migrated" };
    }
    if (row.reverted_at) {
      await client.query("ROLLBACK");
      return { status: "already-reverted" };
    }

    const categoryId = row.category_id;
    const rows = await readSidebarRows(client, serverId);
    const snapshotById = new Map(row.snapshot.map((entry) => [entry.id, entry]));
    let restored: SidebarRow[] = [];
    let categoryDeleted = false;
    if (categoryId) {
      restored = rows
        .filter(
          (channel) =>
            channel.parent_id === categoryId &&
            snapshotById.get(channel.id)?.parent_id === null,
        )
        .sort(
          (a, b) =>
            snapshotById.get(a.id)!.position - snapshotById.get(b.id)!.position ||
            compareIds(a.id, b.id),
        );
      const restoredIds = new Set(restored.map((channel) => channel.id));
      const looseSince = rows
        .filter((channel) => channel.type !== "category" && channel.parent_id === null)
        .sort(positionOrder);
      const stayInCategory = rows
        .filter((channel) => channel.parent_id === categoryId && !restoredIds.has(channel.id))
        .sort(positionOrder);
      categoryDeleted = stayInCategory.length === 0;
      if (categoryDeleted) {
        await client.query(`DELETE FROM channels WHERE id = $1 AND server_id = $2`, [
          categoryId,
          serverId,
        ]);
      }
      const categories = rows
        .filter(
          (channel) =>
            channel.type === "category" && !(categoryDeleted && channel.id === categoryId),
        )
        .sort(positionOrder);
      await writePlaces(client, serverId, [
        ...[...restored, ...looseSince].map((channel, index) => ({
          id: channel.id,
          parentId: null,
          position: index,
        })),
        ...stayInCategory.map((channel, index) => ({
          id: channel.id,
          parentId: categoryId,
          position: index,
        })),
        ...categories.map((category, index) => ({
          id: category.id,
          parentId: null,
          position: index,
        })),
      ]);
    }
    await client.query(
      `UPDATE channel_layout_migrations SET reverted_at = NOW() WHERE server_id = $1`,
      [serverId],
    );
    const version = await bumpChannelLayoutVersion(client, serverId);
    await client.query("COMMIT");
    invalidateServerChannelList(serverId);
    countChannelLayout("reverted");
    return { status: "reverted", restored: restored.length, categoryDeleted, version };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

export type ApplyResult =
  | { status: "applied"; version: number; moved: number }
  | { status: "stale"; version: number };

/**
 * One parent's new order: the ids sent for it, with every row that was NOT
 * sent (or is protected) put back right after its nearest previous sibling
 * from the old order that is still in this parent, or first if there is none.
 * One pass over the old order and one over the result: a group of 500 costs
 * 500 steps, not 500 squared.
 */
function mergeKeepingUnsent(
  oldOrder: readonly string[],
  sentHere: readonly string[],
  stays: (id: string) => boolean,
  isSent: (id: string) => boolean,
): string[] {
  const after = new Map<string | null, string[]>();
  let lastStaying: string | null = null;
  for (const id of oldOrder) {
    if (!isSent(id)) {
      const list = after.get(lastStaying) ?? [];
      list.push(id);
      after.set(lastStaying, list);
      lastStaying = id;
    } else if (stays(id)) {
      lastStaying = id;
    }
  }
  const result: string[] = [];
  const emit = (id: string) => {
    result.push(id);
    for (const next of after.get(id) ?? []) {
      emit(next);
    }
  };
  for (const id of after.get(null) ?? []) {
    emit(id);
  }
  for (const id of sentHere) {
    emit(id);
  }
  return result;
}

/**
 * The full-order PUT. One transaction: the server row is locked by version,
 * every id is checked, and what the actor cannot see keeps its place:
 *
 * - a channel the actor did not send (a private one they cannot see, a watch
 *   party room the web never lists) is re-anchored after its nearest previous
 *   sibling from the old order that is still in the same parent;
 * - a category the actor cannot see (an overwrite can hide one) is neither
 *   accepted in `categoryIds` nor as a destination, and keeps its place among
 *   the categories the same way;
 * - a channel inside such a category stays in it, even if the client (which
 *   cannot see its category) sent it as loose.
 *
 * So a manager without VIEW on #staff reorders around it and #staff stays
 * exactly where it was. `beforeCommit` runs inside the transaction when
 * something moved (the audit row lands with the order or not at all).
 */
export async function applyChannelLayout(
  serverId: string,
  actorId: string,
  input: ChannelLayoutInput,
  options: { beforeCommit?: (client: PoolClient, moved: number) => Promise<void> } = {},
): Promise<ApplyResult> {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const current = await client.query<{ channel_layout_version: number }>(
      `SELECT channel_layout_version FROM servers WHERE id = $1 FOR UPDATE`,
      [serverId],
    );
    const version = current.rows[0]?.channel_layout_version;
    if (version === undefined) {
      await client.query("ROLLBACK");
      throw new ChannelLayoutServerMissing("Server not found");
    }
    if (version !== input.baseVersion) {
      await client.query("ROLLBACK");
      countChannelLayout("staleRejected");
      return { status: "stale", version };
    }

    // Visibility per viewer (privacy plus overwrites), read on this
    // connection under the server lock, right before the write: a channel
    // made private a moment ago is already protected here.
    const visibleRows = await client.query<{ id: string }>(
      `SELECT c.id
         FROM channels c
         JOIN server_members sm ON sm.server_id = c.server_id
        WHERE c.server_id = $1 AND sm.user_id = $2
          AND c.type <> 'thread'
          AND ${channelVisibleSql("$2")}`,
      [serverId, actorId],
    );
    const visible = new Set(visibleRows.rows.map((row) => row.id));

    const rows = await readSidebarRows(client, serverId);
    const byId = new Map(rows.map((row) => [row.id, row]));
    const categoryRows = rows.filter((row) => row.type === "category").sort(positionOrder);
    const hiddenCategories = new Set(
      categoryRows.filter((row) => !visible.has(row.id)).map((row) => row.id),
    );

    // --- validate ---------------------------------------------------------
    const categoryIds = input.categoryIds;
    if (new Set(categoryIds).size !== categoryIds.length) {
      throw new ChannelLayoutError("categoryIds lists a category twice");
    }
    for (const id of categoryIds) {
      // A hidden category gets the same answer as a missing one.
      if (byId.get(id)?.type !== "category" || hiddenCategories.has(id)) {
        throw new ChannelLayoutError("Unknown category");
      }
    }
    if (categoryIds.length !== categoryRows.length - hiddenCategories.size) {
      throw new ChannelLayoutError("categoryIds must list every category you can see");
    }
    const categorySet = new Set(categoryIds);
    const parents = new Set<string | null>();
    const sent = new Map<string, string | null>();
    const seen = new Set<string>();
    for (const group of input.groups) {
      if (group.parentId !== null && !categorySet.has(group.parentId)) {
        throw new ChannelLayoutError("A group's parentId is not one of categoryIds");
      }
      if (parents.has(group.parentId)) {
        throw new ChannelLayoutError("Each parent appears in one group");
      }
      parents.add(group.parentId);
      for (const id of group.channelIds) {
        const row = byId.get(id);
        // Not found, a thread, or hidden from the actor: one answer, so the
        // route never confirms that a channel the caller cannot see exists.
        if (!row || !visible.has(id)) {
          throw new ChannelLayoutError("Unknown channel");
        }
        if (row.type === "category") {
          throw new ChannelLayoutError("A category cannot sit inside a group");
        }
        if (seen.has(id)) {
          throw new ChannelLayoutError("A channel appears twice");
        }
        seen.add(id);
        // Inside a category the actor cannot see: protected, stays put.
        if (row.parent_id && hiddenCategories.has(row.parent_id)) {
          continue;
        }
        sent.set(id, group.parentId);
      }
    }

    // --- build the new order ---------------------------------------------
    const isSent = (id: string) => sent.has(id);
    const categoryOrder = mergeKeepingUnsent(
      categoryRows.map((row) => row.id),
      categoryIds,
      () => true,
      (id) => categorySet.has(id),
    );
    const oldGroups = new Map<string | null, string[]>();
    const knownCategories = new Set(categoryRows.map((row) => row.id));
    for (const row of [...rows].sort(positionOrder)) {
      if (row.type === "category") {
        continue;
      }
      const parent = row.parent_id && knownCategories.has(row.parent_id) ? row.parent_id : null;
      const list = oldGroups.get(parent) ?? [];
      list.push(row.id);
      oldGroups.set(parent, list);
    }
    const sentByParent = new Map<string | null, string[]>();
    for (const group of input.groups) {
      sentByParent.set(
        group.parentId,
        group.channelIds.filter((id) => sent.get(id) === group.parentId),
      );
    }

    const places: Array<{ id: string; parentId: string | null; position: number }> = [];
    categoryOrder.forEach((id, index) => places.push({ id, parentId: null, position: index }));
    for (const parent of [null, ...categoryOrder]) {
      const order = mergeKeepingUnsent(
        oldGroups.get(parent) ?? [],
        sentByParent.get(parent) ?? [],
        (id) => sent.get(id) === parent,
        isSent,
      );
      order.forEach((id, index) => places.push({ id, parentId: parent, position: index }));
    }
    const moved = places.filter((place) => {
      const row = byId.get(place.id)!;
      return row.parent_id !== place.parentId || row.position !== place.position;
    });
    await writePlaces(client, serverId, moved);
    const next = await bumpChannelLayoutVersion(client, serverId);
    if (moved.length > 0) {
      await options.beforeCommit?.(client, moved.length);
    }
    await client.query("COMMIT");
    invalidateServerChannelList(serverId);
    countChannelLayout("reorders");
    return { status: "applied", version: next, moved: moved.length };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Every sidebar row of a server (no threads): what a `channels-update` names
 * after a migration or a revert, so every member who can see any of it
 * refetches the list and the config.
 */
export async function listSidebarChannelIds(serverId: string): Promise<string[]> {
  const result = await getPool().query<{ id: string }>(
    `SELECT id FROM channels WHERE server_id = $1 AND type <> 'thread'`,
    [serverId],
  );
  return result.rows.map((row) => row.id);
}

/** Upper bound on servers one job tick migrates. */
export const CHANNEL_LAYOUT_JOB_BATCH = 200;
export const CHANNEL_LAYOUT_JOB_INTERVAL_MS = 60_000;

/**
 * The job body: migrate up to `limit` servers the flag is on for and that have
 * no migration row yet. Global on walks `servers` by id (minus the servers
 * overridden off); global off only looks at the servers overridden on.
 * Returns the ids whose list changed shape, for the caller to nudge.
 */
export async function runChannelLayoutMigrations(
  limit = CHANNEL_LAYOUT_JOB_BATCH,
): Promise<string[]> {
  const overrides = flagServerOverrides(MIXED_CHANNEL_LIST_FLAG);
  const globalOn = isEnabled(MIXED_CHANNEL_LIST_FLAG);
  let candidates: string[];
  if (globalOn) {
    const off = [...overrides].filter(([, on]) => !on).map(([id]) => id);
    const result = await getPool().query<{ id: string }>(
      `SELECT s.id FROM servers s
        WHERE NOT EXISTS (SELECT 1 FROM channel_layout_migrations m WHERE m.server_id = s.id)
          AND s.id <> ALL($1::uuid[])
        ORDER BY s.id
        LIMIT $2`,
      [off, limit],
    );
    candidates = result.rows.map((row) => row.id);
  } else {
    const on = [...overrides].filter(([, value]) => value).map(([id]) => id);
    if (on.length === 0) {
      return [];
    }
    const result = await getPool().query<{ id: string }>(
      `SELECT s.id FROM servers s
        WHERE s.id = ANY($1::uuid[])
          AND NOT EXISTS (SELECT 1 FROM channel_layout_migrations m WHERE m.server_id = s.id)
        ORDER BY s.id
        LIMIT $2`,
      [on, limit],
    );
    candidates = result.rows.map((row) => row.id);
  }
  const changed: string[] = [];
  for (const serverId of candidates) {
    try {
      const result = await migrateChannelLayout(serverId);
      if (result.status === "migrated" || result.status === "noop") {
        changed.push(serverId);
      }
    } catch (error) {
      if (error instanceof ChannelLayoutServerMissing) {
        continue;
      }
      // One server that cannot migrate must not wedge the batch: it sorts
      // first by id on every tick, and nothing behind it would ever move.
      countChannelLayout("jobFailures");
      console.error(
        `[channel-layout] migration failed for server ${serverId}:`,
        error instanceof Error ? error.message : error,
      );
    }
  }
  return changed;
}

/**
 * Inside `createServer`'s transaction, with the flag on globally: a new
 * server starts with one category holding #general and Lobby, and a migration
 * row (empty snapshot) so the job never touches it. Returns the category name.
 */
export async function seedDefaultCategory(
  db: Db,
  serverId: string,
  locale: string | null | undefined,
): Promise<{ categoryId: string; name: string }> {
  const name = defaultCategoryName(locale);
  const inserted = await db.query<{ id: string }>(
    `INSERT INTO channels (server_id, name, type, position, is_private)
     VALUES ($1, $2, 'category', 0, FALSE)
     RETURNING id`,
    [serverId, name],
  );
  const categoryId = inserted.rows[0]!.id;
  await db.query(
    `INSERT INTO channel_layout_migrations (server_id, category_id, snapshot)
     VALUES ($1, $2, '[]'::jsonb)`,
    [serverId, categoryId],
  );
  return { categoryId, name };
}

/**
 * A server born already in the mixed shape (a Discord import made while the
 * flag is on keeps Discord's loose channels loose, which is what Discord
 * shows): record the no-op so the job leaves it alone.
 */
export async function recordChannelLayoutNoop(db: Db, serverId: string): Promise<void> {
  await db.query(
    `INSERT INTO channel_layout_migrations (server_id, snapshot)
     VALUES ($1, '[]'::jsonb)
     ON CONFLICT (server_id) DO NOTHING`,
    [serverId],
  );
}

export interface ChannelLayoutReport extends ChannelLayoutMetrics {
  /** The flag's global answer here (per-server overrides are on `flags`). */
  enabled: boolean;
  /**
   * Servers with a live migration row, a recorded no-op among them. Null when
   * the table could not be read: unknown, never a fabricated zero.
   */
  migratedServers: number | null;
  revertedServers: number | null;
}

export async function channelLayoutReport(): Promise<ChannelLayoutReport> {
  const result = await getPool()
    .query<{ live: string; reverted: string }>(
      `SELECT COUNT(*) FILTER (WHERE reverted_at IS NULL) AS live,
              COUNT(*) FILTER (WHERE reverted_at IS NOT NULL) AS reverted
         FROM channel_layout_migrations`,
    )
    .catch(() => null);
  const row = result?.rows[0];
  return {
    enabled: isEnabled(MIXED_CHANNEL_LIST_FLAG),
    migratedServers: row ? Number(row.live) : null,
    revertedServers: row ? Number(row.reverted) : null,
    ...channelLayoutMetrics(),
  };
}

/**
 * How the operator dashboard marks a room or a broadcast whose server is a
 * community. Shared by the rooms list and the live watch party list in
 * `GET /api/admin/metrics`, so both read the same columns the same way.
 *
 * `is_community` is the public address and `is_community_listed` is the
 * directory (schema.sql §Communities). A server with neither is private and
 * gets null, which is also what a DM call gets.
 */
export interface CommunityTag {
  /** The `pqp.gg/c/<slug>` address, null only for rows from before slugs. */
  slug: string | null;
  /** In the public directory, not only reachable by its address. */
  listed: boolean;
  /** Unlisted by the operator. */
  suspended: boolean;
}

export interface CommunityColumns {
  is_community: boolean | null;
  is_community_listed: boolean | null;
  is_community_suspended: boolean | null;
  community_slug: string | null;
}

/** The select-list fragment for a `servers` alias; LEFT JOIN safe. */
export function communityColumns(alias: string): string {
  return `${alias}.is_community, ${alias}.is_community_listed,
          ${alias}.is_community_suspended, ${alias}.community_slug`;
}

export function communityTag(row: CommunityColumns): CommunityTag | null {
  if (!row.is_community) return null;
  return {
    slug: row.community_slug ?? null,
    listed: row.is_community_listed === true,
    suspended: row.is_community_suspended === true,
  };
}

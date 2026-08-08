import pg from "pg";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

let pool: pg.Pool | null = null;

/**
 * Opt into TLS when the host needs it (most managed Postgres over public
 * networking). Left off by default so local/dev works without certs.
 *
 * Shared rather than inlined because the cluster bus holds a connection
 * *outside* the pool (LISTEN needs a session of its own), and a bus that
 * disagreed with the pool about TLS would simply fail to connect on every
 * managed host.
 */
export function pgSslConfig(): { ssl?: { rejectUnauthorized: boolean } } {
  const useSsl =
    process.env.DATABASE_SSL === "true" || process.env.PGSSLMODE === "require";
  return useSsl ? { ssl: { rejectUnauthorized: false } } : {};
}

export function getPool(): pg.Pool {
  if (!pool) {
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) {
      throw new Error("DATABASE_URL is required");
    }
    pool = new pg.Pool({
      connectionString,
      max: Number(process.env.PG_POOL_MAX ?? 10),
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 10_000,
      ...pgSslConfig(),
    });
    // Idle-client errors (Postgres restart, network blip) are emitted on the
    // pool; without a listener they crash the process.
    pool.on("error", (error) => {
      console.error("[db] idle client error:", error);
    });
  }
  return pool;
}

export async function closePool(): Promise<void> {
  const current = pool;
  pool = null;
  await current?.end().catch(() => {});
}

export async function initDb(): Promise<void> {
  const schema = readFileSync(join(__dirname, "schema.sql"), "utf8");
  await getPool().query(schema);
}

export interface DbUser {
  id: string;
  clerk_id: string;
  display_name: string;
  username: string | null;
  discriminator: string | null;
  avatar_url: string | null;
  /**
   * The object-storage key behind `avatar_url`, set only when the picture was
   * uploaded here. Null for a Clerk image, a preset, or a typed URL — see the
   * column comment in schema.sql. Optional because several reads select a
   * narrower column list; treat an absent value as "unknown", not as "none".
   */
  avatar_key?: string | null;
  /** Domains of verified emails only — see `verifiedEmailDomains` in auth/clerk.ts. */
  email_domains?: string[];
  /**
   * True for an operator-provisioned member of the house cast — see
   * services/characters.ts and the `users.is_character` comment in schema.sql.
   *
   * Optional because several reads select a narrower column list, and an absent
   * value must read as "not a character": the flag only ever *removes*
   * capability (no DMs, no friend requests, no voice, no self-deletion), so
   * failing to see it degrades to the ordinary user's behaviour rather than to
   * a character's, which is the safe direction for a person and the loud one
   * for a character.
   */
  is_character?: boolean;
  /**
   * The account's public handle — the `rafa` in `pqp.gg/@rafa` — or null.
   *
   * A SECOND name, and not a replacement for `username`: `username` is unique
   * only when paired with `discriminator`, so it can never address a URL on its
   * own. See the `users.handle` block in schema.sql. Optional here for the same
   * reason as `is_character`: several reads select a narrower column list, and
   * an absent value must read as "unknown", never as "this account has none".
   */
  handle?: string | null;
  /** When the handle last moved; drives the 30-day rename cooldown. */
  handle_changed_at?: Date | string | null;
}

export interface DbServer {
  id: string;
  name: string;
  owner_id: string;
  created_at: Date;
  message_retention_days: number | null;
  sso_email_domain: string | null;
  /**
   * The server's own pictures. `*_url` is what every payload carries; `*_key`
   * is the storage key and is read only by `server-images.ts` and by the delete
   * path that has to orphan the objects. Optional on the type because
   * `SERVER_COLUMNS` deliberately does not select the keys.
   */
  icon_url: string | null;
  banner_url: string | null;
  icon_key?: string | null;
  banner_key?: string | null;
  is_community?: boolean;
  /** Only present on reads that join the viewer's `server_members` row. */
  show_on_profile?: boolean;
  role?: "owner" | "admin" | "member";
}

export interface DbChannel {
  id: string;
  server_id: string;
  name: string;
  type: "text" | "voice" | "category";
  position: number;
  is_private: boolean;
  topic: string | null;
  image_url: string | null;
  parent_id: string | null;
}

export interface DbMessage {
  id: string;
  channel_id: string;
  author_id: string;
  body: string;
  created_at: Date;
  edited_at?: Date | null;
  author_name?: string;
  author_username?: string | null;
  author_discriminator?: string | null;
  author_avatar_url?: string | null;
  reply_to_id?: string | null;
  /** Joined from the parent message; absent when this row is not a reply. */
  reply_author_id?: string | null;
  reply_author_name?: string | null;
  reply_body?: string | null;
  pinned_at?: Date | null;
  pinned_by?: string | null;
  /** Joined from `pinned_by`; absent or null when the pinner has since left. */
  pinned_by_name?: string | null;
  /** Joined from `author_id`; true when the author is a webhook's pseudo-identity. */
  author_is_webhook?: boolean;
  webhook_embeds?: unknown;
  /** Per-message override of the webhook's own configured name/avatar. */
  webhook_username?: string | null;
  webhook_avatar_url?: string | null;
}

export interface DbInvite {
  id: string;
  server_id: string;
  code: string;
  created_by: string;
  max_uses: number | null;
  uses: number;
  expires_at: Date | null;
  created_at: Date;
  server_name?: string;
}

export type MemberRole = "owner" | "admin" | "member";

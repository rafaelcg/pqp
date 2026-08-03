import pg from "pg";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

let pool: pg.Pool | null = null;

export function getPool(): pg.Pool {
  if (!pool) {
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) {
      throw new Error("DATABASE_URL is required");
    }
    // Opt into TLS when the host needs it (most managed Postgres over public
    // networking). Left off by default so local/dev works without certs.
    const useSsl =
      process.env.DATABASE_SSL === "true" ||
      process.env.PGSSLMODE === "require";
    pool = new pg.Pool({
      connectionString,
      max: Number(process.env.PG_POOL_MAX ?? 10),
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 10_000,
      ...(useSsl ? { ssl: { rejectUnauthorized: false } } : {}),
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
}

export interface DbServer {
  id: string;
  name: string;
  owner_id: string;
  created_at: Date;
  message_retention_days: number | null;
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

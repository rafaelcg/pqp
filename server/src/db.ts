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
    pool = new pg.Pool({ connectionString });
  }
  return pool;
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
  role?: "owner" | "admin" | "member";
}

export interface DbChannel {
  id: string;
  server_id: string;
  name: string;
  type: "text" | "voice";
  position: number;
  is_private: boolean;
  topic: string | null;
  image_url: string | null;
}

export interface DbMessage {
  id: string;
  channel_id: string;
  author_id: string;
  body: string;
  created_at: Date;
  author_name?: string;
  author_username?: string | null;
  author_discriminator?: string | null;
  author_avatar_url?: string | null;
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

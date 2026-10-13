import { readFileSync } from "node:fs";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  FORUM_TAG_EMOJI_ALIASES,
  FORUM_TAG_ICONS,
  FORUM_TAG_PRESET_ICON,
  FORUM_TAG_PRESET_NAMES,
  FORUM_TAG_PRESETS,
  forumTagIconForEmoji,
  type ForumTagPreset,
} from "@pqp/shared";

/**
 * The one-shot boot migration that gives existing forum tags an icon and
 * their preset (schema.sql, "forum_tag_icons_presets_2026_10"), against a real
 * Postgres. The lists inside the SQL are copies of the TypeScript tables, so
 * this test walks every entry of the TypeScript side and expects the SQL to
 * agree: adding an icon or a preset name to one and not the other fails here.
 */

const DATABASE_URL = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
const describeDb = DATABASE_URL ? describe : describe.skip;

if (DATABASE_URL) {
  process.env.DATABASE_URL = DATABASE_URL;
}

const { getPool, initDb, closePool } = await import("./db.js");
const { upsertUser } = await import("./services/users.js");
const { createServer } = await import("./services/servers.js");

const SCHEMA = readFileSync(new URL("./schema.sql", import.meta.url), "utf8");
const MARKER = "forum_tag_icons_presets_2026_10";

/** The migration's own DO block, run again after its marker row is removed. */
function migrationBlock(): string {
  const at = SCHEMA.indexOf(`'${MARKER}'`);
  const start = SCHEMA.lastIndexOf("DO $$", at);
  const end = SCHEMA.indexOf("END $$;", at) + "END $$;".length;
  expect(start).toBeGreaterThan(-1);
  return SCHEMA.slice(start, end);
}

const q = <T extends Record<string, unknown> = Record<string, unknown>>(
  text: string,
  values: unknown[] = [],
) => getPool().query<T>(text, values);

describeDb("forum tag icons and presets migration", () => {
  let forumId: string;

  beforeAll(async () => {
    await initDb();
  });

  afterAll(async () => {
    await closePool();
  });

  beforeEach(async () => {
    await q("TRUNCATE users, servers RESTART IDENTITY CASCADE");
    const owner = await upsertUser({ clerkId: "tag_icons", displayName: "Ana", avatarUrl: null });
    const serverId = (await createServer("Fórum", owner.id)).server.id;
    forumId = (
      await q<{ id: string }>(
        `INSERT INTO channels (server_id, name, type) VALUES ($1, 'ajuda', 'forum') RETURNING id`,
        [serverId],
      )
    ).rows[0]!.id;
  });

  async function insertTag(name: string, emoji: string | null) {
    const result = await q<{ id: string }>(
      `INSERT INTO forum_tags (forum_id, name, emoji, position)
       VALUES ($1, $2, $3, (SELECT count(*) FROM forum_tags WHERE forum_id = $1))
       RETURNING id`,
      [forumId, name, emoji],
    );
    return result.rows[0]!.id;
  }

  async function rerun() {
    await q(`DELETE FROM data_migrations WHERE name = $1`, [MARKER]);
    await q(migrationBlock());
  }

  async function read(id: string) {
    return (
      await q<{ icon: string | null; preset: string | null; emoji: string | null }>(
        `SELECT icon, preset, emoji FROM forum_tags WHERE id = $1`,
        [id],
      )
    ).rows[0]!;
  }

  it("maps every emoji the TypeScript tables know to the same icon", async () => {
    const expected = new Map<string, string>();
    for (const icon of FORUM_TAG_ICONS) {
      expected.set(icon.emoji, icon.key);
    }
    for (const [emoji, key] of Object.entries(FORUM_TAG_EMOJI_ALIASES)) {
      expected.set(emoji, key);
    }
    const ids = new Map<string, string>();
    let n = 0;
    for (const emoji of expected.keys()) {
      n += 1;
      // A name no preset claims, so only the emoji decides the icon.
      ids.set(emoji, await insertTag(`t${n}`, emoji));
    }
    await rerun();
    for (const [emoji, key] of expected) {
      expect(await read(ids.get(emoji)!), emoji).toMatchObject({ icon: key });
      expect(forumTagIconForEmoji(emoji), emoji).toBe(key);
    }
  });

  it("gives a starter tag its preset by any shipped name, accents or not", async () => {
    const ids: Array<[ForumTagPreset, string, string]> = [];
    let n = 0;
    for (const preset of FORUM_TAG_PRESETS) {
      for (const name of FORUM_TAG_PRESET_NAMES[preset]) {
        // The unique name index is per forum, so spread over forums.
        n += 1;
        const forum = (
          await q<{ id: string }>(
            `INSERT INTO channels (server_id, name, type)
             SELECT server_id, 'f' || $1::text, 'forum' FROM channels WHERE id = $2
             RETURNING id`,
            [n, forumId],
          )
        ).rows[0]!.id;
        const tag = (
          await q<{ id: string }>(
            `INSERT INTO forum_tags (forum_id, name) VALUES ($1, $2) RETURNING id`,
            [forum, name.toUpperCase()],
          )
        ).rows[0]!.id;
        ids.push([preset, name, tag]);
      }
    }
    await rerun();
    for (const [preset, name, id] of ids) {
      expect(await read(id), name).toMatchObject({
        preset,
        icon: FORUM_TAG_PRESET_ICON[preset],
      });
    }
  });

  it("leaves a custom tag alone, and keeps an emoji it cannot map", async () => {
    const custom = await insertTag("Receitas", null);
    const odd = await insertTag("Bug", "🦄");
    await rerun();
    expect(await read(custom)).toEqual({ icon: null, preset: null, emoji: null });
    // A starter tag whose emoji staff chose and no icon reads the same keeps
    // the glyph rather than being repainted with the preset's icon.
    expect(await read(odd)).toEqual({ icon: null, preset: "bug", emoji: "🦄" });
  });

  it("runs once: a later boot does not redo what an editor undid", async () => {
    const id = await insertTag("Discussion", "💬");
    await rerun();
    await q(`UPDATE forum_tags SET icon = NULL, preset = NULL WHERE id = $1`, [id]);
    await q(migrationBlock());
    expect(await read(id)).toMatchObject({ icon: null, preset: null });
  });
});

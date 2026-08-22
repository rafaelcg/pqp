#!/usr/bin/env node
/**
 * Bring the QG do pqp up to the shape described in `qg.config.mjs`.
 *
 *   DATABASE_URL=postgres://… node scripts/seed-qg.mjs --owner-tag 'raf#8683'
 *   DATABASE_URL=postgres://… node scripts/seed-qg.mjs --owner-tag 'raf#8683' --dry-run
 *
 * WHY A SCRIPT AND NOT CLICKING. Six channels, six topics, a tagline and a
 * pinned post is twenty minutes of clicking that nobody can review and that
 * has to be redone from memory the next time it changes. This is the same
 * content as a file in the repository, so the diff IS the change and the
 * second run costs nothing.
 *
 * IT IMPORTS THE SERVICES THE API ROUTES USE, exactly as
 * `tools/ambient/scripts/seed-servers-db.mjs` does, so nothing here
 * reimplements a rule. A message written straight into Postgres would exist in
 * the database and in no open client; `createMessage` is the same function the
 * socket calls, so the pin arrives like any other message.
 *
 * IDEMPOTENT, and it has to be. The server is found by name, each channel by
 * name, and the welcome by author and pin. Re-running after editing a topic
 * changes the topic and nothing else. It will never create a second QG.
 *
 * IT DOES NOT CREATE THE SERVER. If no server of that name exists it stops and
 * says so. Creating a community from a script would mean choosing an owner, and
 * the owner of the product's front door should be a person who clicked a
 * button, not a flag somebody passed once.
 */
import { QG } from "./qg.config.mjs";

const DRY = process.argv.includes("--dry-run");

function argValue(flag) {
  const index = process.argv.indexOf(flag);
  return index === -1 ? null : process.argv[index + 1];
}

const ownerTag = argValue("--owner-tag");
if (!ownerTag) {
  console.error("--owner-tag 'name#1234' is required");
  process.exit(1);
}
if (!process.env.DATABASE_URL) {
  console.error("DATABASE_URL is required");
  process.exit(1);
}

// Imported after the argument check so a missing flag fails instantly rather
// than after opening a pool against production.
const { getPool, initDb, closePool } = await import("../dist/db.js");
const { createChannel, updateChannel } = await import(
  "../dist/services/servers.js"
);
const { createMessage, pinMessage } = await import(
  "../dist/services/messages.js"
);

function say(...parts) {
  console.log(...parts);
}

async function main() {
  await initDb();
  const pool = getPool();

  const [username, discriminator] = ownerTag.split("#");
  const ownerResult = await pool.query(
    `SELECT * FROM users WHERE username = $1 AND discriminator = $2`,
    [username, discriminator],
  );
  const owner = ownerResult.rows[0];
  if (!owner) {
    throw new Error(`no user ${ownerTag}`);
  }

  const serverResult = await pool.query(
    `SELECT id, name, owner_id FROM servers WHERE name = $1`,
    [QG.name],
  );
  const server = serverResult.rows[0];
  if (!server) {
    throw new Error(
      `no server named "${QG.name}". Create it in the app first: this script ` +
        `shapes an existing community, it does not decide who owns one.`,
    );
  }
  say(`server: ${server.id} (${QG.name})`);

  // ------------------------------------------------------------- identity
  // The listing fields, so the directory card and the public /c/ page match
  // the file. `is_community` is set rather than assumed: a QG that somehow got
  // unlisted should come back listed after a run.
  if (DRY) {
    say(`would set tagline: ${QG.tagline}`);
  } else {
    await pool.query(
      `UPDATE servers
          SET is_community = TRUE,
              community_slug = $2,
              community_tagline = $3,
              community_category = $4,
              community_language = $5
        WHERE id = $1`,
      [server.id, QG.slug, QG.tagline, QG.category, QG.language],
    );
    say(`tagline + listing updated`);
  }

  // ------------------------------------------------------------- channels
  const existingResult = await pool.query(
    `SELECT id, name, type, topic FROM channels WHERE server_id = $1`,
    [server.id],
  );
  const byName = new Map(existingResult.rows.map((row) => [row.name, row]));

  let firstTextChannelId = null;
  for (const wanted of QG.channels) {
    const found = byName.get(wanted.name);
    if (!found) {
      if (DRY) {
        say(`would create ${wanted.type} #${wanted.name}`);
      } else {
        const created = await createChannel(server.id, wanted.name, wanted.type);
        await updateChannel(created.id, { topic: wanted.topic });
        say(`created ${wanted.type} #${wanted.name}`);
        if (wanted.type === "text" && !firstTextChannelId) {
          firstTextChannelId = created.id;
        }
      }
      continue;
    }
    if (found.topic !== wanted.topic) {
      if (DRY) {
        say(`would retopic #${wanted.name}`);
      } else {
        await updateChannel(found.id, { topic: wanted.topic });
        say(`retopiced #${wanted.name}`);
      }
    }
    if (wanted.type === "text" && !firstTextChannelId) {
      firstTextChannelId = found.id;
    }
  }

  // -------------------------------------------------------------- welcome
  if (!firstTextChannelId) {
    say("no text channel to pin the welcome in; skipping");
  } else {
    const pinned = await pool.query(
      `SELECT id, body FROM messages
        WHERE channel_id = $1 AND pinned_at IS NOT NULL AND author_id = $2`,
      [firstTextChannelId, owner.id],
    );
    const already = pinned.rows.find((row) => row.body === QG.welcome);
    if (already) {
      say("welcome already pinned and current");
    } else if (DRY) {
      say(`would pin a ${QG.welcome.length} char welcome`);
    } else {
      // An older welcome is unpinned rather than deleted: the history stays
      // honest about what the room used to say, and nothing this script does
      // should destroy a message somebody may have replied to.
      for (const stale of pinned.rows) {
        await pool.query(
          `UPDATE messages SET pinned_at = NULL WHERE id = $1`,
          [stale.id],
        );
        say(`unpinned a stale welcome`);
      }
      const message = await createMessage(firstTextChannelId, owner, QG.welcome);
      if (message) {
        await pinMessage(message.id, owner.id);
        say("welcome posted and pinned");
      }
    }
  }

  say(DRY ? "dry run, nothing written" : "done");
}

try {
  await main();
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
} finally {
  await closePool().catch(() => {});
}

#!/usr/bin/env node
/**
 * Put the support bot into a server.
 *
 *   DATABASE_URL=… node scripts/join-server.mjs --server "QG do pqp"
 *   DATABASE_URL=… node scripts/join-server.mjs --server "QG do pqp" --dry-run
 *
 * WHY THIS IS A SEPARATE SCRIPT AND NOT SOMETHING THE BOT DOES AT BOOT.
 * `bot.js` refuses to start if it is not already a member, and that refusal is
 * deliberate: an account that can add itself to servers is an account that can
 * appear somewhere nobody invited it. Joining is an operator action, taken once,
 * against a named server. The bot only ever reads the membership it was given.
 *
 * IT GOES THROUGH THE SERVER'S OWN INVITE CODE rather than writing a
 * `server_members` row, for the same reason `provision.mjs` imports the
 * character service instead of writing SQL: `redeemInvite` carries the ban
 * check, the use counting and the transaction boundary, and a second
 * implementation here would drift away from all three. The invite it mints is
 * single-use and expires in an hour, so nothing durable is left lying around
 * afterwards.
 *
 * ROLE: plain member. Not admin. A support bot needs to read a channel and post
 * in it, and nothing else — no kick, no ban, no channel edits, no invite
 * creation. Least privilege is not a formality here: this account is driven by
 * a language model, and the blast radius of a bad generation should stop at a
 * message nobody liked.
 */
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, "..", "..", "..");

const argv = process.argv.slice(2);
const args = {
  server: valueOf("--server") ?? "QG do pqp",
  label: valueOf("--label") ?? "pqp-support-bot",
  dryRun: argv.includes("--dry-run"),
};

function valueOf(flag) {
  const i = argv.indexOf(flag);
  return i >= 0 ? argv[i + 1] : undefined;
}

function fail(message) {
  console.error(`\n${message}\n`);
  process.exit(1);
}

if (!process.env.DATABASE_URL) {
  fail("DATABASE_URL is required.");
}

const dbMod = await import(join(REPO, "server", "dist", "db.js")).catch((e) =>
  fail(
    `Could not load the server build (${e.message}).\n` +
      `Build it first:  pnpm --filter @pqp/shared build && pnpm --filter @pqp/server build`,
  ),
);
const characters = await import(
  join(REPO, "server", "dist", "services", "characters.js")
);
const invites = await import(join(REPO, "server", "dist", "services", "invites.js"));

const pool = dbMod.getPool();

const account = await characters.getCharacterAccountByLabel(args.label);
if (!account) {
  fail(
    `No character account labelled "${args.label}". Mint it first:\n` +
      `  DATABASE_URL=… node scripts/provision.mjs`,
  );
}
if (account.revoked_at) {
  fail(`"${args.label}" is revoked. Rotate it before joining anything.`);
}

const serverRow = await pool.query(
  `SELECT id, name, owner_id FROM servers WHERE name = $1`,
  [args.server],
);
const server = serverRow.rows[0];
if (!server) {
  fail(`No server named "${args.server}".`);
}

const already = await pool.query(
  `SELECT role FROM server_members WHERE server_id = $1 AND user_id = $2`,
  [server.id, account.user_id],
);
if (already.rows.length > 0) {
  console.log(
    `Already a member of "${server.name}" as ${already.rows[0].role}. Nothing to do.`,
  );
  await pool.end();
  process.exit(0);
}

if (args.dryRun) {
  console.log(
    `Would mint a single-use invite to "${server.name}" (owner ${server.owner_id})\n` +
      `and redeem it as ${args.label} (user ${account.user_id}), role member.`,
  );
  await pool.end();
  process.exit(0);
}

// Single use, one hour. The bot redeems it in the next statement, so a longer
// life or a second use would only be a working door into the server that nobody
// is tracking.
const invite = await invites.createInvite(server.id, server.owner_id, {
  maxUses: 1,
  expiresInHours: 1,
});
const joined = await invites.redeemInvite(invite.code, account.user_id);

const role = await pool.query(
  `SELECT role FROM server_members WHERE server_id = $1 AND user_id = $2`,
  [server.id, account.user_id],
);

console.log(
  `Joined "${joined.serverName}" as ${role.rows[0]?.role ?? "member"}.\n` +
    `The invite was single-use and is now spent.`,
);

await pool.end();

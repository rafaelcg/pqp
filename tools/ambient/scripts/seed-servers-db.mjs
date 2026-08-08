#!/usr/bin/env node
/**
 * Seed the launch communities DIRECTLY through the server's service layer.
 *
 * The API-based sibling (seed-servers.mjs) authenticates as the host over
 * HTTP, which works with the dev bypass but not production: a Clerk session
 * token lives sixty seconds, and seeding five servers does not. This variant
 * needs only DATABASE_URL — it imports the same tested services the API
 * routes call (createServer, createChannel, updateChannel, createInvite,
 * createMessage, pinMessage), so nothing here reimplements a rule.
 *
 * The owner is a real human account, named by tag:
 *
 *   DATABASE_URL=postgres://… node scripts/seed-servers-db.mjs \
 *     --config personas.yaml --owner-tag 'raf#8683'
 *
 * Characters are added as plain members (they cannot join by invite — the
 * runner assumes membership, and provisioning already made their accounts).
 * The welcome message is authored by the owner and pinned, exactly what the
 * API path produced. Idempotent: an existing server of the same name owned by
 * the same account is completed, not duplicated. Writes state/servers.json,
 * which the runner and the Fly deploy both read.
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const REPO = join(ROOT, "..", "..");

const { getPool } = await import(
  new URL("file://" + join(REPO, "server/dist/db.js")).href
);
const servers = await import(
  new URL("file://" + join(REPO, "server/dist/services/servers.js")).href
);
const invites = await import(
  new URL("file://" + join(REPO, "server/dist/services/invites.js")).href
);
const messages = await import(
  new URL("file://" + join(REPO, "server/dist/services/messages.js")).href
);
const { loadCommunities } = await import(
  new URL("file://" + join(ROOT, "src/config.js")).href
);

const argv = process.argv.slice(2);
const valueOf = (args, flag) => {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
};
const configPath = valueOf(argv, "--config") ?? join(ROOT, "personas.yaml");
const ownerTag = valueOf(argv, "--owner-tag");
/**
 * Which communities to seed. COMMA-SEPARATED, and it accepts a list rather than
 * one key because the roster is now fifteen: provisioning a batch of new rooms
 * against a live database is something you do a few at a time, checking the
 * result, and `--community a,b,c` is the difference between one careful run and
 * three commands with a different flag value each.
 */
const only = (valueOf(argv, "--community") ?? "")
  .split(",")
  .map((key) => key.trim())
  .filter(Boolean);
const outPath = valueOf(argv, "--out") ?? join(ROOT, "state", "servers.json");

if (!process.env.DATABASE_URL) {
  console.error("DATABASE_URL is required.");
  process.exit(1);
}
if (!ownerTag || !/^.+#\d{4}$/.test(ownerTag)) {
  console.error("--owner-tag 'name#1234' is required (the human owner).");
  process.exit(1);
}

const pool = getPool();

const [ownerName, ownerDisc] = [
  ownerTag.slice(0, ownerTag.lastIndexOf("#")),
  ownerTag.slice(ownerTag.lastIndexOf("#") + 1),
];
const ownerRes = await pool.query(
  `SELECT * FROM users WHERE username = $1 AND discriminator = $2 AND NOT is_character`,
  [ownerName, ownerDisc],
);
const owner = ownerRes.rows[0];
if (!owner) {
  console.error(`No human account with tag ${ownerTag}.`);
  process.exit(1);
}
console.log(`Owner: ${owner.display_name} (${ownerTag})\n`);

const all = loadCommunities(configPath);
const communities = only.length
  ? all.filter((c) => only.includes(c.community.key))
  : all;
if (communities.length === 0) {
  console.error(
    `No community matched --community ${only.join(",")}. Known: ` +
      all.map((c) => c.community.key).join(", "),
  );
  process.exit(1);
}

const placements = existsSync(outPath)
  ? JSON.parse(readFileSync(outPath, "utf8"))
  : {};

for (const config of communities) {
  const { community, personas } = config;
  console.log(`── ${community.displayName}`);

  // Find-or-create by name under this owner. Names are not globally unique,
  // so scoping to the owner is what makes a re-run complete rather than clone.
  const existing = await pool.query(
    `SELECT id FROM servers WHERE name = $1 AND owner_id = $2`,
    [community.displayName, owner.id],
  );
  let serverId = existing.rows[0]?.id;
  if (!serverId) {
    const created = await servers.createServer(community.displayName, owner.id);
    serverId = created.server.id;
    console.log(`   created server ${serverId}`);
  } else {
    console.log(`   server exists ${serverId}`);
  }

  // Channels: create the missing, set every topic. The factory channels the
  // service made (general/Lobby) are renamed onto the first text/voice slot,
  // matching what the API seeder did.
  const wanted = community.channels ?? [];
  const rows = await pool.query(
    `SELECT id, name, type FROM channels WHERE server_id = $1 AND parent_id IS NULL`,
    [serverId],
  );
  const have = new Map(rows.rows.map((r) => [r.name, r]));
  const firstText = wanted.find((c) => (c.type ?? "text") === "text");
  const firstVoice = wanted.find((c) => c.type === "voice");
  const factoryText = rows.rows.find((r) => r.type === "text" && r.name === "general");
  const factoryVoice = rows.rows.find((r) => r.type === "voice" && r.name === "Lobby");
  if (factoryText && firstText && !have.has(firstText.name)) {
    await servers.updateChannel(factoryText.id, {
      name: firstText.name,
      topic: firstText.topic ?? null,
    });
    have.set(firstText.name, { ...factoryText, name: firstText.name });
    console.log(`   renamed general -> #${firstText.name}`);
  }
  if (factoryVoice && firstVoice && !have.has(firstVoice.name)) {
    await servers.updateChannel(factoryVoice.id, {
      name: firstVoice.name,
      topic: firstVoice.topic ?? null,
    });
    have.set(firstVoice.name, { ...factoryVoice, name: firstVoice.name });
    console.log(`   renamed Lobby -> ${firstVoice.name}`);
  }
  for (const ch of wanted) {
    if (have.has(ch.name)) {
      const row = have.get(ch.name);
      if (ch.topic) await servers.updateChannel(row.id, { topic: ch.topic });
      continue;
    }
    const row = await servers.createChannel(serverId, ch.name, ch.type ?? "text");
    if (ch.topic) await servers.updateChannel(row.id, { topic: ch.topic });
    have.set(ch.name, row);
    console.log(`   +#${ch.name}`);
  }

  // Cast membership. Directly: characters cannot redeem invites over HTTP
  // without a seeding-time token dance, and membership is a fact about the
  // server, not a journey. The member_count trigger keeps the count honest.
  const labels = personas.map((p) => p.id);
  const cast = await pool.query(
    `SELECT u.id, u.display_name FROM character_accounts ca
     JOIN users u ON u.id = ca.user_id
     WHERE ca.label = ANY($1) AND ca.revoked_at IS NULL`,
    [labels],
  );
  for (const member of cast.rows) {
    await pool.query(
      `INSERT INTO server_members (server_id, user_id, role)
       VALUES ($1, $2, 'member') ON CONFLICT DO NOTHING`,
      [serverId, member.id],
    );
  }
  console.log(`   cast: ${cast.rows.length} member(s)`);
  if (cast.rows.length < labels.length) {
    // Loud, because the symptom otherwise arrives hours later as a room whose
    // scheduler picks a persona that has no account to speak from. The usual
    // cause is a provision run that predates this community.
    const missing = labels.length - cast.rows.length;
    console.log(
      `   ! ${missing} persona(s) have no character account — ` +
        `run: node scripts/provision.mjs --config ${configPath}`,
    );
  }

  // Invite + pinned welcome, authored by the owner like the API path.
  const inviteRow = await invites.createInvite(serverId, owner.id, {});
  const mainName = firstText?.name ?? "general";
  const mainRow = have.get(mainName) ?? rows.rows.find((r) => r.type === "text");
  const pinned = await pool.query(
    `SELECT 1 FROM messages WHERE channel_id = $1 AND pinned_at IS NOT NULL LIMIT 1`,
    [mainRow.id],
  );
  if (pinned.rows.length === 0 && community.welcome) {
    const message = await messages.createMessage(mainRow.id, owner, community.welcome);
    if (message) await messages.pinMessage(message.id, owner.id);
    console.log(`   welcome pinned`);
  }

  placements[community.key] = {
    serverId,
    inviteCode: inviteRow.code,
    channelId: mainRow.id,
    channelName: mainRow.name ?? mainName,
    displayName: community.displayName,
    // Recorded for the operator reading this file, not read back by anything:
    // `opt-in-communities.mjs` takes the listing from personas.yaml so the two
    // cannot drift. Here they answer "what did this run actually seed".
    category: community.category ?? null,
    language: community.language,
    seededAt: new Date().toISOString(),
  };
}

mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, JSON.stringify(placements, null, 2));
console.log(
  `\n${communities.length} communit(ies) seeded. Wrote ${outPath}` +
    `\nNext: node scripts/opt-in-communities.mjs --dry-run`,
);
await pool.end();

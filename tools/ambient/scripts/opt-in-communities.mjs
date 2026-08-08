#!/usr/bin/env node
/**
 * Put the seeded launch communities in the public directory.
 *
 * Separate from seeding on purpose: creating a server is reversible-private,
 * listing it is the public act — the flag the whole communities feature keeps
 * deliberate. Run it when the rooms are ready to be seen.
 *
 *   DATABASE_URL=… node scripts/opt-in-communities.mjs
 *   DATABASE_URL=… node scripts/opt-in-communities.mjs --community deu-merge
 *   DATABASE_URL=… node scripts/opt-in-communities.mjs --dry-run
 *
 * THE LISTING LIVES IN personas.yaml, NOT HERE. It used to be a hardcoded map
 * of five keys in this file, which was fine while the roster was five and wrong
 * the moment it was fifteen: a community's category, its tagline and its
 * language are facts about the community, and keeping them in the deploy script
 * meant adding a room in one file and remembering to list it in another. They
 * now sit next to the personas they describe, which is the same rule the rest
 * of `tools/ambient` follows — adding a community is a diff in one file.
 *
 * A community with no `category` is SKIPPED rather than defaulted to `geral`.
 * Silently shelving somebody's room under "everything else" is worse than
 * saying "you did not say where this goes".
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const REPO = join(ROOT, "..", "..");
const { getPool } = await import(
  new URL("file://" + join(REPO, "server/dist/db.js")).href
);
const { loadCommunities } = await import(
  new URL("file://" + join(ROOT, "src/config.js")).href
);

const argv = process.argv.slice(2);
const valueOf = (flag) => {
  const i = argv.indexOf(flag);
  return i >= 0 ? argv[i + 1] : undefined;
};
const configPath = valueOf("--config") ?? join(ROOT, "personas.yaml");
const statePath = valueOf("--servers") ?? join(ROOT, "state", "servers.json");
const only = (valueOf("--community") ?? "")
  .split(",")
  .map((key) => key.trim())
  .filter(Boolean);
const dryRun = argv.includes("--dry-run");

if (!process.env.DATABASE_URL) {
  console.error("DATABASE_URL is required.");
  process.exit(1);
}

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

const placements = JSON.parse(readFileSync(statePath, "utf8"));
const pool = getPool();
let listed = 0;
let skipped = 0;

for (const config of communities) {
  const { key, category, tagline, language, displayName } = config.community;
  const placement = placements[key];
  if (!placement) {
    console.log(`skip ${key}: not in ${statePath} — seed it first`);
    skipped += 1;
    continue;
  }
  if (!category) {
    console.log(`skip ${key}: no \`category\` in ${configPath}`);
    skipped += 1;
    continue;
  }
  if (dryRun) {
    console.log(
      `~ would list ${displayName} (${category}, ${language}) — "${tagline ?? ""}"`,
    );
    continue;
  }
  const result = await pool.query(
    `UPDATE servers SET is_community = true, community_category = $2,
            community_tagline = $3, community_language = $4
     WHERE id = $1 RETURNING name, member_count`,
    [placement.serverId, category, tagline ?? null, language],
  );
  const row = result.rows[0];
  if (row) {
    listed += 1;
    console.log(
      `listed ${row.name} (${category}, ${language}, ${row.member_count} members)`,
    );
  } else {
    skipped += 1;
    console.log(`missing ${key}: no server ${placement.serverId}`);
  }
}

console.log(
  dryRun
    ? `\nDry run — nothing was written.`
    : `\n${listed} listed, ${skipped} skipped.`,
);
await pool.end();

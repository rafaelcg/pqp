#!/usr/bin/env node
/**
 * Put the seeded launch communities in the public directory.
 *
 * Separate from seeding on purpose: creating a server is reversible-private,
 * listing it is the public act — the flag the whole communities feature keeps
 * deliberate. Run it when the rooms are ready to be seen.
 *
 *   DATABASE_URL=… node scripts/opt-in-communities.mjs
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const REPO = join(ROOT, "..", "..");
const { getPool } = await import(
  new URL("file://" + join(REPO, "server/dist/db.js")).href
);

/** Category slugs must match communityCategorySchema; taglines are the card. */
const LISTINGS = {
  "resenha-fc": ["futebol", "Tabela, palpite e choro coletivo. Todo time é bem-vindo, zoeira garantida."],
  "maratona": ["series-filmes", "O que você tá vendo? Spoiler só com aviso, recomendação sem dó."],
  "fone-com-fio": ["musica", "Do lançamento ao lado B: mostra o que tá tocando no teu fone."],
  "sala-de-espera": ["games", "Procura duo, reclama do patch, posta o clipe. A fila anda melhor acompanhado."],
  "vespera-de-prova": ["estudos", "Cronograma, dúvida e procrastinação assumida. Estudar junto rende mais."],
};

const placements = JSON.parse(
  readFileSync(join(ROOT, "state", "servers.json"), "utf8"),
);
const pool = getPool();
for (const [key, [category, tagline]] of Object.entries(LISTINGS)) {
  const placement = placements[key];
  if (!placement) {
    console.log(`skip ${key}: not in state/servers.json`);
    continue;
  }
  const result = await pool.query(
    `UPDATE servers SET is_community = true, community_category = $2, community_tagline = $3
     WHERE id = $1 RETURNING name, member_count`,
    [placement.serverId, category, tagline],
  );
  const row = result.rows[0];
  console.log(row ? `listed ${row.name} (${category}, ${row.member_count} members)` : `missing ${key}`);
}
await pool.end();

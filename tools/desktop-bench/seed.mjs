// Seeds a scratch local pqp with what the desktop scenes need, THROUGH THE LOCAL
// DEV AUTH BYPASS (CLAUDE.md, "Dev auth bypass"):
//
//   - the Sandbox hall the API seeds on boot (text, voice, 15 dummy members);
//   - a second real account (`dev-local-token:bob`, the `pqp:dev-user-suffix`
//     mechanism) that has joined it, so a call has two people in it;
//   - 2,000 messages in #off-topic, in the mix the spike used (markdown, code
//     fences, quotes, long lines), with a known first and last row;
//   - a live watch party channel (state `live`) for scene S7.
//
// Everything that has an HTTP route goes through the API with the bypass
// bearer. The 2,000 messages are one INSERT ... SELECT over generate_series,
// because 2,000 sends over the socket would be a different benchmark (rate
// limits, fan-out) and minutes of wall clock.
//
// SAFETY. The bulk insert and the cleanup write straight to Postgres, so this
// refuses anything but a database on this machine whose name starts with
// `pqp_bench`. It cannot be pointed at DATABASE_URL by accident.
//
// Library: `seed({ apiUrl, databaseUrl })`. CLI (against an API already
// running with DEV_AUTH_BYPASS=true on that database):
//   node tools/desktop-bench/seed.mjs --api http://127.0.0.1:3971 --db postgres://...
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assertLoopbackApi, localPgConfig } from "./lib/local-pg.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, "../..");
const pg = createRequire(path.join(repo, "server", "package.json"))("pg");

export const DEV_TOKEN = "dev-local-token";
export const HISTORY_ROWS = 2000;
/** The newest message of the light channel, written by the API's own dev seed. */
export const LIGHT_MARKER = "o estrela é esse";
/** The newest and the oldest row of the heavy channel. */
export const HEAVY_LAST_MARKER = "bench-ultima-2000";
export const HEAVY_FIRST_MARKER = "bench-primeira-1";

/** Throws unless `databaseUrl` is a local database named like a scratch one. */
export function assertScratchDatabase(databaseUrl) {
  return localPgConfig(databaseUrl, { benchDatabase: true }).database;
}

async function api(apiUrl, token, route, init = {}) {
  const response = await fetch(`${apiUrl}${route}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
      ...(init.headers ?? {}),
    },
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`${init.method ?? "GET"} ${route}: HTTP ${response.status} ${text.slice(0, 300)}`);
  }
  return text ? JSON.parse(text) : {};
}

/** A second (or third) account past the age gate and onboarding, like e2e/fixtures does. */
export async function materialiseAccount(apiUrl, suffix) {
  const token = suffix ? `${DEV_TOKEN}:${suffix}` : DEV_TOKEN;
  const me = await api(apiUrl, token, "/api/me");
  if (me.ageGate && me.ageGate !== "passed") {
    await api(apiUrl, token, "/api/me/age-check", {
      method: "POST",
      body: JSON.stringify({ dateOfBirth: "1990-01-01" }),
    });
  }
  const now = new Date().toISOString();
  await api(apiUrl, token, "/api/me/preferences", {
    method: "PATCH",
    body: JSON.stringify({ onboardedAt: now, firstRunDismissedAt: now }),
  });
  return me.id;
}

async function waitForHall(apiUrl) {
  const deadline = Date.now() + 60_000;
  for (;;) {
    try {
      const { servers } = await api(apiUrl, DEV_TOKEN, "/api/servers");
      const hall = servers.find((s) => s.name === "Sandbox");
      if (hall) {
        const { channels } = await api(apiUrl, DEV_TOKEN, `/api/servers/${hall.id}/channels`);
        const general = channels.find((c) => c.name === "general" && c.type === "text");
        const offTopic = channels.find((c) => c.name === "off-topic" && c.type === "text");
        const voice = channels.find((c) => c.type === "voice");
        if (general && offTopic && voice) return { hall, channels, general, offTopic, voice };
      }
    } catch (error) {
      if (Date.now() > deadline) throw error;
    }
    if (Date.now() > deadline) throw new Error("the Sandbox hall never appeared (is DEV_AUTH_BYPASS on and DEV_SEED not false?)");
    await new Promise((r) => setTimeout(r, 500));
  }
}

export async function seed({ apiUrl, databaseUrl, log = () => {} }) {
  const pgConfig = localPgConfig(databaseUrl, { benchDatabase: true });
  assertLoopbackApi(apiUrl);
  const { hall, general, offTopic, voice } = await waitForHall(apiUrl);
  log(`sandbox ${hall.id}: general ${general.id}, off-topic ${offTopic.id}, voice ${voice.id}`);

  // The main account (the shared Dev User) and the second participant.
  await materialiseAccount(apiUrl, null);
  await materialiseAccount(apiUrl, "bob");
  const { invite } = await api(apiUrl, DEV_TOKEN, `/api/servers/${hall.id}/invites`, {
    method: "POST",
    body: JSON.stringify({}),
  });
  await api(apiUrl, `${DEV_TOKEN}:bob`, `/api/invites/${invite.code}/join`, { method: "POST" });
  // "You're responsible for what you stream" is a one-time sheet per user and
  // server (`hls_host_acks`); a share scene must not wait on a dialog.
  for (const token of [DEV_TOKEN, `${DEV_TOKEN}:bob`]) {
    await api(apiUrl, token, `/api/voice/hls-host-ack/${hall.id}`, { method: "POST" });
  }
  log("second participant (bob) joined, share notice acknowledged for both accounts");

  const db = new pg.Client(pgConfig);
  await db.connect();
  try {
    // The API's own dev seed adds the dummy roster after the hall exists; wait
    // for all of it (15 people, the owner, bob) so message authors are real.
    const memberDeadline = Date.now() + 60_000;
    let members = 0;
    while (Date.now() < memberDeadline) {
      members = (await db.query("SELECT count(*)::int AS n FROM server_members WHERE server_id = $1", [hall.id])).rows[0].n;
      if (members >= 17) break;
      await new Promise((r) => setTimeout(r, 500));
    }
    if (members < 17) throw new Error(`the Sandbox roster never filled up (${members} members)`);
    const have = await db.query("SELECT count(*)::int AS n FROM messages WHERE channel_id = $1", [offTopic.id]);
    if (have.rows[0].n < HISTORY_ROWS) {
      await db.query("DELETE FROM messages WHERE channel_id = $1", [offTopic.id]);
      await db.query(
        `INSERT INTO messages (channel_id, author_id, body, created_at)
         SELECT $1,
                (SELECT user_id FROM server_members WHERE server_id = $2 ORDER BY user_id OFFSET (g % 17) LIMIT 1),
                CASE
                  WHEN g = 1 THEN '${HEAVY_FIRST_MARKER}'
                  WHEN g = $3 THEN '${HEAVY_LAST_MARKER}'
                  ELSE CASE g % 7
                    WHEN 0 THEN 'mensagem ' || g || ' com **negrito** e um \`codigo inline\`'
                    WHEN 1 THEN 'alguém joga hoje? ' || g
                    WHEN 2 THEN E'bloco de código:\n\`\`\`ts\nconst x = ' || g || E';\nconsole.log(x)\n\`\`\`'
                    WHEN 3 THEN 'uma mensagem mais longa, número ' || g || ', com texto bastante para quebrar a linha duas ou três vezes em uma janela normal de desktop.'
                    WHEN 4 THEN '> citação ' || g || E'\nresposta embaixo'
                    WHEN 5 THEN 'kkkkkkk'
                    ELSE E'- item a\n- item b ' || g
                  END
                END,
                now() - (($3 - g) * interval '20 seconds')
           FROM generate_series(1, $3::int) g`,
        [offTopic.id, hall.id, HISTORY_ROWS],
      );
    }
    log(`#off-topic holds ${HISTORY_ROWS} messages`);
  } finally {
    await db.end();
  }

  // A live watch party: the real create and state routes. Reuse one a failed
  // earlier seed left behind instead of making a second.
  // A failed listing must fail the seed, not look like "no party yet".
  const listed = await api(apiUrl, DEV_TOKEN, `/api/servers/${hall.id}/watch-parties`);
  let party = (listed.parties ?? []).find((p) => p.name === "bench party") ?? null;
  if (!party) {
    ({ party } = await api(apiUrl, DEV_TOKEN, `/api/servers/${hall.id}/watch-parties`, {
      method: "POST",
      body: JSON.stringify({ name: "bench party" }),
    }));
  }
  if (party.status !== "live") {
    await api(apiUrl, DEV_TOKEN, `/api/watch-parties/${party.id}/state`, {
      method: "POST",
      body: JSON.stringify({ state: "live" }),
    });
  }
  log(`watch party ${party.id} live in channel ${party.channelId}`);

  return {
    serverId: hall.id,
    lightChannelId: general.id,
    heavyChannelId: offTopic.id,
    voiceChannelId: voice.id,
    partyId: party.id,
    partyChannelId: party.channelId,
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const arg = (name) => {
    const i = process.argv.indexOf(`--${name}`);
    return i >= 0 ? process.argv[i + 1] : undefined;
  };
  const apiUrl = arg("api");
  const databaseUrl = arg("db");
  if (!apiUrl || !databaseUrl) {
    console.error("usage: node seed.mjs --api <http://127.0.0.1:PORT> --db <postgres://...pqp_bench...>");
    process.exit(2);
  }
  seed({ apiUrl, databaseUrl, log: (m) => console.error(`[seed] ${m}`) })
    .then((ids) => console.log(JSON.stringify(ids, null, 2)))
    .catch((error) => {
      console.error(error);
      process.exit(1);
    });
}

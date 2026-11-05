import { createRequire } from "node:module";
import path from "node:path";
import { expect, type Page } from "@playwright/test";

/**
 * Seeding for `message-window.spec.ts`: a channel with thousands of messages.
 *
 * A socket sends about twenty messages a second, so two thousand through the
 * product would take two minutes of a spec. The rows go in with one INSERT
 * instead, straight into the database the e2e server uses; the server and the
 * client then read them exactly as they read any history. `pg` is the server
 * package's, resolved from there so the client needs no new dependency.
 */

export const API = process.env.E2E_API_URL ?? "http://localhost:3101";
const WS_URL = API.replace(/^http/, "ws") + "/ws";
const DEV_TOKEN = "dev-local-token";
const DATABASE_URL =
  process.env.E2E_DATABASE_URL ??
  "postgresql://pqp:pqp@localhost:5432/pqp_test";

interface PgPool {
  query: (
    text: string,
    values?: unknown[],
  ) => Promise<{ rows: Record<string, string>[] }>;
  end: () => Promise<void>;
}

async function withPool<T>(run: (pool: PgPool) => Promise<T>): Promise<T> {
  const serverRequire = createRequire(
    path.resolve(process.cwd(), "../server/package.json"),
  );
  const { Pool } = serverRequire("pg") as {
    Pool: new (config: { connectionString: string }) => PgPool;
  };
  const pool = new Pool({ connectionString: DATABASE_URL });
  try {
    return await run(pool);
  } finally {
    await pool.end();
  }
}

export function headersFor(suffix: string) {
  return {
    "Content-Type": "application/json",
    Authorization: `Bearer ${DEV_TOKEN}:${suffix}`,
  };
}

/** Make the account exist, over 18 and past onboarding. */
export async function materialise(suffix: string): Promise<void> {
  const headers = headersFor(suffix);
  const me = (await (await fetch(`${API}/api/me`, { headers })).json()) as {
    ageGate?: string;
  };
  if (me.ageGate && me.ageGate !== "passed") {
    await fetch(`${API}/api/me/age-check`, {
      method: "POST",
      headers,
      body: JSON.stringify({ dateOfBirth: "1990-01-01" }),
    });
  }
  const now = new Date().toISOString();
  await fetch(`${API}/api/me/preferences`, {
    method: "PATCH",
    headers,
    body: JSON.stringify({ onboardedAt: now, firstRunDismissedAt: now }),
  });
}

export interface LongChannel {
  serverId: string;
  channelId: string;
  owner: string;
  guest: string;
  other: string;
  count: number;
  /** Message id by its number: `msg N`. Only the ones asked for. */
  ids: Map<number, string>;
  /** The newest message replies to message 10. Its id. */
  replyId: string;
}

/**
 * A server with one text channel of `count` messages by three people, a day
 * boundary every so often, bodies from one word to a paragraph, and one last
 * message that replies to message 10. `msg N` opens every body.
 */
export async function seedLongChannel(count: number): Promise<LongChannel> {
  const stamp = Date.now().toString(36);
  const owner = `win-owner-${stamp}`;
  const guest = `win-guest-${stamp}`;
  const other = `win-other-${stamp}`;
  for (const suffix of [owner, guest, other]) {
    await materialise(suffix);
  }
  const created = await fetch(`${API}/api/servers`, {
    method: "POST",
    headers: headersFor(owner),
    body: JSON.stringify({ name: `Window ${stamp}` }),
  });
  const { server } = (await created.json()) as { server: { id: string } };
  const { channels } = (await (
    await fetch(`${API}/api/servers/${server.id}/channels`, {
      headers: headersFor(owner),
    })
  ).json()) as { channels: { id: string; type: string }[] };
  const channel = channels.find((one) => one.type === "text")!;
  const { invite } = (await (
    await fetch(`${API}/api/servers/${server.id}/invites`, {
      method: "POST",
      headers: headersFor(owner),
      body: "{}",
    })
  ).json()) as { invite: { code: string } };
  for (const joiner of [guest, other]) {
    const joined = await fetch(`${API}/api/invites/${invite.code}/join`, {
      method: "POST",
      headers: headersFor(joiner),
    });
    expect(joined.ok, `${joiner} joins`).toBe(true);
  }

  const ids = new Map<number, string>();
  let replyId = "";
  await withPool(async (pool) => {
    const users = await pool.query(
      `SELECT clerk_id, id FROM users WHERE clerk_id = ANY($1)`,
      [[owner, guest, other].map((suffix) => `dev_local_user_${suffix}`)],
    );
    const idOf = (suffix: string) =>
      users.rows.find((row) => row.clerk_id === `dev_local_user_${suffix}`)!.id;
    await pool.query(
      `INSERT INTO messages (channel_id, author_id, body, created_at)
       SELECT $1::uuid,
              (ARRAY[$2, $3, $4]::uuid[])[(i / 3) % 3 + 1],
              'msg ' || i || ' ' || (ARRAY[
                'ok',
                'bora',
                'alguem viu o jogo de ontem?',
                E'primeira linha\\n\\nsegunda linha com **negrito** e mais texto pra quebrar',
                repeat('mensagem longa ', 18),
                'tudo certo por aqui, depois eu te aviso quando tiver pronto',
                'kkkk'
              ])[(i * 7 + i % 5) % 7 + 1],
              now() - (($5::int - i) * interval '40 seconds')
       FROM generate_series(0, $5::int - 1) AS i`,
      [channel.id, idOf(owner), idOf(guest), idOf(other), count],
    );
    const found = await pool.query(
      `SELECT id, body FROM messages WHERE channel_id = $1 AND body ~ '^msg (10|300|700|1200|1500|1960) '`,
      [channel.id],
    );
    for (const row of found.rows) {
      ids.set(Number(/^msg (\d+) /.exec(row.body)![1]), row.id);
    }
    const reply = await pool.query(
      `INSERT INTO messages (channel_id, author_id, body, reply_to_id, created_at)
       VALUES ($1, $2, 'msg ' || $3::int || ' the reply', $4, now())
       RETURNING id`,
      [channel.id, idOf(other), count, ids.get(10)],
    );
    replyId = reply.rows[0]!.id;
  });
  return {
    serverId: server.id,
    channelId: channel.id,
    owner,
    guest,
    other,
    count,
    ids,
    replyId,
  };
}

/** Set a person's read cursor on a channel to the moment message `n` was sent. */
export async function readUpTo(
  seeded: LongChannel,
  suffix: string,
  n: number,
): Promise<void> {
  await withPool(async (pool) => {
    await pool.query(
      `INSERT INTO channel_reads (channel_id, user_id, last_read_at)
       SELECT $1::uuid, u.id, m.created_at
       FROM users u, messages m
       WHERE u.clerk_id = $2 AND m.channel_id = $1 AND m.body LIKE 'msg ' || $3::int || ' %'
       ON CONFLICT (channel_id, user_id) DO UPDATE SET last_read_at = EXCLUDED.last_read_at`,
      [seeded.channelId, `dev_local_user_${suffix}`, n],
    );
  });
}

/** One message from one account, over its own socket, as a person sends it. */
export async function sendAs(
  suffix: string,
  channelId: string,
  body: string,
): Promise<void> {
  const socket = new WebSocket(WS_URL);
  // Unique per send: the server stores the nonce per author and answers a
  // repeat with the message it already made, so two sends with one nonce are one.
  const nonce = `window-spec-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  try {
    await new Promise<void>((resolve, reject) => {
      socket.addEventListener("open", () => resolve());
      socket.addEventListener("error", () => reject(new Error("ws error")));
    });
    const ready = new Promise<void>((resolve) => {
      socket.addEventListener("message", (event) => {
        if ((JSON.parse(String(event.data)) as { type: string }).type === "ready") {
          resolve();
        }
      });
    });
    socket.send(
      JSON.stringify({ type: "auth", token: `${DEV_TOKEN}:${suffix}` }),
    );
    await ready;
    socket.send(JSON.stringify({ type: "join-channel", channelId }));
    const answered = new Promise<{ type: string }>((resolve) => {
      socket.addEventListener("message", (event) => {
        const frame = JSON.parse(String(event.data)) as {
          type: string;
          nonce?: string;
        };
        if (frame.nonce === nonce) {
          resolve(frame);
        }
      });
    });
    socket.send(
      JSON.stringify({
        type: "message-create",
        channelId,
        body,
        nonce,
      }),
    );
    const frame = await answered;
    expect(frame.type, "the send is accepted").not.toBe("message-rejected");
  } finally {
    socket.close();
  }
}

/** Open the channel as `suffix`, the way a person would land on it. */
export async function openChannel(
  page: Page,
  seeded: LongChannel,
  suffix: string,
  tail = "",
): Promise<void> {
  await page.addInitScript((value) => {
    localStorage.setItem("pqp:dev-user-suffix", value);
  }, suffix);
  await page.goto(
    `/app/server/${seeded.serverId}/channel/${seeded.channelId}${tail}?lang=en`,
  );
  await expect(page.locator('[role="log"]')).toBeVisible({ timeout: 30_000 });
}

/** Scroll to the top until message 0 is loaded: the whole history is in memory. */
export async function loadAllHistory(page: Page): Promise<void> {
  const first = page.locator('[role="log"] article[aria-label*="msg 0 "]');
  const height = () =>
    page.evaluate(
      () => document.querySelector<HTMLElement>('[role="log"]')!.scrollHeight,
    );
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    if ((await first.count()) > 0) {
      return;
    }
    const before = await page.evaluate(() => {
      const scroller = document.querySelector<HTMLElement>('[role="log"]')!;
      scroller.scrollTop = 0;
      return scroller.scrollHeight;
    });
    // One page in: the transcript grew (or a second passes, and we ask again).
    for (let wait = 0; wait < 30; wait += 1) {
      await page.waitForTimeout(50);
      if ((await height()) > before + 50) {
        break;
      }
    }
  }
  throw new Error("never reached the first message");
}

export interface DomStats {
  articles: number;
  nodes: number;
  mountedRows: number;
  scrollHeight: number;
}

export function domStats(page: Page): Promise<DomStats> {
  return page.evaluate(() => {
    const scroller = document.querySelector<HTMLElement>('[role="log"]')!;
    const window = document.querySelector<HTMLElement>("[data-message-window]");
    return {
      articles: scroller.querySelectorAll("article").length,
      nodes: document.getElementsByTagName("*").length,
      mountedRows: Number(window?.dataset.mountedRows ?? -1),
      scrollHeight: scroller.scrollHeight,
    };
  });
}

/** `msg N`'s article: where it sits against the transcript's viewport, or null. */
export function placementOf(page: Page, n: number) {
  return page.evaluate((n) => {
    const row = Array.from(
      document.querySelectorAll('[role="log"] article'),
    ).find((one) =>
      // ". msg N ": the body, after the name and time. A reply to N quotes it
      // after ": " in its own label, and is not N.
      (one.getAttribute("aria-label") ?? "").includes(`. msg ${n} `),
    );
    const scroller = document.querySelector<HTMLElement>('[role="log"]')!;
    if (!row) {
      return null;
    }
    const box = scroller.getBoundingClientRect();
    const rect = row.getBoundingClientRect();
    return {
      top: rect.top - box.top,
      height: rect.height,
      offCentre: rect.top + rect.height / 2 - (box.top + box.height / 2),
      viewport: box.height,
      scrollTop: scroller.scrollTop,
      distanceFromBottom:
        scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight,
    };
  }, n);
}

/** The topmost article that is (at least partly) inside the viewport. */
export function firstVisibleArticle(page: Page) {
  return page.evaluate(() => {
    const scroller = document.querySelector<HTMLElement>('[role="log"]')!;
    const box = scroller.getBoundingClientRect();
    for (const row of Array.from(scroller.querySelectorAll("article"))) {
      const rect = row.getBoundingClientRect();
      if (rect.bottom > box.top + 1) {
        const label = row.getAttribute("aria-label") ?? "";
        return {
          n: Number(/msg (\d+) /.exec(label)?.[1] ?? -1),
          top: rect.top - box.top,
        };
      }
    }
    return null;
  });
}

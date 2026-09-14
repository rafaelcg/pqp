import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import type { WebSocket } from "ws";
import type { DbUser } from "../db.js";
import { createMemoryHub } from "../lib/bus.js";

/**
 * THE REMINDER TICK RUNS WHERE THERE ARE NO SOCKETS.
 *
 * Production runs `jobs.ts` on `pqp-worker` (`WORKER_MODE=worker`), a process
 * with no `/ws` listener at all, and the two `pqp-api` machines hold every
 * socket. `notifyChannelSessionSubscribers` walked THIS process's sockets, so
 * on the worker it walked zero: "your session starts in ten minutes" arrived
 * as a Web Push and as nothing at all in the open tab, which is the one place
 * the person is already looking.
 *
 * Two real module graphs over one memory hub — the worker's and an API
 * machine's — because the sockets and the bus subscription have to be
 * genuinely separate for the question to mean anything. Real Postgres,
 * because the claim that decides a reminder is due is an UPDATE ... RETURNING
 * and a fake would prove nothing about it.
 *
 * Push is mocked: what is under test is the socket half, and the assertion
 * that matters about push is that the RELAYED copy does not send a second one.
 */

const DATABASE_URL = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
const describeDb = DATABASE_URL ? describe : describe.skip;

if (DATABASE_URL) {
  process.env.DATABASE_URL = DATABASE_URL;
}

const pushed = vi.hoisted(() => vi.fn());
vi.mock("./push.js", () => ({
  pushChannelSessionReminder: (input: unknown) => pushed(input),
}));

type BusModule = typeof import("../lib/bus.js");
type SessionsModule = typeof import("./channel-sessions.js");
type SocketsModule = typeof import("../ws/sockets.js");
type DbModule = typeof import("../db.js");

interface Instance {
  bus: BusModule;
  sessions: SessionsModule;
  sockets: SocketsModule;
  db: DbModule;
}

const hub = createMemoryHub();
const booted: Instance[] = [];

/**
 * One process. `publishOnly` is the worker's shape: it installs a transport so
 * `isBusEnabled()` is true and its publishes leave the process, and it holds
 * no sockets. The memory transport delivers both ways, which is harmless here
 * — nothing on the worker graph subscribes to anything it would act on — and
 * the assertion that the worker sends no second push covers the half that
 * would matter.
 */
async function bootInstance(): Promise<Instance> {
  vi.resetModules();
  const bus = (await import("../lib/bus.js")) as BusModule;
  const db = (await import("../db.js")) as DbModule;
  const sessions = (await import("./channel-sessions.js")) as SessionsModule;
  const sockets = (await import("../ws/sockets.js")) as SocketsModule;
  bus.setBusTransport(bus.createMemoryTransport(hub));
  const instance = { bus, sessions, sockets, db };
  booted.push(instance);
  return instance;
}

interface Frame {
  type: string;
  [key: string]: unknown;
}

function recorder(): { socket: WebSocket; frames: Frame[] } {
  const frames: Frame[] = [];
  const socket = {
    readyState: 1,
    send: (payload: string) => frames.push(JSON.parse(payload) as Frame),
    on: () => {},
  } as unknown as WebSocket;
  return { socket, frames };
}

async function waitFor(check: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 3_000;
  while (!check()) {
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for ${what}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describeDb("a worker-side channel-session reminder reaches API sockets", () => {
  let worker: Instance;
  let api: Instance;
  let userId: string;
  let channelId: string;
  let sessionId: string;

  beforeAll(async () => {
    vi.resetModules();
    const db = (await import("../db.js")) as DbModule;
    await db.initDb();
    await db.closePool();
  });

  afterAll(async () => {
    for (const instance of booted) {
      await instance.db.closePool().catch(() => {});
    }
  });

  beforeEach(async () => {
    pushed.mockClear();
    worker = await bootInstance();
    api = await bootInstance();
    const pool = worker.db.getPool();
    await pool.query(
      `TRUNCATE users, servers, channels, channel_sessions,
                channel_session_reminders RESTART IDENTITY CASCADE`,
    );
    const user = await pool.query<{ id: string }>(
      `INSERT INTO users (clerk_id, display_name) VALUES ('clerk_reminder', 'Sub')
       RETURNING id`,
    );
    userId = user.rows[0]!.id;
    const server = await pool.query<{ id: string }>(
      `INSERT INTO servers (name, owner_id) VALUES ('hall', $1) RETURNING id`,
      [userId],
    );
    const channel = await pool.query<{ id: string }>(
      `INSERT INTO channels (server_id, name, type, position)
       VALUES ($1, 'sessao', 'voice', 0) RETURNING id`,
      [server.rows[0]!.id],
    );
    channelId = channel.rows[0]!.id;
    // Due now: T-10 has arrived, nothing has been notified yet.
    const session = await pool.query<{ id: string }>(
      `INSERT INTO channel_sessions
         (channel_id, server_id, title, starts_at, status, created_by)
       VALUES ($1, $2, 'O filme', NOW() + INTERVAL '2 minutes', 'scheduled', $3)
       RETURNING id`,
      [channelId, server.rows[0]!.id, userId],
    );
    sessionId = session.rows[0]!.id;
    await pool.query(
      `INSERT INTO channel_session_reminders (session_id, user_id)
       VALUES ($1, $2)`,
      [sessionId, userId],
    );
  });

  afterEach(async () => {
    for (const instance of booted.splice(0)) {
      await instance.bus.closeBus().catch(() => {});
      await instance.db.closePool().catch(() => {});
    }
  });

  it("delivers to a socket held by the other machine, and pushes exactly once", async () => {
    const rec = recorder();
    api.sockets.setAuthenticatedSocket(rec.socket, {
      id: userId,
      display_name: "Sub",
      avatar_url: null,
    } as unknown as DbUser);

    // The worker's own tick. It holds no sockets at all.
    await worker.sessions.sendDueChannelSessionReminders();

    await waitFor(
      () => rec.frames.some((f) => f.type === "channel-session-reminder"),
      "the reminder to cross to the API instance",
    );
    const frame = rec.frames.find((f) => f.type === "channel-session-reminder")!;
    expect(frame.sessionId).toBe(sessionId);
    expect(frame.channelId).toBe(channelId);
    expect(frame.title).toBe("O filme");
    expect(frame.kind).toBe("before");

    // ONE reminder frame, not one per machine: the relayed copy is delivered
    // by the instance that received it and re-published by nobody.
    expect(
      rec.frames.filter((f) => f.type === "channel-session-reminder"),
    ).toHaveLength(1);

    // And one push, from the process that claimed the row. A second one from
    // the relaying instance would be a second notification on the same phone.
    expect(pushed).toHaveBeenCalledTimes(1);
    expect(pushed.mock.calls[0]![0]).toMatchObject({
      userIds: [userId],
      channelId,
      kind: "before",
    });
  });

  it("does not deliver to somebody who never asked to be reminded", async () => {
    const other = await worker.db.getPool().query<{ id: string }>(
      `INSERT INTO users (clerk_id, display_name) VALUES ('clerk_bystander', 'Bys')
       RETURNING id`,
    );
    const rec = recorder();
    api.sockets.setAuthenticatedSocket(rec.socket, {
      id: other.rows[0]!.id,
      display_name: "Bys",
      avatar_url: null,
    } as unknown as DbUser);

    await worker.sessions.sendDueChannelSessionReminders();
    // Long enough for a frame to have crossed if one were addressed here: the
    // memory hub is synchronous, so this only has to outlast the claim.
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(rec.frames).toHaveLength(0);
  });

  it("claims once across the cluster: a second tick anywhere sends nothing", async () => {
    const rec = recorder();
    api.sockets.setAuthenticatedSocket(rec.socket, {
      id: userId,
      display_name: "Sub",
      avatar_url: null,
    } as unknown as DbUser);

    await worker.sessions.sendDueChannelSessionReminders();
    await waitFor(
      () => rec.frames.length > 0,
      "the first reminder to cross",
    );
    const after = rec.frames.length;

    // The API machine running the same tick (a single-process deployment, or
    // a worker that has not taken over yet) finds the row already stamped.
    await api.sessions.sendDueChannelSessionReminders();
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(rec.frames).toHaveLength(after);
    expect(pushed).toHaveBeenCalledTimes(1);
  });
});

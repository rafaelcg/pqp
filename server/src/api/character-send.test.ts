import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Permission } from "@pqp/shared";

/**
 * HTTP send for character accounts. Real Postgres, real `verifyAuthHeader`,
 * real router — the token is the whole credential, so a mock would assert
 * away the gate this route exists to enforce.
 */

const DATABASE_URL = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
const describeDb = DATABASE_URL ? describe : describe.skip;

if (DATABASE_URL) {
  process.env.DATABASE_URL = DATABASE_URL;
}

const { getPool, initDb, closePool } = await import("../db.js");
const { upsertUser, listUnread } = await import("../services/users.js");
const { createCharacterAccount, revokeCharacterAccount } = await import(
  "../services/characters.js"
);
const { openConversation } = await import("../services/dms.js");
const { issueTimeout } = await import("../services/sanctions.js");
const { createServer: createPqpServer } = await import("../services/servers.js");
const { createInvite, redeemInvite } = await import("../services/invites.js");
const { createThreadForMessage } = await import("../services/threads.js");
const { createMessage } = await import("../services/messages.js");
const { listRoles, upsertChannelOverwrite } = await import(
  "../services/roles.js"
);
const { clearAuthCaches } = await import("../auth/clerk.js");
const { handleApi, resetApiRateLimits } = await import("./index.js");
const { postChannelMessage, resetChatRateLimits } = await import(
  "../ws/chat.js"
);

async function withGate<T>(run: () => Promise<T>): Promise<T> {
  const previous = process.env.CHARACTER_ACCOUNTS_ENABLED;
  process.env.CHARACTER_ACCOUNTS_ENABLED = "true";
  try {
    return await run();
  } finally {
    if (previous === undefined) {
      delete process.env.CHARACTER_ACCOUNTS_ENABLED;
    } else {
      process.env.CHARACTER_ACCOUNTS_ENABLED = previous;
    }
    clearAuthCaches();
  }
}

describeDb("character HTTP send", () => {
  let httpServer: Server;
  let baseUrl: string;

  beforeAll(async () => {
    await initDb();
    httpServer = createServer((req, res) => {
      const pathname = new URL(req.url ?? "/", "http://localhost").pathname;
      void handleApi(req, res, pathname);
    });
    await new Promise<void>((done) => httpServer.listen(0, done));
    baseUrl = `http://127.0.0.1:${(httpServer.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise<void>((done) => httpServer.close(() => done()));
    await closePool();
  });

  beforeEach(async () => {
    delete process.env.CHARACTER_ACCOUNTS_ENABLED;
    clearAuthCaches();
    resetApiRateLimits();
    resetChatRateLimits();
    await getPool().query(
      `TRUNCATE users, user_preferences, servers, channels, messages,
                server_members, channel_members, server_invites, character_accounts,
                channel_overwrites, outgoing_webhooks, outgoing_webhook_deliveries,
                message_mentions, member_timeouts, channel_reads
       RESTART IDENTITY CASCADE`,
    );
  });

  const person = (name: string, clerkId: string) =>
    upsertUser({ clerkId, displayName: name, avatarUrl: null });

  const character = (label: string, displayName = label) =>
    createCharacterAccount({ label, displayName, createdBy: "test" });

  async function send(
    token: string | null,
    channelId: string,
    body: unknown,
  ): Promise<{
    status: number;
    retryAfter: string | null;
    body: Record<string, unknown>;
  }> {
    const response = await fetch(
      `${baseUrl}/api/channels/${channelId}/messages`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify(body),
      },
    );
    const text = await response.text();
    return {
      status: response.status,
      retryAfter: response.headers.get("retry-after"),
      body: (text ? JSON.parse(text) : {}) as Record<string, unknown>,
    };
  }

  /** A minted character already invited into a fresh server. */
  async function seated(clerkId: string) {
    const minted = await character("caio", "Caio");
    const owner = await person("Owner", clerkId);
    const { server, channels } = await createPqpServer("QG", owner.id);
    const invite = await createInvite(server.id, owner.id, {});
    await redeemInvite(invite.code, minted.user.id);
    const channelId = channels.find((c) => c.type === "text")!.id;
    return {
      minted,
      owner,
      server,
      channelId,
      token: `character:${minted.token}`,
    };
  }

  it("refuses a missing or unknown bearer", async () => {
    const owner = await person("Owner", "clerk_owner_send");
    const { channels } = await createPqpServer("QG", owner.id);
    const channelId = channels.find((c) => c.type === "text")!.id;

    expect((await send(null, channelId, { body: "oi" })).status).toBe(401);
    expect(
      (await send("totally-not-a-token", channelId, { body: "oi" })).status,
    ).toBe(401);
    await withGate(async () => {
      expect(
        (await send("character:unknown-secret", channelId, { body: "oi" }))
          .status,
      ).toBe(401);
    });
  });

  it("refuses a valid character token while the gate is off", async () => {
    const minted = await character("caio", "Caio");
    const owner = await person("Owner", "clerk_owner_gate");
    const { server, channels } = await createPqpServer("QG", owner.id);
    const invite = await createInvite(server.id, owner.id, {});
    await redeemInvite(invite.code, minted.user.id);
    const channelId = channels.find((c) => c.type === "text")!.id;

    expect(
      (await send(`character:${minted.token}`, channelId, { body: "oi" }))
        .status,
    ).toBe(401);
  });

  it("posts as the character into a channel it belongs to", async () => {
    const minted = await character("caio", "Caio");
    const owner = await person("Owner", "clerk_owner_happy");
    const { server, channels } = await createPqpServer("QG", owner.id);
    const invite = await createInvite(server.id, owner.id, {});
    await redeemInvite(invite.code, minted.user.id);
    const channelId = channels.find((c) => c.type === "text")!.id;

    await withGate(async () => {
      const posted = await send(`character:${minted.token}`, channelId, {
        body: "cheguei, como posso ajudar?",
      });
      expect(posted.status).toBe(201);
      const message = posted.body.message as {
        id: string;
        channelId: string;
        authorId: string;
        authorName: string;
        body: string;
        replyTo: unknown;
      };
      expect(message.channelId).toBe(channelId);
      expect(message.authorId).toBe(minted.user.id);
      expect(message.authorName).toBe("Caio");
      expect(message.body).toBe("cheguei, como posso ajudar?");
      expect(message.replyTo).toBeNull();

      const history = await fetch(
        `${baseUrl}/api/channels/${channelId}/messages`,
        { headers: { Authorization: `Bearer character:${minted.token}` } },
      );
      expect(history.status).toBe(200);
      const page = (await history.json()) as {
        messages: Array<{ id: string; body: string }>;
      };
      expect(page.messages.map((m) => m.id)).toContain(message.id);
      expect(page.messages.find((m) => m.id === message.id)?.body).toBe(
        "cheguei, como posso ajudar?",
      );
    });
  });

  it("replies in a thread by posting to the thread channel", async () => {
    const minted = await character("caio", "Caio");
    const owner = await person("Owner", "clerk_owner_thread");
    const { server, channels } = await createPqpServer("QG", owner.id);
    const invite = await createInvite(server.id, owner.id, {});
    await redeemInvite(invite.code, minted.user.id);
    const channelId = channels.find((c) => c.type === "text")!.id;

    const origin = await createMessage(
      channelId,
      owner,
      "o app nao abre no linux",
    );
    const started = await createThreadForMessage(origin!.id, "ajuda linux");
    const threadId = started!.thread.channelId;

    await withGate(async () => {
      const posted = await send(`character:${minted.token}`, threadId, {
        body: "abre Configurações e me manda o que aparece",
      });
      expect(posted.status).toBe(201);
      const message = posted.body.message as {
        channelId: string;
        authorId: string;
        body: string;
      };
      expect(message.channelId).toBe(threadId);
      expect(message.authorId).toBe(minted.user.id);

      const inline = await send(`character:${minted.token}`, channelId, {
        body: "vi o thread",
        replyToId: origin!.id,
      });
      expect(inline.status).toBe(201);
      const reply = inline.body.message as {
        replyTo: { id: string } | null;
      };
      expect(reply.replyTo?.id).toBe(origin!.id);
    });
  });

  it("404s when the character is not in the server", async () => {
    const minted = await character("caio", "Caio");
    const owner = await person("Owner", "clerk_owner_out");
    const { channels } = await createPqpServer("QG", owner.id);
    const channelId = channels.find((c) => c.type === "text")!.id;

    await withGate(async () => {
      const posted = await send(`character:${minted.token}`, channelId, {
        body: "nao deveria postar",
      });
      expect(posted.status).toBe(404);
    });
  });

  it("403s when the character cannot send in that channel", async () => {
    const minted = await character("caio", "Caio");
    const owner = await person("Owner", "clerk_owner_deny");
    const { server, channels } = await createPqpServer("QG", owner.id);
    const invite = await createInvite(server.id, owner.id, {});
    await redeemInvite(invite.code, minted.user.id);
    const channelId = channels.find((c) => c.type === "text")!.id;
    const roles = await listRoles(server.id);
    const everyone = roles.find((role) => role.is_everyone)!;
    await upsertChannelOverwrite(
      channelId,
      server.id,
      "role",
      everyone.id,
      0n,
      Permission.SEND_MESSAGES,
    );

    await withGate(async () => {
      const posted = await send(`character:${minted.token}`, channelId, {
        body: "silenciado",
      });
      expect(posted.status).toBe(403);
    });
  });

  it("does not enqueue an outgoing webhook for the character's own send", async () => {
    const minted = await character("caio", "Caio");
    const owner = await person("Owner", "clerk_owner_hook");
    const { server, channels } = await createPqpServer("QG", owner.id);
    const invite = await createInvite(server.id, owner.id, {});
    await redeemInvite(invite.code, minted.user.id);
    const channelId = channels.find((c) => c.type === "text")!.id;

    await getPool().query(
      `INSERT INTO outgoing_webhooks (
         server_id, name, url, channel_ids, skip_user_ids, signing_secret, created_by
       ) VALUES ($1, 'caio-wake', 'http://127.0.0.1:9/hook', ARRAY[$2]::uuid[], '{}', 'whsec_test', $3)`,
      [server.id, channelId, owner.id],
    );

    await withGate(async () => {
      const posted = await send(`character:${minted.token}`, channelId, {
        body: "resposta do caio",
      });
      expect(posted.status).toBe(201);
    });

    const afterCharacter = await getPool().query(
      `SELECT 1 FROM outgoing_webhook_deliveries`,
    );
    expect(afterCharacter.rowCount).toBe(0);

    const human = await postChannelMessage({
      author: owner,
      channelId,
      body: "oi do dono",
    });
    expect(human.ok).toBe(true);

    const afterHuman = await getPool().query(
      `SELECT 1 FROM outgoing_webhook_deliveries`,
    );
    expect(afterHuman.rowCount).toBe(1);
  });

  it("404s when the channel id does not exist", async () => {
    const { token } = await seated("clerk_owner_missing_channel");

    await withGate(async () => {
      const posted = await send(
        token,
        "00000000-0000-4000-8000-000000000099",
        { body: "oi" },
      );
      expect(posted.status).toBe(404);
    });
  });

  it("400s an empty or non-JSON body", async () => {
    const { token, channelId } = await seated("clerk_owner_bad_body");

    await withGate(async () => {
      expect((await send(token, channelId, { body: "" })).status).toBe(400);
      expect((await send(token, channelId, {})).status).toBe(400);

      const raw = await fetch(`${baseUrl}/api/channels/${channelId}/messages`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: "not-json",
      });
      expect(raw.status).toBe(400);
    });
  });

  it("400s a replyToId from another channel and posts plain on a missing parent", async () => {
    const { owner, channelId, token } = await seated("clerk_owner_reply");
    const other = await createPqpServer("Outro", owner.id);
    const foreignChannel = other.channels.find((c) => c.type === "text")!.id;
    const foreign = await createMessage(foreignChannel, owner, "segredo");

    await withGate(async () => {
      const crossed = await send(token, channelId, {
        body: "vi",
        replyToId: foreign!.id,
      });
      expect(crossed.status).toBe(400);

      // A parent that is simply gone is an ordinary race, not a bad request.
      const orphan = await send(token, channelId, {
        body: "vi",
        replyToId: "00000000-0000-4000-8000-000000000001",
      });
      expect(orphan.status).toBe(201);
      expect((orphan.body.message as { replyTo: unknown }).replyTo).toBeNull();
    });
  });

  it("403s a character sending into a conversation, even when seated in it", async () => {
    const { minted, owner, token } = await seated("clerk_owner_dm");
    const friend = await person("Friend", "clerk_friend_dm");
    await getPool().query(
      `UPDATE users SET dm_privacy = 'everyone' WHERE id IN ($1, $2)`,
      [owner.id, friend.id],
    );
    const conversation = await openConversation(owner.id, [friend.id]);
    // The API never puts a character here; this is the backstop for a row
    // that got there some other way.
    await getPool().query(
      `INSERT INTO channel_members (channel_id, user_id) VALUES ($1, $2)`,
      [conversation.channelId, minted.user.id],
    );

    await withGate(async () => {
      const posted = await send(token, conversation.channelId, { body: "oi" });
      expect(posted.status).toBe(403);
    });
  });

  it("429s with Retry-After when slow mode holds the character", async () => {
    const { channelId, token } = await seated("clerk_owner_slow");
    await getPool().query(
      `UPDATE channels SET slowmode_seconds = 30 WHERE id = $1`,
      [channelId],
    );

    await withGate(async () => {
      expect((await send(token, channelId, { body: "1" })).status).toBe(201);
      const held = await send(token, channelId, { body: "2" });
      expect(held.status).toBe(429);
      expect(Number(held.retryAfter)).toBeGreaterThan(0);
    });
  });

  it("does not spend the slow-mode token on a foreign replyToId", async () => {
    const { owner, channelId, token } = await seated("clerk_owner_slow_reply");
    await getPool().query(
      `UPDATE channels SET slowmode_seconds = 30 WHERE id = $1`,
      [channelId],
    );
    const other = await createPqpServer("Outro", owner.id);
    const foreignChannel = other.channels.find((c) => c.type === "text")!.id;
    const foreign = await createMessage(foreignChannel, owner, "segredo");

    await withGate(async () => {
      const crossed = await send(token, channelId, {
        body: "vi",
        replyToId: foreign!.id,
      });
      expect(crossed.status).toBe(400);

      const plain = await send(token, channelId, { body: "oi" });
      expect(plain.status).toBe(201);
    });
  });

  it("charges the same send budget the socket does", async () => {
    const { channelId, token } = await seated("clerk_owner_budget");

    await withGate(async () => {
      // RATE_LIMIT_WS_MESSAGE_CAPACITY defaults to 10; writeLimiter alone
      // would have let 30 through. Fire the burst together so a slow
      // sequential loop cannot refill (2/s) before the eleventh lands.
      const results = await Promise.all(
        Array.from({ length: 11 }, (_, i) =>
          send(token, channelId, { body: `${i}` }),
        ),
      );
      expect(results.filter((result) => result.status === 201)).toHaveLength(10);
      const limited = results.filter((result) => result.status === 429);
      expect(limited).toHaveLength(1);
      expect(limited[0]?.retryAfter).toBe("1");
    });
  });

  it("403s a character that is timed out in the server", async () => {
    const { minted, owner, server, channelId, token } = await seated(
      "clerk_owner_timeout",
    );
    await issueTimeout({
      serverId: server.id,
      userId: minted.user.id,
      issuedBy: owner.id,
      minutes: 10,
    });

    await withGate(async () => {
      const posted = await send(token, channelId, { body: "silenciado" });
      expect(posted.status).toBe(403);
    });
  });

  it("401s a revoked token on the very next request", async () => {
    const { channelId, token } = await seated("clerk_owner_revoke");

    await withGate(async () => {
      expect((await send(token, channelId, { body: "ok" })).status).toBe(201);
      await revokeCharacterAccount("caio");
      expect((await send(token, channelId, { body: "gone" })).status).toBe(401);
    });
  });

  it("leaves unread and a mention for the person it tagged", async () => {
    const { owner, server, channelId, token } = await seated(
      "clerk_owner_unread",
    );

    await withGate(async () => {
      const posted = await send(token, channelId, {
        body: `oi @${owner.username}#${owner.discriminator}`,
      });
      expect(posted.status).toBe(201);
    });

    const unread = await listUnread(server.id, owner.id);
    const row = unread.find((entry) => entry.channelId === channelId);
    expect(row?.count).toBe(1);
    expect(row?.mentions).toBe(1);
  });

  it("stores @everyone as plain text when the character may not ping everyone", async () => {
    const { channelId, token } = await seated("clerk_owner_everyone");

    const posted = await withGate(() =>
      send(token, channelId, { body: "@everyone acorda" }),
    );
    expect(posted.status).toBe(201);
    const row = await getPool().query<{ mention_everyone: boolean }>(
      `SELECT mention_everyone FROM messages WHERE id = $1`,
      [(posted.body.message as { id: string }).id],
    );
    expect(row.rows[0]?.mention_everyone).toBe(false);
  });
});

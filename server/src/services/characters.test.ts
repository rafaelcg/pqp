import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

/**
 * Character accounts, pinned at the layer that decides whether a request is an
 * identity at all.
 *
 * This is auth code, so what is under test is mostly the NEGATIVE space: the
 * branch is unreachable without the env gate, an unknown token is not an
 * identity, a hand-edited `token_hash` is not an identity, and a revoked
 * account is not an identity. Those four are the whole security story of a
 * long-lived bearer token in `verifyAuthHeader`, and none of them is visible
 * from a passing happy path.
 *
 * The rest pins the properties a character has to have *because* nobody is
 * behind it: it clears the age gate at creation (or its socket closes 4401 and
 * nothing ever says why), it cannot be friended, it cannot be in anybody's DMs
 * in either direction, it cannot delete or export itself, and it is invisible
 * to discovery outside the servers it is already in.
 *
 * Real Postgres, real router, real `verifyAuthHeader` — nothing here is mocked,
 * because every one of those properties is a join, a constraint or a branch
 * that a mock would assert away.
 */

// TEST_DATABASE_URL wins — see the note in api.test.ts.
const DATABASE_URL = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
const describeDb = DATABASE_URL ? describe : describe.skip;

if (DATABASE_URL) {
  process.env.DATABASE_URL = DATABASE_URL;
}

const { getPool, initDb, closePool } = await import("../db.js");
const { upsertUser, findUserByTag, searchUsersByPrefix } = await import(
  "./users.js"
);
const {
  createCharacterAccount,
  getCharacterAccountByLabel,
  hashCharacterToken,
  isCharacterAccountsEnabled,
  listCharacterAccounts,
  mintCharacterToken,
  resolveCharacterToken,
  revokeCharacterAccount,
  rotateCharacterToken,
} = await import("./characters.js");
const { verifyAuthHeader, resolveAuthSession, clearAuthCaches } = await import(
  "../auth/clerk.js"
);
const { sendFriendRequest, FriendRequestRefusedError } = await import(
  "./friends.js"
);
const { openConversation, DmRefusedError } = await import("./dms.js");
const { createServer: createPqpServer } = await import("./servers.js");
const { createInvite, redeemInvite } = await import("./invites.js");
const { handleApi } = await import("../api/index.js");

/** Turn the gate on for the body of a test, and off again however it ends. */
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

describeDb("character accounts", () => {
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
    await getPool().query(
      `TRUNCATE users, user_preferences, servers, channels, messages,
                server_members, channel_members, server_invites, character_accounts,
                friendships, user_blocks, dm_pairs
       RESTART IDENTITY CASCADE`,
    );
  });

  const person = (name: string, clerkId: string) =>
    upsertUser({ clerkId, displayName: name, avatarUrl: null });

  const character = (label: string, displayName = label) =>
    createCharacterAccount({ label, displayName, createdBy: "test" });

  // ------------------------------------------------------------- the gate

  it("is off unless the environment says the word", async () => {
    expect(isCharacterAccountsEnabled()).toBe(false);
    process.env.CHARACTER_ACCOUNTS_ENABLED = "1";
    expect(isCharacterAccountsEnabled()).toBe(false);
    process.env.CHARACTER_ACCOUNTS_ENABLED = "TRUE";
    expect(isCharacterAccountsEnabled()).toBe(false);
    process.env.CHARACTER_ACCOUNTS_ENABLED = "true";
    expect(isCharacterAccountsEnabled()).toBe(true);
  });

  it("refuses a perfectly valid token while the gate is off", async () => {
    const { token } = await character("cacau", "Cacau Ribeiro");
    // The credential is real and the account is live. The only thing missing is
    // the deploy's consent, and that has to be enough on its own.
    expect(await resolveCharacterToken(token)).toBeNull();
    expect(await verifyAuthHeader(`Bearer character:${token}`)).toBeNull();
  });

  it("authenticates the account the token belongs to when the gate is on", async () => {
    const minted = await character("cacau", "Cacau Ribeiro");
    await withGate(async () => {
      const identity = await resolveCharacterToken(minted.token);
      expect(identity?.userId).toBe(minted.user.id);
      expect(identity?.label).toBe("cacau");

      const auth = await verifyAuthHeader(`Bearer character:${minted.token}`);
      expect(auth?.clerkId).toBe(minted.user.clerk_id);
      expect(auth?.displayName).toBe("Cacau Ribeiro");
      // A character proves no email address, so it can never be handed an SSO
      // domain join — the column is overwritten with the empty set on every
      // request, not merely left alone.
      expect(auth?.emailDomains).toEqual([]);
    });
  });

  // ---------------------------------------------------------- bad credentials

  it("refuses a token that was never minted", async () => {
    await character("nando", "Nando Aquino");
    await withGate(async () => {
      expect(await resolveCharacterToken(mintCharacterToken())).toBeNull();
      expect(await resolveCharacterToken("")).toBeNull();
      expect(
        await verifyAuthHeader(`Bearer character:${mintCharacterToken()}`),
      ).toBeNull();
    });
  });

  it("refuses a token whose hash was tampered with in the database", async () => {
    const minted = await character("duda", "Duda Belmonte");
    await withGate(async () => {
      expect(await resolveCharacterToken(minted.token)).not.toBeNull();

      // Somebody with write access edits the row to point at a secret they
      // control. The stored digest and the presented one now disagree, and the
      // constant-time compare is what turns that into "not an identity" rather
      // than "whoever this row names".
      const attacker = "attacker-chosen-secret";
      await getPool().query(
        `UPDATE character_accounts SET token_hash = $1 WHERE label = 'duda'`,
        [`${hashCharacterToken(attacker)}-tampered`],
      );
      expect(await resolveCharacterToken(minted.token)).toBeNull();
      expect(await resolveCharacterToken(attacker)).toBeNull();
    });
  });

  it("stores only the hash — the token is never readable again", async () => {
    const minted = await character("talita", "Talita Nunes");
    const row = await getPool().query<Record<string, unknown>>(
      `SELECT * FROM character_accounts WHERE label = 'talita'`,
    );
    const stored = JSON.stringify(row.rows[0]);
    expect(stored).not.toContain(minted.token);
    expect(stored).toContain(hashCharacterToken(minted.token));
  });

  it("stops answering the moment the account is revoked, and starts again on rotate", async () => {
    const minted = await character("ivo", "Seu Ivo");
    await withGate(async () => {
      expect(await resolveCharacterToken(minted.token)).not.toBeNull();

      await revokeCharacterAccount("ivo");
      expect(await resolveCharacterToken(minted.token)).toBeNull();

      const rotated = await rotateCharacterToken("ivo");
      expect(rotated).not.toBeNull();
      // The old secret stays dead; the account — its id, its handle, its
      // memberships — is the same row it always was.
      expect(await resolveCharacterToken(minted.token)).toBeNull();
      const identity = await resolveCharacterToken(rotated!.token);
      expect(identity?.userId).toBe(minted.user.id);
    });
  });

  it("keeps the label unique so provisioning is idempotent", async () => {
    await character("kzin");
    await expect(character("kzin")).rejects.toThrow();
    expect((await listCharacterAccounts()).length).toBe(1);
    expect((await getCharacterAccountByLabel("kzin"))?.label).toBe("kzin");
  });

  // ------------------------------------------------------------- the age gate

  it("clears the age gate at creation, so a character is a session on its first request", async () => {
    const minted = await character("lele", "Lelê Andrade");
    const row = await getPool().query<{
      age_checked_at: Date | null;
      age_check_passed: boolean | null;
      age_check_dob: Date | null;
      dm_privacy: string;
      is_character: boolean;
    }>(
      `SELECT age_checked_at, age_check_passed, age_check_dob, dm_privacy, is_character
         FROM users WHERE id = $1`,
      [minted.user.id],
    );
    const stored = row.rows[0]!;
    expect(stored.age_checked_at).not.toBeNull();
    expect(stored.age_check_passed).toBe(true);
    // A pass stores no date — same as a person who cleared the gate.
    expect(stored.age_check_dob).toBeNull();
    expect(stored.dm_privacy).toBe("nobody");
    expect(stored.is_character).toBe(true);

    // The property that actually matters: the full session resolver, which is
    // what the WebSocket handshake calls, answers "passed" without the account
    // ever having declared anything.
    await withGate(async () => {
      const session = await resolveAuthSession(
        `Bearer character:${minted.token}`,
      );
      expect(session?.ageGate).toBe("passed");
      expect(session?.user.id).toBe(minted.user.id);
    });
  });

  it("marks onboarding done, so no first-run modal waits for a browser that never comes", async () => {
    const minted = await character("otavio", "Otávio Prado");
    const prefs = await getPool().query<{ settings: { onboardedAt?: string } }>(
      `SELECT settings FROM user_preferences WHERE user_id = $1`,
      [minted.user.id],
    );
    expect(prefs.rows[0]?.settings.onboardedAt).toBeTruthy();
  });

  // ---------------------------------------------------------- what it cannot do

  it("cannot be friended, and cannot friend anybody", async () => {
    const human = await person("Human", "clerk_human_friend");
    const cast = await character("sam", "Sam");

    await expect(sendFriendRequest(human.id, cast.user.id)).rejects.toThrow(
      FriendRequestRefusedError,
    );
    await expect(sendFriendRequest(cast.user.id, human.id)).rejects.toThrow(
      FriendRequestRefusedError,
    );
    // Nothing was written — a refusal must not leave a row somebody can see.
    const rows = await getPool().query(`SELECT 1 FROM friendships`);
    expect(rows.rowCount).toBe(0);
  });

  it("is not reachable by DM, and cannot open one", async () => {
    const human = await person("Human", "clerk_human_dm");
    const cast = await character("cris", "Cris Bonfim");

    // Incoming: refused by `dm_privacy = 'nobody'`, written at creation.
    await expect(openConversation(human.id, [cast.user.id])).rejects.toThrow(
      DmRefusedError,
    );
    // Outgoing: refused because the actor is a character, regardless of what
    // the recipient's privacy setting says.
    await getPool().query(
      `UPDATE users SET dm_privacy = 'everyone' WHERE id = $1`,
      [human.id],
    );
    await expect(openConversation(cast.user.id, [human.id])).rejects.toThrow(
      DmRefusedError,
    );
  });

  it("cannot delete or export itself through the API, but can read its own profile", async () => {
    const minted = await character("rique", "Rique");
    await withGate(async () => {
      const auth = { Authorization: `Bearer character:${minted.token}` };

      const me = await fetch(`${baseUrl}/api/me`, { headers: auth });
      expect(me.status).toBe(200);

      const exported = await fetch(`${baseUrl}/api/me/export`, {
        headers: auth,
      });
      expect(exported.status).toBe(403);

      // A character joins communities; it never owns one. Ownership carries
      // invites, bans, retention and the audit log, which is the one durable
      // public artifact a leaked token must not be able to create.
      const server = await fetch(`${baseUrl}/api/servers`, {
        method: "POST",
        headers: { ...auth, "Content-Type": "application/json" },
        body: JSON.stringify({ name: "Servidor do Personagem" }),
      });
      expect(server.status).toBe(403);

      const deleted = await fetch(`${baseUrl}/api/me`, {
        method: "DELETE",
        headers: { ...auth, "Content-Type": "application/json" },
        body: JSON.stringify({ confirm: "whatever" }),
      });
      expect(deleted.status).toBe(403);

      // Still there.
      const row = await getPool().query(`SELECT 1 FROM users WHERE id = $1`, [
        minted.user.id,
      ]);
      expect(row.rowCount).toBe(1);
    });
  });

  // ------------------------------------------------------------- discoverability

  it("is invisible to discovery until you share a server with it", async () => {
    const stranger = await person("Stranger", "clerk_stranger");
    const owner = await person("Owner", "clerk_owner_cast");
    const cast = await character("pandinha", "Pandinha");
    const tag = {
      username: cast.user.username!,
      discriminator: cast.user.discriminator!,
    };

    // Outside: neither prefix search nor an exact handle finds it.
    expect(
      await searchUsersByPrefix(tag.username.slice(0, 3), stranger.id),
    ).toEqual([]);
    expect(
      await findUserByTag(tag.username, tag.discriminator, stranger.id),
    ).toBeNull();

    // Inside: an ordinary member of the same server sees an ordinary account.
    const { server } = await createPqpServer("Resenha FC", owner.id);
    const invite = await createInvite(server.id, owner.id, {});
    await redeemInvite(invite.code, cast.user.id);
    await redeemInvite(invite.code, stranger.id);

    const found = await findUserByTag(
      tag.username,
      tag.discriminator,
      stranger.id,
    );
    expect(found?.id).toBe(cast.user.id);
    expect(
      (await searchUsersByPrefix(tag.username.slice(0, 3), stranger.id)).map(
        (u) => u.id,
      ),
    ).toContain(cast.user.id);
  });

  it("never hides an ordinary account from discovery", async () => {
    const viewer = await person("Viewer", "clerk_viewer");
    const other = await person("Findable", "clerk_findable");
    expect(
      await findUserByTag(other.username!, other.discriminator!, viewer.id),
    ).not.toBeNull();
    expect(
      (await searchUsersByPrefix("findable", viewer.id)).map((u) => u.id),
    ).toContain(other.id);
  });

  // --------------------------------------------------------------- invariants

  it("refuses a row that claims to be both a character and a webhook", async () => {
    const minted = await character("jhow", "Jhow");
    await expect(
      getPool().query(`UPDATE users SET is_webhook = TRUE WHERE id = $1`, [
        minted.user.id,
      ]),
    ).rejects.toThrow(/users_pseudo_identity_exclusive/);
  });
});

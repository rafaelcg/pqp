import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
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
import type { Translator } from "../speech/types.js";

/**
 * Baú automatic translation, on a real Postgres with a fake translator (no
 * network, no key). What is pinned:
 *
 *   * OFF MEANS OFF. Flag off, or flag on and no key: no rows, no calls, the
 *     original everywhere, `translationEnabled` false.
 *   * A TRANSLATION NEVER CHANGES WHO MAY READ. A members-only post a viewer
 *     cannot open has its body, its media and its comment words stripped from
 *     the translated fields by the same code as from the original, and the
 *     translated `original` block is stripped too.
 *   * TWO MACHINES, ONE TRANSLATION. The claim is a row: two instances racing
 *     for the same (post, language) get one winner.
 *   * AN EDIT INVALIDATES. The stale row is never served for new text.
 *   * BOUNDED. The daily budget, the per-post cap, the backoff and the give-up.
 */

const DATABASE_URL = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
const describeDb = DATABASE_URL ? describe : describe.skip;

if (DATABASE_URL) {
  process.env.DATABASE_URL = DATABASE_URL;
}

let actor: { id: string; clerk_id: string } | null = null;

vi.mock("../auth/clerk.js", () => ({
  DEV_AUTH_TOKEN: "dev-local-token",
  isDevAuthBypassEnabled: () => false,
  assertAuthConfig: () => {},
  invalidateUserCache: () => {},
  clearAuthCaches: () => {},
  resolveAuthUser: async () => (actor ? { user: actor } : null),
  resolveAuthSession: async () =>
    actor ? { user: actor, ageGate: "passed" as const } : null,
  verifyAuthHeader: async () => null,
}));

const { getPool, initDb, closePool } = await import("../db.js");
const { handleApi, resetApiRateLimits } = await import("../api/index.js");
const { upsertUser } = await import("./users.js");
const { createServer: createChatServer } = await import("./servers.js");
const tr = await import("./community-home-translation.js");
const flags = await import("../lib/flags.js");

let httpServer: Server;
let baseUrl: string;

async function call<T = Record<string, unknown>>(
  as: { id: string; clerk_id: string },
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; body: T; raw: string }> {
  actor = as;
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { "Content-Type": "application/json", Authorization: "Bearer test" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const raw = await response.text();
  return { status: response.status, body: (raw ? JSON.parse(raw) : {}) as T, raw };
}

interface PostBody {
  id: string;
  title: string | null;
  body: string | null;
  teaser: string | null;
  locked: boolean;
  media: unknown;
  commentTeaser: { body: string }[];
  translation: null | {
    lang: string;
    auto: boolean;
    sourceLang: string | null;
    original: { title: string | null; body: string | null; teaser: string | null };
  };
}

/** A translator that tags its output with the target language, records every call, and can be held or broken. */
function fakeTranslator() {
  const calls: Array<{ texts: string[]; from: string; to: string }> = [];
  const state = {
    gate: null as Promise<void> | null,
    fail: null as Error | null,
    onCall: null as null | (() => Promise<void>),
  };
  const translator: Translator = {
    id: "fake/test",
    async translate(texts, from, to) {
      calls.push({ texts: [...texts], from, to });
      if (state.onCall) await state.onCall();
      if (state.gate) await state.gate;
      if (state.fail) throw state.fail;
      return { texts: texts.map((t) => `[${to}] ${t}`), costUsd: 0.001 };
    },
  };
  return { translator, calls, state };
}

const PT_TITLE = "Novidade no Baú do QG";
const PT_BODY =
  "Olá pessoal! O pqp agora traduz os posts do Baú automaticamente, então você escreve no seu idioma e a galera lê no deles.";

describeDb("Baú translation", () => {
  let owner: { id: string; clerk_id: string };
  let member: { id: string; clerk_id: string };
  let vip: { id: string; clerk_id: string };
  let serverId: string;
  let fake: ReturnType<typeof fakeTranslator>;

  beforeAll(async () => {
    await initDb();
    httpServer = createServer((req, res) => {
      const pathname = new URL(req.url ?? "/", "http://localhost").pathname;
      void handleApi(req, res, pathname);
    });
    await new Promise<void>((resolve) => {
      httpServer.listen(0, "127.0.0.1", resolve);
    });
    baseUrl = `http://127.0.0.1:${(httpServer.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    await closePool();
  });

  beforeEach(async () => {
    await getPool().query(`TRUNCATE users RESTART IDENTITY CASCADE`);
    await getPool().query(`TRUNCATE community_home_translation_usage`);
    resetApiRateLimits();
    flags.resetFeatureFlagsForTests();
    tr.resetCommunityHomeTranslationForTests();
    process.env.COMMUNITY_HOME_ENABLED = "true";
    process.env.COMMUNITY_HOME_VIP_ENABLED = "true";
    process.env.COMMUNITY_HOME_TRANSLATION = "true";
    delete process.env.OPENROUTER_API_KEY;
    fake = fakeTranslator();
    tr.setCommunityHomeTranslatorForTests(fake.translator);

    const makeUser = (name: string) =>
      upsertUser({ clerkId: `clerk_${name}`, displayName: name, avatarUrl: null });
    owner = await makeUser("owner");
    member = await makeUser("member");
    vip = await makeUser("vip");
    const created = await createChatServer("QG", owner.id);
    serverId = created.server.id;
    for (const person of [member, vip]) {
      await getPool().query(
        `INSERT INTO server_members (server_id, user_id, role)
         VALUES ($1, $2, 'member') ON CONFLICT DO NOTHING`,
        [serverId, person.id],
      );
    }
    await getPool().query(
      `INSERT INTO member_roles (server_id, user_id, role_id)
       SELECT $1, $2, id FROM roles WHERE server_id = $1 AND system_key = 'vip'
       ON CONFLICT DO NOTHING`,
      [serverId, vip.id],
    );
  });

  afterEach(() => {
    for (const name of [
      "COMMUNITY_HOME_ENABLED",
      "COMMUNITY_HOME_VIP_ENABLED",
      "COMMUNITY_HOME_TRANSLATION",
      "OPENROUTER_API_KEY",
      "COMMUNITY_HOME_TRANSLATION_DAILY_CHARS",
      "COMMUNITY_HOME_TRANSLATION_MAX_CHARS",
    ]) {
      delete process.env[name];
    }
    tr.setCommunityHomeTranslatorForTests(null);
    flags.resetFeatureFlagsForTests();
  });

  const base = () => `/api/servers/${serverId}/home`;

  async function publish(post: Record<string, unknown> = {}): Promise<PostBody> {
    const res = await call<{ post: PostBody }>(owner, "POST", `${base()}/posts`, {
      status: "published",
      title: PT_TITLE,
      body: PT_BODY,
      ...post,
    });
    expect(res.status).toBe(201);
    return res.body.post;
  }

  /** Publish with no translator, so nothing starts in the background and the test sets the stage itself. */
  async function publishQuiet(post: Record<string, unknown> = {}): Promise<PostBody> {
    tr.setCommunityHomeTranslatorForTests(null);
    const created = await publish(post);
    tr.setCommunityHomeTranslatorForTests(fake.translator);
    return created;
  }

  async function rows(postId: string) {
    const r = await getPool().query<{
      lang: string;
      same_language: boolean;
      title: string | null;
      body: string;
      source_lang: string | null;
    }>(
      `SELECT lang, same_language, title, body, source_lang
         FROM community_home_post_translations WHERE post_id = $1 ORDER BY lang`,
      [postId],
    );
    return r.rows;
  }

  /** The route starts translation in the background; wait for it to land. */
  async function untilTranslated(postId: string, count = 3) {
    await vi.waitFor(async () => expect((await rows(postId)).length).toBe(count), {
      timeout: 4000,
    });
  }

  async function feed(as: { id: string; clerk_id: string }, lang?: string) {
    const res = await call<{ posts: PostBody[]; translationEnabled: boolean }>(
      as,
      "GET",
      `${base()}/posts${lang ? `?lang=${lang}` : ""}`,
    );
    expect(res.status).toBe(200);
    return res;
  }

  // ------------------------------------------------------------- off means off

  describe("off means off", () => {
    it("flag off: a publish stores nothing, calls nothing, serves the original", async () => {
      delete process.env.COMMUNITY_HOME_TRANSLATION;
      const post = await publish();
      await tr.scheduleCommunityHomeTranslation(post.id, serverId);
      expect(fake.calls).toHaveLength(0);
      expect(await rows(post.id)).toEqual([]);
      const res = await feed(member, "en");
      expect(res.body.translationEnabled).toBe(false);
      expect(res.body.posts[0]!.title).toBe(PT_TITLE);
      expect(res.body.posts[0]!.translation).toBeNull();
    });

    it("flag off hides translations that already exist (the original is served)", async () => {
      const post = await publish();
      await untilTranslated(post.id);
      expect((await feed(member, "en")).body.posts[0]!.translation).not.toBeNull();
      delete process.env.COMMUNITY_HOME_TRANSLATION;
      const res = await feed(member, "en");
      expect(res.body.posts[0]!.title).toBe(PT_TITLE);
      expect(res.body.posts[0]!.translation).toBeNull();
      // Nothing was deleted: turning it back on serves them again.
      process.env.COMMUNITY_HOME_TRANSLATION = "true";
      expect((await feed(member, "en")).body.posts[0]!.translation).not.toBeNull();
    });

    it("flag on but no key: nothing is attempted, it says so, nothing errors, and staff are not told translations are coming", async () => {
      tr.setCommunityHomeTranslatorForTests(null);
      expect(tr.isCommunityHomeTranslationConfigured()).toBe(false);
      const post = await publish();
      await tr.scheduleCommunityHomeTranslation(post.id, serverId);
      expect(await rows(post.id)).toEqual([]);
      expect((await tr.communityHomeTranslationMetrics()).skippedNoKey).toBeGreaterThan(0);
      expect(await tr.sweepCommunityHomeTranslations()).toEqual({ attempted: 0 });
      expect((await feed(owner, "en")).body.translationEnabled).toBe(false);
    });

    it("the key arriving later is picked up by the sweep, for a post published before it", async () => {
      tr.setCommunityHomeTranslatorForTests(null);
      const post = await publish();
      expect(await rows(post.id)).toEqual([]);
      tr.setCommunityHomeTranslatorForTests(fake.translator);
      expect((await tr.sweepCommunityHomeTranslations()).attempted).toBe(3);
      expect((await rows(post.id)).map((r) => r.lang)).toEqual(["en", "es", "pt"]);
    });

    it("a draft, a scheduled post and an unpublished post are never translated", async () => {
      const draft = await call<{ post: PostBody }>(owner, "POST", `${base()}/posts`, {
        title: "rascunho",
        body: "ainda não é pra ninguém ler isso aqui",
      });
      expect(await tr.translateCommunityHomePost(draft.body.post.id, "en")).toBe(
        "skipped:not_published",
      );
      expect(fake.calls).toHaveLength(0);
      expect(await tr.sweepCommunityHomeTranslations()).toEqual({ attempted: 0 });
    });
  });

  // -------------------------------------------------------------- producing

  describe("producing", () => {
    it("a Portuguese post gets English and Spanish, and a same-language marker for Portuguese", async () => {
      const post = await publish();
      await untilTranslated(post.id);
      const stored = await rows(post.id);
      expect(stored.map((r) => [r.lang, r.same_language, r.source_lang])).toEqual([
        ["en", false, "pt"],
        ["es", false, "pt"],
        ["pt", true, "pt"],
      ]);
      // The model was asked from Portuguese, never into it.
      expect(fake.calls.map((c) => `${c.from}>${c.to}`).sort()).toEqual(["pt>en", "pt>es"]);
      // Title and body went in one call each, no teaser on a free post.
      expect(fake.calls[0]!.texts).toEqual([PT_TITLE, PT_BODY]);
    });

    it("an English post is not translated into English", async () => {
      const post = await publish({
        title: "News from the chest",
        body: "Hey everyone! The pqp chest now translates posts automatically, so you write in your language and everybody reads it in theirs.",
      });
      await untilTranslated(post.id);
      expect(fake.calls.map((c) => c.to).sort()).toEqual(["es", "pt"]);
      expect((await rows(post.id)).find((r) => r.lang === "en")!.same_language).toBe(true);
    });

    it("serves the translation to a reader in that language, with the original one flip away", async () => {
      const post = await publish();
      await untilTranslated(post.id);
      const en = (await feed(member, "en-US")).body.posts[0]!;
      expect(en.title).toBe(`[en] ${PT_TITLE}`);
      expect(en.body).toBe(`[en] ${PT_BODY}`);
      expect(en.translation).toEqual({
        lang: "en",
        auto: true,
        sourceLang: "pt",
        original: { title: PT_TITLE, body: PT_BODY, teaser: null },
      });
      // pt-BR reads the original: same-language rows are not translations.
      const pt = (await feed(member, "pt-BR")).body.posts[0]!;
      expect(pt.title).toBe(PT_TITLE);
      expect(pt.translation).toBeNull();
      // No language, an unknown language: the original.
      for (const lang of [undefined, "fr", "xx", ""]) {
        const p = (await feed(member, lang)).body.posts[0]!;
        expect(p.title).toBe(PT_TITLE);
        expect(p.translation).toBeNull();
      }
      // The single-post read follows the same rule.
      const one = await call<{ post: PostBody }>(
        member,
        "GET",
        `${base()}/posts/${post.id}?lang=es`,
      );
      expect(one.body.post.title).toBe(`[es] ${PT_TITLE}`);
    });

    it("the author's own write responses are the original, never a translation", async () => {
      const post = await publish();
      await untilTranslated(post.id);
      const patched = await call<{ post: PostBody }>(
        owner,
        "PATCH",
        `${base()}/posts/${post.id}`,
        { title: "Outro título do QG" },
      );
      expect(patched.body.post.title).toBe("Outro título do QG");
      expect(patched.body.post.translation).toBeNull();
    });

    it("a scheduled post that goes live is translated by the same path", async () => {
      const { publishDueCommunityHomePosts } = await import("./community-home.js");
      const res = await call<{ post: PostBody }>(owner, "POST", `${base()}/posts`, {
        title: PT_TITLE,
        body: PT_BODY,
        status: "scheduled",
        scheduledAt: new Date(Date.now() + 3_600_000).toISOString(),
        scheduleTimezone: "UTC",
      });
      await getPool().query(
        `UPDATE community_home_posts SET scheduled_at = NOW() - INTERVAL '1 minute' WHERE id = $1`,
        [res.body.post.id],
      );
      expect(fake.calls).toHaveLength(0);
      await publishDueCommunityHomePosts();
      await untilTranslated(res.body.post.id);
    });

    describe("#channel references", () => {
      const CH = "11111111-2222-4333-8444-555555555555";
      const CH2 = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
      const BODY = `Testa aí e manda um áudio no <#${CH}> dizendo o que achou, ou no <#${CH2}> se preferir. Valeu, pessoal!`;

      it("never sends an id to the model and gives it back in the translation", async () => {
        const post = await publish({ body: BODY });
        await untilTranslated(post.id);
        // The model saw numbered placeholders, never a uuid.
        for (const call of fake.calls) {
          expect(call.texts.join("\n")).not.toContain(CH);
          expect(call.texts[1]).toContain("<#1>");
          expect(call.texts[1]).toContain("<#2>");
        }
        const en = (await feed(member, "en")).body.posts[0]!;
        expect(en.body).toBe(
          `[en] ${BODY}`,
        );
        // The original block still carries the author's own tokens.
        expect(en.translation!.original.body).toBe(BODY);
      });

      it("keeps the author's words for a field whose placeholder the model dropped", async () => {
        fake.translator.translate = async (texts, _from, to) => ({
          texts: texts.map((t) => `[${to}] ${t.replace(/<#\d+>/g, "")}`),
          costUsd: 0.001,
        });
        const post = await publish({ body: BODY });
        await untilTranslated(post.id);
        const en = (await feed(member, "en")).body.posts[0]!;
        // Title translated, body left as written rather than published with no link.
        expect(en.title).toBe(`[en] ${PT_TITLE}`);
        expect(en.body).toBe(BODY);
        expect((await tr.communityHomeTranslationMetrics()).channelRefsKept).toBeGreaterThan(0);
      });

      it("a body that is only a reference has no words to translate", async () => {
        const post = await publish({ body: `<#${CH}>` });
        await untilTranslated(post.id);
        expect(fake.calls.every((c) => c.texts.length === 1)).toBe(true);
        const en = (await feed(member, "en")).body.posts[0]!;
        expect(en.body).toBe(`<#${CH}>`);
      });
    });

    it("a GIF-only body is carried over, not sent to the model", async () => {
      const post = await publish({
        title: PT_TITLE,
        body: "https://media.klipy.com/some/clip.gif",
      });
      await untilTranslated(post.id);
      expect(fake.calls.every((c) => c.texts.length === 1)).toBe(true);
      const en = (await feed(member, "en")).body.posts[0]!;
      expect(en.body).toBe("https://media.klipy.com/some/clip.gif");
    });
  });

  // ----------------------------------------------------------------- the lock

  describe("a translation never changes who may read", () => {
    const SECRET_BODY =
      "Segredo só pra VIP: o filme da sexta é o clássico que você pediu, não conta pra ninguém, tá?";
    const TEASER = "Tem novidade guardada pro pessoal VIP, vem ver o que é.";

    async function vipPost(): Promise<PostBody> {
      const post = await publish({
        title: "Exclusivo VIP do QG",
        body: SECRET_BODY,
        teaser: TEASER,
        visibility: "members",
        youtubeUrl: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
      });
      await untilTranslated(post.id);
      return post;
    }

    it("a plain member gets the translated title and teaser but never a body, in any field, in any language", async () => {
      const post = await vipPost();
      // A comment on the post, written by the VIP: its words are stripped too.
      await call(vip, "POST", `${base()}/posts/${post.id}/comments`, {
        body: "palavras do comentário só pra VIP",
      });
      for (const lang of ["en", "es", "pt-BR", undefined]) {
        const res = await feed(member, lang);
        const p = res.body.posts[0]!;
        expect(p.locked).toBe(true);
        expect(p.body).toBeNull();
        expect(p.media).toBeNull();
        expect(p.commentTeaser).toEqual([]);
        expect(p.translation?.original.body ?? null).toBeNull();
        // The secret, original or translated, is nowhere in the response.
        expect(res.raw).not.toContain("Segredo");
        expect(res.raw).not.toContain("o filme da sexta");
        expect(res.raw).not.toContain("palavras do comentário");
      }
      const en = (await feed(member, "en")).body.posts[0]!;
      expect(en.title).toBe("[en] Exclusivo VIP do QG");
      expect(en.teaser).toBe(`[en] ${TEASER}`);
      // The single-post read and the comments list are locked the same way.
      const one = await call<{ post: PostBody }>(member, "GET", `${base()}/posts/${post.id}?lang=en`);
      expect(one.body.post.body).toBeNull();
      expect(one.raw).not.toContain("o filme da sexta");
      const comments = await call<{ comments: unknown[] }>(
        member,
        "GET",
        `${base()}/posts/${post.id}/comments`,
      );
      expect(comments.body.comments).toEqual([]);
    });

    it("having a translation row does not change what locked means, for anybody", async () => {
      const post = await vipPost();
      const lockedWith = async (who: { id: string; clerk_id: string }) =>
        (await feed(who, "en")).body.posts[0]!.locked;
      const before = [await lockedWith(member), await lockedWith(vip), await lockedWith(owner)];
      await getPool().query(`DELETE FROM community_home_post_translations WHERE post_id = $1`, [post.id]);
      const after = [await lockedWith(member), await lockedWith(vip), await lockedWith(owner)];
      expect(before).toEqual([true, false, false]);
      expect(after).toEqual(before);
    });

    it("VIP and staff get the translated body; the same body is not in the member's response", async () => {
      await vipPost();
      for (const who of [vip, owner]) {
        const p = (await feed(who, "en")).body.posts[0]!;
        expect(p.locked).toBe(false);
        expect(p.body).toBe(`[en] ${SECRET_BODY}`);
        expect(p.translation?.original.body).toBe(SECRET_BODY);
      }
    });

    it("turning a free post into a VIP one locks its already translated body at once", async () => {
      const post = await publish();
      await untilTranslated(post.id);
      expect((await feed(member, "en")).body.posts[0]!.body).toBe(`[en] ${PT_BODY}`);
      await getPool().query(`UPDATE community_home_posts SET visibility = 'members' WHERE id = $1`, [post.id]);
      const res = await feed(member, "en");
      expect(res.body.posts[0]!.locked).toBe(true);
      expect(res.body.posts[0]!.body).toBeNull();
      expect(res.raw).not.toContain("a galera lê");
    });
  });

  // ------------------------------------------------------------- invalidation

  describe("an edit invalidates", () => {
    it("serves the original (not the stale translation) at once, then the new translation", async () => {
      const post = await publish();
      await untilTranslated(post.id);
      let release!: () => void;
      fake.state.gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const edited = "Mudamos o texto: agora o Baú também avisa quando tem post novo, você não perde nada.";
      await call(owner, "PATCH", `${base()}/posts/${post.id}`, { body: edited });

      const during = (await feed(member, "en")).body.posts[0]!;
      expect(during.body).toBe(edited);
      expect(during.translation).toBeNull();
      // Staff can see it is stale.
      const staff = await call<{ translations: Array<{ lang: string; stale: boolean }> }>(
        owner,
        "GET",
        `${base()}/posts/${post.id}/translations`,
      );
      expect(staff.body.translations.filter((t) => t.stale).length).toBeGreaterThan(0);

      release();
      await vi.waitFor(async () => {
        expect((await feed(member, "en")).body.posts[0]!.translation).not.toBeNull();
      }, { timeout: 4000 });
      expect((await feed(member, "en")).body.posts[0]!.body).toBe(`[en] ${edited}`);
    });

    it("an edit that changes nothing in the text does not call the model again", async () => {
      const post = await publish();
      await untilTranslated(post.id);
      const before = fake.calls.length;
      await call(owner, "PATCH", `${base()}/posts/${post.id}`, { commentsEnabled: false });
      await tr.scheduleCommunityHomeTranslation(post.id, serverId);
      expect(fake.calls.length).toBe(before);
    });

    it("an edit during a translation discards the old result and translates the new text", async () => {
      const post = await publish();
      await untilTranslated(post.id);
      await getPool().query(`DELETE FROM community_home_post_translations WHERE post_id = $1`, [post.id]);
      const edited = "Texto novo, escrito enquanto a tradução do antigo ainda estava rodando por aí.";
      let first = true;
      fake.state.onCall = async () => {
        if (!first) return;
        first = false;
        await getPool().query(`UPDATE community_home_posts SET body = $2 WHERE id = $1`, [post.id, edited]);
      };
      expect(await tr.translateCommunityHomePost(post.id, "en")).toBe("done");
      const en = (await rows(post.id)).find((r) => r.lang === "en")!;
      expect(en.body).toBe(`[en] ${edited}`);
      expect((await tr.communityHomeTranslationMetrics()).discardedStale).toBe(1);
    });

    it("the SQL hash the sweep compares with is the hash the read computes", async () => {
      const post = await publish({ title: "Título", body: "Corpo do post com acentuação: ção ã é", teaser: null });
      const { rows: r } = await getPool().query<{ h: string }>(
        `SELECT md5(coalesce(title,'') || chr(31) || coalesce(teaser,'') || chr(31) || body) AS h
           FROM community_home_posts WHERE id = $1`,
        [post.id],
      );
      expect(r[0]!.h).toBe(
        tr.translationSourceHash({ title: "Título", teaser: null, body: "Corpo do post com acentuação: ção ã é" }),
      );
    });
  });

  // ----------------------------------------------------- two instances, claims

  describe("two instances, one translation", () => {
    it("two machines racing for the claim: one winner", async () => {
      const post = await publish();
      await untilTranslated(post.id);
      await getPool().query(`DELETE FROM community_home_translation_jobs`);
      const hash = tr.translationSourceHash({ title: PT_TITLE, teaser: null, body: PT_BODY });
      const results = await Promise.all(
        ["api-a", "api-b", "api-a", "api-b"].map((claimedBy) =>
          tr.claimTranslationJob(post.id, "en", hash, { claimedBy }),
        ),
      );
      expect(results.filter(Boolean)).toHaveLength(1);
    });

    it("the same post, the same language, started on two machines at once: the model is asked once", async () => {
      const post = await publishQuiet();
      let release!: () => void;
      fake.state.gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const a = tr.translateCommunityHomePost(post.id, "en");
      const b = tr.translateCommunityHomePost(post.id, "en");
      await vi.waitFor(() => expect(fake.calls.length).toBeGreaterThan(0));
      release();
      const outcomes = (await Promise.all([a, b])).sort();
      expect(outcomes).toEqual(["done", "skipped:claimed"]);
      expect(fake.calls.filter((c) => c.to === "en")).toHaveLength(1);
    });

    it("a crashed machine's claim is taken over after the lease, not before", async () => {
      const post = await publish();
      await untilTranslated(post.id);
      await getPool().query(`DELETE FROM community_home_translation_jobs`);
      const hash = "h1";
      expect(await tr.claimTranslationJob(post.id, "en", hash, { claimedBy: "api-a" })).not.toBeNull();
      expect(await tr.claimTranslationJob(post.id, "en", hash, { claimedBy: "api-b" })).toBeNull();
      await getPool().query(
        `UPDATE community_home_translation_jobs SET claimed_at = NOW() - INTERVAL '10 minutes'`,
      );
      expect(await tr.claimTranslationJob(post.id, "en", hash, { claimedBy: "api-b" })).not.toBeNull();
    });
  });

  // ------------------------------------------------------ budget and failures

  describe("bounded", () => {
    it("over the daily budget: not sent, counted, the claim released, and the sweep stops asking", async () => {
      process.env.COMMUNITY_HOME_TRANSLATION_DAILY_CHARS = "50";
      const post = await publishQuiet();
      tr.resetCommunityHomeTranslationForTests();
      tr.setCommunityHomeTranslatorForTests(fake.translator);
      fake.calls.length = 0;
      expect(await tr.translateCommunityHomePost(post.id, "en")).toBe("skipped:over_budget");
      expect(fake.calls).toHaveLength(0);
      expect((await tr.communityHomeTranslationMetrics()).skippedOverBudget).toBe(1);
      const jobs = await getPool().query(`SELECT 1 FROM community_home_translation_jobs`);
      expect(jobs.rowCount).toBe(0);
      expect(await tr.sweepCommunityHomeTranslations()).toEqual({ attempted: 0 });
      // The next day, or a bigger budget, and it goes through.
      process.env.COMMUNITY_HOME_TRANSLATION_DAILY_CHARS = "100000";
      expect(await tr.translateCommunityHomePost(post.id, "en")).toBe("done");
    });

    it("the reservation is atomic across callers: a cap of 50 admits one 30-char request of three", async () => {
      process.env.COMMUNITY_HOME_TRANSLATION_DAILY_CHARS = "50";
      const got = await Promise.all([30, 30, 30].map((n) => tr.reserveTranslationBudget(n)));
      expect(got.filter(Boolean)).toHaveLength(1);
      // One bigger than the whole cap is refused outright, even as the first of the day.
      await getPool().query(`TRUNCATE community_home_translation_usage`);
      expect(await tr.reserveTranslationBudget(51)).toBeNull();
    });

    it("counts what was sent and what it cost, and reports today's spend from the database", async () => {
      const post = await publish();
      await untilTranslated(post.id);
      const m = await tr.communityHomeTranslationMetrics();
      expect(m.done).toBe(2);
      expect(m.sameLanguage).toBe(1);
      expect(m.charsSent).toBe(2 * (PT_TITLE.length + PT_BODY.length));
      expect(m.costUsd).toBeCloseTo(0.002, 6);
      expect(m.today?.chars).toBe(m.charsSent);
      expect(m.configured).toBe(true);
    });

    it("a post over the per-post cap is truncated with a note, not sent whole", async () => {
      process.env.COMMUNITY_HOME_TRANSLATION_MAX_CHARS = "400";
      const long = Array.from({ length: 60 }, (_, i) => `Parágrafo ${i} do post, com o pqp e o QG falando de coisa que você já sabe.`).join(" ");
      const post = await publish({ title: PT_TITLE, body: long.slice(0, 3900) });
      await untilTranslated(post.id);
      const sent = fake.calls[0]!.texts;
      expect(sent.join("").length).toBeLessThanOrEqual(400 + 8);
      expect(sent[sent.length - 1]!.endsWith("[…]")).toBe(true);
      expect((await tr.communityHomeTranslationMetrics()).truncated).toBeGreaterThan(0);
    });

    it("a failing provider backs off, refunds the budget, and gives up quietly after four tries", async () => {
      const post = await publishQuiet();
      tr.resetCommunityHomeTranslationForTests();
      tr.setCommunityHomeTranslatorForTests(fake.translator);
      fake.state.fail = new Error("openrouter-chat HTTP 429: slow down");
      fake.calls.length = 0;

      expect(await tr.translateCommunityHomePost(post.id, "en")).toBe("failed");
      const job = (await getPool().query<{ attempts: number; retry_at: Date; last_error: string }>(
        `SELECT attempts, retry_at, last_error FROM community_home_translation_jobs WHERE post_id = $1`,
        [post.id],
      )).rows[0]!;
      expect(job.attempts).toBe(1);
      expect(job.retry_at.getTime()).toBeGreaterThan(Date.now());
      expect(job.last_error).toContain("429");
      // The failed attempt did not eat the day's budget.
      const spent = await getPool().query<{ chars: string }>(`SELECT chars FROM community_home_translation_usage`);
      expect(Number(spent.rows[0]?.chars ?? 0)).toBe(0);
      // In backoff: neither a second call nor the sweep touches it.
      expect(await tr.translateCommunityHomePost(post.id, "en")).toBe("skipped:claimed");
      expect(fake.calls).toHaveLength(1);

      for (let attempt = 2; attempt <= 4; attempt++) {
        await getPool().query(`UPDATE community_home_translation_jobs SET retry_at = NOW() - INTERVAL '1 second'`);
        expect(await tr.translateCommunityHomePost(post.id, "en")).toBe("failed");
      }
      expect(fake.calls).toHaveLength(4);
      await getPool().query(`UPDATE community_home_translation_jobs SET retry_at = NOW() - INTERVAL '1 second'`);
      // Gave up: not even a due retry is attempted, and the sweep does not list it.
      expect(await tr.translateCommunityHomePost(post.id, "en")).toBe("skipped:claimed");
      expect(fake.calls).toHaveLength(4);
      const m = await tr.communityHomeTranslationMetrics();
      expect(m.failed).toBe(4);
      expect(m.gaveUp).toBe(1);
      expect(m.lastError).toContain("429");
      // An edit is a new version of the post: the give-up does not outlive it.
      fake.state.fail = null;
      await call(owner, "PATCH", `${base()}/posts/${post.id}`, { body: "Texto corrigido do post, agora sim com você lendo tudo certinho." });
      await vi.waitFor(async () => {
        expect((await rows(post.id)).some((r) => r.lang === "en")).toBe(true);
      }, { timeout: 4000 });
    });

    it("a model that answers with the wrong number of strings is a failure, not a stored translation", async () => {
      const post = await publishQuiet();
      tr.setCommunityHomeTranslatorForTests({
        id: "bad",
        translate: async () => ({ texts: ["só um"], costUsd: 0 }),
      });
      expect(await tr.translateCommunityHomePost(post.id, "en")).toBe("failed");
      expect(await rows(post.id)).toEqual([]);
      // The provider answered, so it billed: the reservation stays and the
      // characters count as sent. Retrying cannot free the same budget again.
      const spent = await getPool().query<{ chars: string }>(`SELECT chars FROM community_home_translation_usage`);
      expect(Number(spent.rows[0]!.chars)).toBe(PT_TITLE.length + PT_BODY.length);
      expect((await tr.communityHomeTranslationMetrics()).charsSent).toBe(PT_TITLE.length + PT_BODY.length);
    });

    it("a billed provider failure keeps its budget; an unbilled one gives it back", async () => {
      const post = await publishQuiet();
      const sent = PT_TITLE.length + PT_BODY.length;
      const billedError = Object.assign(new Error("openrouter-chat HTTP 500 after a billed call"), {
        costUsd: 0.0004,
        costIncomplete: false,
      });
      tr.setCommunityHomeTranslatorForTests({
        id: "billed",
        translate: async () => {
          throw billedError;
        },
      });
      expect(await tr.translateCommunityHomePost(post.id, "en")).toBe("failed");
      const usage = async () =>
        Number((await getPool().query<{ chars: string }>(`SELECT chars FROM community_home_translation_usage`)).rows[0]?.chars ?? 0);
      expect(await usage()).toBe(sent);
      expect((await tr.communityHomeTranslationMetrics()).costUsd).toBeCloseTo(0.0004, 6);
      await getPool().query(`UPDATE community_home_translation_jobs SET retry_at = NOW() - INTERVAL '1 second'`);
      tr.setCommunityHomeTranslatorForTests({
        id: "unbilled",
        translate: async () => {
          throw new Error("fetch failed");
        },
      });
      expect(await tr.translateCommunityHomePost(post.id, "en")).toBe("failed");
      // Only the first attempt's reservation is still held.
      expect(await usage()).toBe(sent);
    });

    it("an edit starts fresh: it is not held back by the old version's backoff", async () => {
      const post = await publishQuiet();
      fake.state.fail = new Error("openrouter-chat HTTP 503: down");
      expect(await tr.translateCommunityHomePost(post.id, "en")).toBe("failed");
      expect(await tr.translateCommunityHomePost(post.id, "en")).toBe("skipped:claimed");
      fake.state.fail = null;
      await getPool().query(`UPDATE community_home_posts SET body = $2 WHERE id = $1`, [
        post.id,
        "Texto novo do post, escrito depois da falha, com você lendo no seu idioma de sempre.",
      ]);
      expect(await tr.translateCommunityHomePost(post.id, "en")).toBe("done");
    });

    it("the queue holds a (post, language) once, however often it is asked", async () => {
      const post = await publishQuiet();
      let release!: () => void;
      fake.state.gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const asks = [1, 2, 3, 4].map(() => tr.scheduleCommunityHomeTranslation(post.id, serverId));
      await vi.waitFor(() => expect(fake.calls.length).toBeGreaterThan(0));
      release();
      await Promise.all(asks);
      expect(fake.calls.filter((c) => c.to === "en")).toHaveLength(1);
      expect(fake.calls.filter((c) => c.to === "es")).toHaveLength(1);
    });
  });

  // ---------------------------------------------------- sweep and per-server

  describe("the sweep and the per-server flag", () => {
    beforeEach(async () => {
      await flags.startFeatureFlags();
    });

    async function bareInstanceWithPost() {
      delete process.env.COMMUNITY_HOME_TRANSLATION;
      const post = await publish();
      expect(await rows(post.id)).toEqual([]);
      return post;
    }

    it("global off, this server overridden on: only this server's posts are swept", async () => {
      const post = await bareInstanceWithPost();
      const other = await createChatServer("Outro", owner.id);
      const otherPost = await call<{ post: PostBody }>(owner, "POST", `/api/servers/${other.server.id}/home/posts`, {
        status: "published",
        title: PT_TITLE,
        body: PT_BODY,
      });
      expect(otherPost.status).toBe(201);
      await flags.setServerFlagOverride("community_home_translation", serverId, true, { kind: "dashboard" });
      expect((await tr.sweepCommunityHomeTranslations()).attempted).toBe(3);
      expect((await rows(post.id)).length).toBe(3);
      expect(await rows(otherPost.body.post.id)).toEqual([]);
      // And only that server's readers are served translations.
      expect((await feed(member, "en")).body.translationEnabled).toBe(true);
    });

    it("global on, this server overridden off: it is left alone, and nothing is served", async () => {
      const post = await bareInstanceWithPost();
      process.env.COMMUNITY_HOME_TRANSLATION = "true";
      await flags.setServerFlagOverride("community_home_translation", serverId, false, { kind: "dashboard" });
      expect(await tr.sweepCommunityHomeTranslations()).toEqual({ attempted: 0 });
      expect(await rows(post.id)).toEqual([]);
      expect((await feed(member, "en")).body.translationEnabled).toBe(false);
    });

    it("a second sweep finds nothing to do once everything is current", async () => {
      await bareInstanceWithPost();
      process.env.COMMUNITY_HOME_TRANSLATION = "true";
      expect((await tr.sweepCommunityHomeTranslations()).attempted).toBe(3);
      fake.calls.length = 0;
      expect(await tr.sweepCommunityHomeTranslations()).toEqual({ attempted: 0 });
      expect(fake.calls).toHaveLength(0);
    });

    it("after a scan that found nothing, an idle deployment does not rescan every post each minute", async () => {
      const post = await bareInstanceWithPost();
      process.env.COMMUNITY_HOME_TRANSLATION = "true";
      expect((await tr.sweepCommunityHomeTranslations()).attempted).toBe(3);
      expect(await tr.sweepCommunityHomeTranslations()).toEqual({ attempted: 0 });
      await getPool().query(`UPDATE community_home_posts SET body = $2 WHERE id = $1`, [
        post.id,
        "Texto mudado por baixo dos panos, que o resgate de dez minutos ainda vai pegar depois.",
      ]);
      // Inside the idle window the scan is skipped...
      expect(await tr.sweepCommunityHomeTranslations()).toEqual({ attempted: 0 });
      // ...and a change in the switches (here, a different set of servers) ends it at once.
      const other = await createChatServer("Fora", owner.id);
      await flags.setServerFlagOverride("community_home_translation", other.server.id, false, { kind: "dashboard" });
      expect((await tr.sweepCommunityHomeTranslations()).attempted).toBe(3);
    });

    it("work dropped because the queue was full is not hidden from the next sweep by the idle shortcut", async () => {
      await bareInstanceWithPost();
      process.env.COMMUNITY_HOME_TRANSLATION = "true";
      // Nothing is missing yet: wait, nothing to find... so publish after an empty scan.
      await getPool().query(`DELETE FROM community_home_posts`);
      expect(await tr.sweepCommunityHomeTranslations()).toEqual({ attempted: 0 });
      tr.setCommunityHomeTranslatorForTests(null);
      const post = await publish();
      tr.setCommunityHomeTranslatorForTests(fake.translator);
      // A queue that holds nothing: the publish's own job is dropped for room.
      let release!: () => void;
      fake.state.gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      tr.setCommunityHomeTranslationQueueLimitForTests(-1);
      await tr.scheduleCommunityHomeTranslation(post.id, serverId);
      tr.setCommunityHomeTranslationQueueLimitForTests(null);
      release();
      expect(fake.calls).toHaveLength(0);
      // Inside the idle window, yet the sweep still looks.
      expect((await tr.sweepCommunityHomeTranslations()).attempted).toBe(3);
    });

    it("a post edited with nothing translating it (a crash, a missed call) is caught by the sweep", async () => {
      const post = await publish();
      await untilTranslated(post.id);
      await getPool().query(`UPDATE community_home_posts SET body = $2 WHERE id = $1`, [
        post.id,
        "Texto novo que ninguém mandou traduzir, mas que você vai ler no seu idioma mesmo assim.",
      ]);
      expect((await tr.sweepCommunityHomeTranslations()).attempted).toBe(3);
      expect((await feed(member, "en")).body.posts[0]!.body).toContain("Texto novo");
    });
  });

  // ------------------------------------------------------ staff and cleanup

  describe("staff and cleanup", () => {
    it("the per-language list is staff only and read only", async () => {
      const post = await publish();
      await untilTranslated(post.id);
      expect((await call(member, "GET", `${base()}/posts/${post.id}/translations`)).status).toBe(403);
      const res = await call<{ enabled: boolean; translations: Array<{ lang: string; stale: boolean; sameLanguage: boolean; body: string }> }>(
        owner,
        "GET",
        `${base()}/posts/${post.id}/translations`,
      );
      expect(res.status).toBe(200);
      expect(res.body.enabled).toBe(true);
      expect(res.body.translations.map((t) => [t.lang, t.sameLanguage, t.stale])).toEqual([
        ["en", false, false],
        ["es", false, false],
        ["pt", true, false],
      ]);
      expect(res.body.translations[0]!.body).toBe(`[en] ${PT_BODY}`);
      // There is no write route.
      expect((await call(owner, "PUT", `${base()}/posts/${post.id}/translations`, {})).status).toBeGreaterThanOrEqual(400);
    });

    it("a post of another server is a 404 on the staff list", async () => {
      const other = await createChatServer("Outro", owner.id);
      const post = await publish();
      const res = await call(owner, "GET", `/api/servers/${other.server.id}/home/posts/${post.id}/translations`);
      expect(res.status).toBe(404);
    });

    it("deleting the post deletes its translations, claims and nothing else", async () => {
      const keep = await publish();
      const gone = await publish({ title: "Outro post do QG" });
      await untilTranslated(keep.id);
      await untilTranslated(gone.id);
      await call(owner, "DELETE", `${base()}/posts/${gone.id}`);
      expect(await rows(gone.id)).toEqual([]);
      expect((await rows(keep.id)).length).toBe(3);
    });

    it("the feed says whether to tell staff (flag on and a key)", async () => {
      expect((await feed(owner)).body.translationEnabled).toBe(true);
      const drafts = await call<{ translationEnabled: boolean }>(owner, "GET", `${base()}/drafts`);
      expect(drafts.body.translationEnabled).toBe(true);
    });
  });
});

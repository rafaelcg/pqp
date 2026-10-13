import { expect, test, type Browser, type Page, type Route } from "@playwright/test";
import { E2E_ADMIN_TOKEN } from "../playwright.config";

/**
 * Forum channels, the shell (forum PR 3a): creating a forum from the Texto
 * section's "+", its sidebar row, its settings (guidelines, "Intervalo entre
 * posts", the Tags section), the `/post/<id>` deep link and the chat-thread
 * deep link fix.
 *
 * Two real accounts through the dev bypass suffix (an owner and a member),
 * and the runtime flag `forum_channels` flipped ON for this spec's server
 * only, the way the operator dashboard does. Creating the forum channel is
 * real (PR 0's guarded create route).
 *
 * The forum routes themselves (tags, settings, posts) are forum PR 1, built
 * in parallel. Until it lands they are served here by `page.route` from an
 * in-memory forum shaped exactly like the shared contract
 * (`packages/shared/src/forums.ts`), so this spec pins the client half of the
 * seam. When PR 1 is on main, drop `mockForumApi` and the same assertions run
 * against the real server.
 *
 * `FORUM_SHOTS=1` runs it in pt-BR and saves QA screenshots (desktop and
 * phone width, dark and light) under `test-results/forum-shell/`.
 */

const API = process.env.E2E_API_URL ?? "http://localhost:3101";
const DEV_TOKEN = "dev-local-token";
const SHOTS = process.env.FORUM_SHOTS === "1";
const LANG = SHOTS ? "pt-BR" : "en";
const COPY = {
  en: {
    devBypass: "Dev auth bypass",
    newInText: "New in text",
    createText: "Create text channel",
    createForum: "Create forum",
    create: "Create",
    guidelinesPlaceholder: "Forum guidelines (optional)",
    channelSettings: "Channel settings",
    tags: "Tags",
    overview: "Overview",
    useThese: "Use these",
    unsaved4: "4 unsaved changes",
    unsaved1: "1 unsaved change",
    save: "Save",
    guidelines: "Forum guidelines",
    slowMode: "Time between posts",
    requireTag: "Require at least one tag",
    deleteTag: "Delete tag",
    newTag: "New tag name",
    add: "Add",
    nameTaken: "A tag with that name already exists.",
    duplicate: " QUESTION ",
    stillGone: "That channel no longer exists or is private.",
  },
  "pt-BR": {
    devBypass: "Bypass de auth de desenvolvimento",
    newInText: "Novo em texto",
    createText: "Criar canal de texto",
    createForum: "Criar fórum",
    create: "Criar",
    guidelinesPlaceholder: "Regras do fórum (opcional)",
    channelSettings: "Configurações do canal",
    tags: "Tags",
    overview: "Visão geral",
    useThese: "Usar essas",
    unsaved4: "4 mudanças não salvas",
    unsaved1: "1 mudança não salva",
    save: "Salvar",
    guidelines: "Regras do fórum",
    slowMode: "Intervalo entre posts",
    requireTag: "Exigir pelo menos uma tag",
    deleteTag: "Excluir tag",
    newTag: "Nome da tag nova",
    add: "Adicionar",
    nameTaken: "Já tem uma tag com esse nome.",
    duplicate: "duvida",
    stillGone: "That channel no longer exists or is private.",
  },
}[LANG];

test.setTimeout(120_000);
test.use({ viewport: { width: 1280, height: 800 }, colorScheme: "dark", trace: "off" });

function headersFor(suffix: string) {
  return {
    "Content-Type": "application/json",
    Authorization: `Bearer ${DEV_TOKEN}:${suffix}`,
  };
}

async function api<T>(suffix: string, path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`${API}${path}`, { ...init, headers: headersFor(suffix) });
  if (!res.ok) {
    throw new Error(`${init.method ?? "GET"} ${path}: ${res.status} ${await res.text()}`);
  }
  return (await res.json()) as T;
}

async function materialise(suffix: string): Promise<void> {
  const me = await api<{ ageGate?: string }>(suffix, "/api/me");
  // Through `api`, which throws on a refusal: a seed that half worked would
  // fail later, in whatever the spec was actually about.
  if (me.ageGate && me.ageGate !== "passed") {
    await api(suffix, "/api/me/age-check", {
      method: "POST",
      body: JSON.stringify({ dateOfBirth: "1990-01-01" }),
    });
  }
  await api(suffix, "/api/me/preferences", {
    method: "PATCH",
    body: JSON.stringify({
      onboardedAt: new Date().toISOString(),
      firstRunDismissedAt: new Date().toISOString(),
    }),
  });
}

interface Seeded {
  serverId: string;
  generalId: string;
}

const run = Date.now().toString(36);
const OWNER = `forumowner${run}`.slice(0, 32);
const MEMBER = `forumbob${run}`.slice(0, 32);

async function seed({ forumsOn }: { forumsOn: boolean }): Promise<Seeded> {
  await materialise(OWNER);
  await materialise(MEMBER);
  const { server } = await api<{ server: { id: string } }>(OWNER, "/api/servers", {
    method: "POST",
    body: JSON.stringify({ name: forumsOn ? "Bugados" : "Sem fórum" }),
  });
  const { channels } = await api<{ channels: { id: string; type: string }[] }>(
    OWNER,
    `/api/servers/${server.id}/channels`,
  );
  const { invite } = await api<{ invite: { code: string } }>(
    OWNER,
    `/api/servers/${server.id}/invites`,
    { method: "POST", body: JSON.stringify({}) },
  );
  await api(MEMBER, `/api/invites/${invite.code}/join`, { method: "POST" });
  if (forumsOn) {
    const flip = await fetch(`${API}/api/admin/flag-overrides`, {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${E2E_ADMIN_TOKEN}`,
      },
      body: JSON.stringify({ key: "forum_channels", serverId: server.id, enabled: true }),
    });
    expect(flip.status).toBe(200);
  }
  return {
    serverId: server.id,
    generalId: channels.find((one) => one.type === "text")!.id,
  };
}

async function open(browser: Browser, suffix: string, path: string, phone = false) {
  const context = await browser.newContext({
    viewport: phone ? { width: 390, height: 844 } : { width: 1280, height: 800 },
    colorScheme: "dark",
    ...(phone ? { isMobile: true, hasTouch: true } : {}),
  });
  const page = await context.newPage();
  await page.addInitScript((value) => {
    localStorage.setItem("pqp:dev-user-suffix", value);
  }, suffix);
  await page.goto(`${path}?lang=${LANG}`);
  await expect(page.getByText(COPY.devBypass)).toBeVisible({ timeout: 20_000 });
  return { context, page };
}

async function shot(page: Page, name: string) {
  if (!SHOTS) {
    return;
  }
  await page.screenshot({ path: `test-results/forum-shell/${name}.png` });
}

/**
 * The forum routes of PR 1, in memory: tags (with post counts), settings,
 * and single posts by id. Everything else goes to the real server.
 */
interface MockForum {
  tags: Array<{
    id: string;
    name: string;
    emoji: string | null;
    icon?: string | null;
    preset?: string | null;
    moderated: boolean;
    position: number;
    postCount: number;
  }>;
  settings: { requireTag: boolean; defaultSort: "activity" | "created" };
  puts: unknown[];
  patches: unknown[];
  posts: Map<string, Record<string, unknown>>;
}

function uuid(n: number): string {
  return `00000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;
}

async function mockForumApi(page: Page, forum: MockForum): Promise<void> {
  let seq = 100;
  await page.route(/\/api\/channels\/[^/]+\/forum-tags$/, async (route: Route) => {
    if (route.request().method() === "PUT") {
      const body = route.request().postDataJSON() as {
        tags: Array<{
          id?: string;
          name: string;
          emoji?: string | null;
          icon?: string | null;
          preset?: string | null;
          moderated: boolean;
        }>;
      };
      forum.puts.push(body);
      const byId = new Map(forum.tags.map((tag) => [tag.id, tag]));
      forum.tags = body.tags.map((tag, position) => ({
        id: tag.id ?? uuid((seq += 1)),
        name: tag.name,
        emoji: tag.emoji ?? null,
        icon: tag.icon ?? null,
        preset: tag.preset ?? null,
        moderated: tag.moderated,
        position,
        postCount: tag.id ? (byId.get(tag.id)?.postCount ?? 0) : 0,
      }));
    }
    await route.fulfill({ json: { tags: forum.tags } });
  });
  await page.route(/\/api\/channels\/[^/]+\/forum-settings$/, async (route: Route) => {
    if (route.request().method() === "PATCH") {
      const body = route.request().postDataJSON() as Partial<MockForum["settings"]>;
      forum.patches.push(body);
      forum.settings = { ...forum.settings, ...body };
    }
    await route.fulfill({ json: { settings: forum.settings } });
  });
  await page.route(/\/api\/forum-posts\/[^/]+$/, async (route: Route) => {
    const id = route.request().url().split("/").pop()!;
    const post = forum.posts.get(id);
    if (!post) {
      await route.fulfill({ status: 404, json: { error: "Not found" } });
      return;
    }
    await route.fulfill({
      json: {
        post,
        viewer: { postId: id, lastReadAt: null, newReplyCount: 0, following: false },
        acceptedAnswer: null,
        participantCount: 1,
      },
    });
  });
}

function postSummary(id: string, forumId: string, title: string): Record<string, unknown> {
  const now = new Date().toISOString();
  return {
    id,
    forumId,
    title,
    authorId: null,
    authorName: "Bob",
    authorAvatarUrl: null,
    authorIsWebhook: false,
    createdAt: now,
    lastActivityAt: now,
    pinnedAt: null,
    lockedAt: null,
    resolvedAt: null,
    acceptedAnswerId: null,
    preview: "Abre, fica no Conectando e fecha.",
    openingDeleted: false,
    openingKind: "text",
    attachmentCount: 0,
    replyCount: 2,
    reactionCount: 0,
    topReaction: null,
    thumbnailUrl: null,
    thumbnailAttachmentId: null,
    thumbnailWidth: null,
    thumbnailHeight: null,
    tagIds: [],
  };
}

function forumRow(page: Page, name: string) {
  return page.locator(`[data-channel-type="forum"]`).filter({ hasText: name });
}

test.describe("forum shell, QA screenshots", () => {
  test.skip(!SHOTS, "FORUM_SHOTS=1 only");

  for (const scheme of ["dark", "light"] as const) {
    for (const phone of [false, true]) {
      test(`${phone ? "390" : "1280"} ${scheme}`, async ({ browser }) => {
        const seeded = await seed({ forumsOn: true });
        const { channel } = await api<{ channel: { id: string } }>(
          OWNER,
          `/api/servers/${seeded.serverId}/channels`,
          {
            method: "POST",
            body: JSON.stringify({
              name: "ajuda",
              type: "forum",
              topic: "Um problema por post. Bota o print e o que tu já tentou.",
            }),
          },
        );
        const forum: MockForum = {
          tags: [
            { id: uuid(1), name: "Dúvida", emoji: "❓", moderated: false, position: 0, postCount: 128 },
            { id: uuid(2), name: "Bug", emoji: "🐛", moderated: false, position: 1, postCount: 64 },
            { id: uuid(3), name: "Games", emoji: "🎮", moderated: false, position: 2, postCount: 51 },
            { id: uuid(4), name: "Tutorial", emoji: "📚", moderated: false, position: 3, postCount: 19 },
            { id: uuid(5), name: "Oficial", emoji: "📌", moderated: true, position: 4, postCount: 3 },
          ],
          settings: { requireTag: true, defaultSort: "activity" },
          puts: [],
          patches: [],
          posts: new Map(),
        };
        const context = await browser.newContext({
          viewport: phone ? { width: 390, height: 844 } : { width: 1280, height: 800 },
          colorScheme: scheme,
          ...(phone ? { isMobile: true, hasTouch: true } : {}),
        });
        const page = await context.newPage();
        await page.addInitScript((value) => {
          localStorage.setItem("pqp:dev-user-suffix", value);
          localStorage.setItem("pqp-theme", "system");
        }, OWNER);
        await mockForumApi(page, forum);
        await page.route(/\/api\/servers\/[^/]+\/unread$/, async (route) => {
          const response = await route.fetch();
          const body = (await response.json()) as { unread: unknown[] };
          await route.fulfill({
            response,
            json: {
              ...body,
              unread: [...body.unread, { channelId: channel.id, count: 2, mentions: 0 }],
            },
          });
        });
        const tag = `${phone ? "390" : "1280"}-${scheme}`;
        await page.goto(`/app/server/${seeded.serverId}/channel/${seeded.generalId}?lang=${LANG}`);
        await expect(page.getByText(COPY.devBypass)).toBeVisible({ timeout: 20_000 });
        const openNav = async () => {
          if (phone) {
            await page.locator('button[aria-label="Abrir navegação"]:visible').first().click();
          }
        };
        // Entrances and exits are short fades; a shot mid-fade is a lie.
        const settle = () => page.waitForTimeout(450);
        await openNav();
        await expect(forumRow(page, "ajuda")).toBeVisible();
        await settle();
        await shot(page, `sidebar-unread-${tag}`);
        await page.getByRole("button", { name: COPY.newInText }).click();
        await expect(page.getByRole("menuitem", { name: new RegExp(COPY.createForum) })).toBeVisible();
        await settle();
        await shot(page, `plus-menu-${tag}`);
        await page.keyboard.press("Escape");
        await forumRow(page, "ajuda").getByRole("button", { name: /ajuda/ }).first().click();
        await expect(page.locator("[data-forum-pane]")).toBeVisible();
        await settle();
        await shot(page, `forum-selected-${tag}`);
        await openNav();
        await forumRow(page, "ajuda").getByRole("button", { name: COPY.channelSettings }).click();
        const settings = page.getByRole("dialog");
        await expect(settings.getByText(COPY.guidelines, { exact: true })).toBeVisible();
        await settle();
        await shot(page, `overview-${tag}`);
        await settings.getByRole("tab", { name: COPY.tags }).click();
        await expect(settings.locator("[data-forum-tag-row]")).toHaveCount(5);
        await settings.locator("[data-forum-tag-row]").nth(2).getByRole("textbox").click();
        await settings.locator("[data-forum-tag-row]").nth(2).getByRole("textbox").fill("Jogos");
        await settle();
        await shot(page, `tags-${tag}`);
        await context.close();
      });
    }
  }
});

test.describe("forum shell", () => {
  test("an owner creates a forum from the Texto +, sets its tags, and a member sees it", async ({
    browser,
  }) => {
    const seeded = await seed({ forumsOn: true });
    const owner = await open(browser, OWNER, `/app/server/${seeded.serverId}`);
    const forum: MockForum = {
      tags: [],
      settings: { requireTag: false, defaultSort: "activity" },
      puts: [],
      patches: [],
      posts: new Map(),
    };
    await mockForumApi(owner.page, forum);

    // The "+" is a menu now: a text channel first, then the Fórum with beta.
    await owner.page.getByRole("button", { name: COPY.newInText }).click();
    await expect(owner.page.getByRole("menuitem", { name: COPY.createText })).toBeVisible();
    const forumItem = owner.page.getByRole("menuitem", { name: new RegExp(COPY.createForum) });
    await expect(forumItem).toContainText(/beta/i);
    await shot(owner.page, "01-plus-menu");
    await forumItem.click();

    const prompt = owner.page.getByRole("dialog");
    await expect(prompt.getByRole("heading", { name: COPY.createForum })).toBeVisible();
    await prompt.getByRole("textbox").first().fill("ajuda");
    await prompt
      .getByPlaceholder(COPY.guidelinesPlaceholder)
      .fill("Um problema por post. Bota o print e o que tu já tentou.");
    await shot(owner.page, "02-create-prompt");
    await prompt.getByRole("button", { name: COPY.create, exact: true }).click();

    // The row: Texto group, its own glyph, the beta pill; the pane is the forum's.
    const row = forumRow(owner.page, "ajuda");
    await expect(row).toBeVisible();
    await expect(row).toContainText(/beta/i);
    await expect(owner.page.locator("[data-forum-pane]")).toBeVisible();
    await expect(owner.page).toHaveURL(/\/channel\/[0-9a-f-]+$/);
    const forumId = new URL(owner.page.url()).pathname.split("/").pop()!;
    await shot(owner.page, "03-forum-selected");

    // Settings: Tags sits between Overview and Permissions.
    await row.getByRole("button", { name: COPY.channelSettings }).click();
    const settings = owner.page.getByRole("dialog");
    const tabs = settings.getByRole("tab");
    await expect(tabs.nth(0)).toHaveText(COPY.overview);
    await expect(tabs.nth(1)).toHaveText(COPY.tags);
    // Overview speaks forum: guidelines and the time between posts.
    await expect(settings.getByText(COPY.guidelines, { exact: true })).toBeVisible();
    await expect(settings.getByText(COPY.slowMode, { exact: true })).toBeVisible();
    await expect(settings.getByRole("textbox", { name: COPY.guidelines })).toHaveValue(
      "Um problema por post. Bota o print e o que tu já tentou.",
    );
    await shot(owner.page, "04-overview");

    await tabs.nth(1).click();
    // A help-desk name gets the support kit; one click puts all four in.
    await expect(settings.locator("[data-forum-starter]")).toBeVisible();
    await settings.getByRole("button", { name: COPY.useThese }).click();
    await expect(settings.locator("[data-forum-tag-row]")).toHaveCount(4);
    await expect(owner.page.getByText(COPY.unsaved4)).toBeVisible();
    await shot(owner.page, "05-tags-starters");

    // A duplicate in any case or accent is refused before the server is asked.
    await settings.getByRole("textbox", { name: COPY.newTag }).fill(COPY.duplicate);
    await settings.getByRole("button", { name: COPY.add, exact: true }).click();
    await expect(settings.getByText(COPY.nameTaken)).toBeVisible();
    await settings.getByRole("textbox", { name: COPY.newTag }).fill("Games");
    await settings.getByRole("button", { name: COPY.add, exact: true }).click();
    await expect(settings.locator("[data-forum-tag-row]")).toHaveCount(5);

    // Reorder from the keyboard: the handle's arrow keys move the row.
    const rows = settings.locator("[data-forum-tag-row]");
    const firstName = await rows.nth(0).getByRole("textbox").inputValue();
    await rows.nth(0).getByRole("button", { name: new RegExp(firstName) }).first().focus();
    await owner.page.keyboard.press("ArrowDown");
    await expect(rows.nth(1).getByRole("textbox")).toHaveValue(firstName);

    // The icon square opens a grid of named icons over the sheet, and Escape
    // closes the grid without throwing the whole sheet away.
    const iconButton = rows.nth(4).locator("[data-forum-tag-icon-button]");
    const picker = owner.page.locator("[data-forum-tag-icon-picker]");
    await iconButton.click();
    await expect(picker).toBeVisible();
    await shot(owner.page, "05b-icon-picker");
    await owner.page.keyboard.press("Escape");
    await expect(picker).toHaveCount(0);
    await expect(settings.locator("[data-forum-tag-row]")).toHaveCount(5);
    // And a pick lands on that row.
    await iconButton.click();
    await picker.locator('[data-forum-tag-icon-option="game"]').click();
    await expect(picker).toHaveCount(0);
    await expect(rows.nth(4).locator('[data-forum-tag-icon="game"]')).toBeVisible();

    await owner.page.getByRole("button", { name: COPY.save, exact: true }).click();
    await expect.poll(() => forum.puts.length).toBe(1);
    const saved = (
      forum.puts[0] as {
        tags: Array<{ name: string; icon?: string | null; preset?: string | null }>;
      }
    ).tags;
    expect(saved).toHaveLength(5);
    expect(saved[1]!.name).toBe(firstName);
    // The four starters travel with their preset and icon, so every reader
    // sees their own language's word; the tag typed by hand has no preset and
    // only the icon just picked.
    expect(saved.filter((tag) => tag.preset).length).toBe(4);
    expect(saved.every((tag) => tag.icon)).toBe(true);
    expect(saved.find((tag) => tag.name === "Games")).toMatchObject({
      icon: "game",
      preset: null,
    });
    await expect(owner.page.locator("[data-forum-tags-unsaved]")).toHaveCount(0);

    // The switch is its own PATCH; nothing else is resent.
    await settings.getByRole("switch", { name: COPY.requireTag }).click();
    await expect(owner.page.getByText(COPY.unsaved1)).toBeVisible();
    await owner.page.getByRole("button", { name: COPY.save, exact: true }).click();
    await expect.poll(() => forum.patches).toEqual([{ requireTag: true }]);
    expect(forum.puts).toHaveLength(1);

    // Deleting a saved tag asks first.
    const firstRow = settings.locator("[data-forum-tag-row]").first();
    await firstRow.getByRole("button", { name: /^(Delete|Excluir) / }).click();
    const confirm = owner.page.getByRole("dialog").filter({ hasText: COPY.deleteTag });
    await expect(confirm).toBeVisible();
    await shot(owner.page, "06-delete-confirm");
    await confirm.getByRole("button", { name: COPY.deleteTag }).click();
    await expect(settings.locator("[data-forum-tag-row]")).toHaveCount(4);
    await shot(owner.page, "07-tags-after-delete");

    // A member sees the row, and no settings tile on it.
    const member = await open(browser, MEMBER, `/app/server/${seeded.serverId}/channel/${forumId}`);
    await expect(forumRow(member.page, "ajuda")).toBeVisible();
    await expect(member.page.locator("[data-forum-pane]")).toBeVisible();
    await expect(
      forumRow(member.page, "ajuda").getByRole("button", { name: COPY.channelSettings }),
    ).toHaveCount(0);
    // The member's "+" is not there at all (no MANAGE_CHANNELS).
    await expect(member.page.getByRole("button", { name: COPY.newInText })).toHaveCount(0);

    await owner.context.close();
    await member.context.close();
  });

  test("a post link opens its forum and keeps the post's address; a post id as a channel finds its forum", async ({
    browser,
  }) => {
    const seeded = await seed({ forumsOn: true });
    const { channel: forumChannel } = await api<{ channel: { id: string } }>(
      OWNER,
      `/api/servers/${seeded.serverId}/channels`,
      { method: "POST", body: JSON.stringify({ name: "showcase", type: "forum" }) },
    );
    const postId = uuid(4242);
    const forum: MockForum = {
      tags: [],
      settings: { requireTag: false, defaultSort: "activity" },
      puts: [],
      patches: [],
      posts: new Map([
        [postId, postSummary(postId, forumChannel.id, "Valorant fecha sozinho depois do patch")],
      ]),
    };
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const page = await context.newPage();
    await page.addInitScript((value) => {
      localStorage.setItem("pqp:dev-user-suffix", value);
    }, MEMBER);
    await mockForumApi(page, forum);
    const postPath = `/app/server/${seeded.serverId}/channel/${forumChannel.id}/post/${postId}`;
    await page.goto(`${postPath}?lang=${LANG}`);
    await expect(page.getByText(COPY.devBypass)).toBeVisible({ timeout: 20_000 });

    // The forum is open, the post's own address stays (the pane draws the
    // post from `routePostId`; that half is forum PR 3b's spec), and no
    // "no longer exists" line.
    await expect(page.locator("[data-forum-pane]")).toBeVisible({ timeout: 20_000 });
    await expect(forumRow(page, "showcase")).toHaveAttribute("data-channel-id", forumChannel.id);
    await expect(page).toHaveURL(new RegExp(`/channel/${forumChannel.id}/post/${postId}`));
    await expect(page.getByText(COPY.stillGone)).toHaveCount(0);
    await shot(page, "08-post-deep-link");

    // A post id given as the channel (a search hit, a push): asked as a post,
    // it opens its forum and the address becomes the post's real one.
    await page.goto(`/app/server/${seeded.serverId}/channel/${postId}?lang=${LANG}`);
    await expect(page.locator("[data-forum-pane]")).toBeVisible({ timeout: 20_000 });
    await expect(page).toHaveURL(new RegExp(`/channel/${forumChannel.id}/post/${postId}`));
    await expect(page.getByText(COPY.stillGone)).toHaveCount(0);

    // An id that is neither a channel, a post nor a thread still says so.
    await page.goto(`/app/server/${seeded.serverId}/channel/${uuid(9999)}?lang=${LANG}`);
    await expect(page.getByText(COPY.stillGone)).toBeVisible({ timeout: 20_000 });

    await context.close();
  });

  test("on a phone, a finger on the handle reorders the tags", async ({ browser }) => {
    const seeded = await seed({ forumsOn: true });
    const { channel } = await api<{ channel: { id: string } }>(
      OWNER,
      `/api/servers/${seeded.serverId}/channels`,
      { method: "POST", body: JSON.stringify({ name: "ajuda", type: "forum" }) },
    );
    const forum: MockForum = {
      tags: ["Dúvida", "Bug", "Games", "Tutorial"].map((name, position) => ({
        id: uuid(position + 1),
        name,
        emoji: null,
        moderated: false,
        position,
        postCount: 0,
      })),
      settings: { requireTag: false, defaultSort: "activity" },
      puts: [],
      patches: [],
      posts: new Map(),
    };
    const context = await browser.newContext({
      viewport: { width: 390, height: 844 },
      isMobile: true,
      hasTouch: true,
    });
    const page = await context.newPage();
    await page.addInitScript((value) => {
      localStorage.setItem("pqp:dev-user-suffix", value);
    }, OWNER);
    await mockForumApi(page, forum);
    await page.goto(`/app/server/${seeded.serverId}/channel/${channel.id}?lang=${LANG}`);
    await expect(page.locator("[data-forum-pane]")).toBeVisible({ timeout: 20_000 });
    await page.locator('button[aria-label="' + (LANG === "en" ? "Open navigation" : "Abrir navegação") + '"]:visible').first().click();
    await forumRow(page, "ajuda").getByRole("button", { name: COPY.channelSettings }).click();
    const settings = page.getByRole("dialog");
    await settings.getByRole("tab", { name: COPY.tags }).click();
    const rows = settings.locator("[data-forum-tag-row]");
    await expect(rows).toHaveCount(4);

    // Drag "Dúvida" from the top to below "Games" with touch pointer events.
    const handle = rows.nth(0).getByRole("button").first();
    const target = await rows.nth(2).boundingBox();
    const start = await handle.boundingBox();
    const base = { pointerId: 7, pointerType: "touch", isPrimary: true, bubbles: true };
    await handle.dispatchEvent("pointerdown", { ...base, clientX: start!.x + 4, clientY: start!.y + 4 });
    await handle.dispatchEvent("pointermove", {
      ...base,
      clientX: start!.x + 4,
      clientY: target!.y + target!.height - 2,
    });
    await handle.dispatchEvent("pointerup", {
      ...base,
      clientX: start!.x + 4,
      clientY: target!.y + target!.height - 2,
    });
    await expect(rows.nth(2).getByRole("textbox")).toHaveValue("Dúvida");
    await expect(rows.nth(0).getByRole("textbox")).toHaveValue("Bug");
    await context.close();
  });

  test("a chat thread's own id opens its channel with the thread on top (the old dead link)", async ({
    browser,
  }) => {
    const seeded = await seed({ forumsOn: false });
    const owner = await open(browser, OWNER, `/app/server/${seeded.serverId}/channel/${seeded.generalId}`);
    const body = `raiz da thread ${run}`;
    const composer = owner.page.getByRole("combobox", { name: /^(Message|Mensagem) / });
    await composer.fill(body);
    await composer.press("Enter");
    await expect(owner.page.getByText(body).first()).toBeVisible();
    const { messages } = await api<{ messages: { id: string; body: string }[] }>(
      OWNER,
      `/api/channels/${seeded.generalId}/messages`,
    );
    const root = messages.find((one) => one.body === body)!;
    const { thread } = await api<{ thread: { channelId: string; name: string } }>(
      OWNER,
      `/api/messages/${root.id}/threads`,
      { method: "POST" },
    );

    await owner.page.goto(
      `/app/server/${seeded.serverId}/channel/${thread.channelId}?lang=${LANG}`,
    );
    await expect(owner.page.getByText(COPY.devBypass)).toBeVisible({ timeout: 20_000 });
    await expect(owner.page.locator(`aside[aria-label$=": ${thread.name}"]`)).toBeVisible({
      timeout: 20_000,
    });
    await expect(owner.page.getByText(COPY.stillGone)).toHaveCount(0);

    // And with forums off for the server, the Texto "+" is still the
    // one-click text channel, not the menu.
    await expect(
      owner.page.getByRole("button", { name: /^(New text channel|Novo canal de texto)$/ }),
    ).toBeVisible();
    await expect(owner.page.getByRole("button", { name: COPY.newInText })).toHaveCount(0);
    await owner.context.close();
  });
});

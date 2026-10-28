import { expect, test, type Page } from "@playwright/test";
import { E2E_ADMIN_TOKEN } from "../playwright.config";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Captures the screenshots a design council scores (`docs/DESIGN_COUNCIL.md`).
 *
 * NOT A TEST. Skipped unless `DESIGN_COUNCIL_DIR` names an output directory,
 * like `streamers-shots.spec.ts`, and for the same reason it lives here: it
 * needs the suite's webServer pair and the dev-bypass identities.
 *
 * Every round must photograph the same scene, or the scores compare two
 * different apps. So the scene is built from nothing on an empty database
 * each run: the same people, servers, channels, lines and reactions, in
 * pt-BR, at fixed viewports. It needs a database of its own, never the
 * suite's, and `tools/design-council/capture.sh` makes one and runs this:
 *
 *   tools/design-council/capture.sh /tmp/pqp-council/current
 *
 * Avatars are the app's own presets, loaded from DiceBear, for half the cast.
 * The other half has none, which is how most real accounts look.
 */

const API = process.env.E2E_API_URL ?? "http://localhost:3101";
const OUT = process.env.DESIGN_COUNCIL_DIR;
const DEV_TOKEN = "dev-local-token";
/** `ADMIN_METRICS_TOKEN` in `playwright.config.ts`, for a per-server flag. */
const ADMIN_TOKEN = "e2e-admin-token-0123456789abcdef";
/** `DESIGN_COUNCIL_REDESIGN=1`: photograph the redesign (`lib/redesign.ts`). */
const REDESIGN = process.env.DESIGN_COUNCIL_REDESIGN === "1";
const DESKTOP = { width: 1440, height: 900 };
const PHONE = { width: 390, height: 844 };

test.skip(!OUT, "Set DESIGN_COUNCIL_DIR to capture the design council screenshots");

// What the camera "sees": a slow, soft gradient. Chromium's own fake camera
// is a test card, which reviewers then score as if it were the product.
const CAMERA = path.join(
  OUT ? fs.mkdtempSync(path.join(os.tmpdir(), "pqp-council-")) : os.tmpdir(),
  "camera.y4m",
);
if (OUT) {
  const run = spawnSync("ffmpeg", [
    "-y", "-f", "lavfi", "-i", "gradients=size=1280x720:rate=15:speed=0.01:c0=0x2f3d4c:c1=0x8a7560:nb_colors=2:type=radial",
    "-t", "4", "-pix_fmt", "yuv420p", CAMERA,
  ]);
  if (run.status !== 0) {
    throw new Error(`ffmpeg failed: ${run.stderr.toString()}`);
  }
}

test.use({
  launchOptions: {
    args: [
      "--use-fake-device-for-media-stream",
      "--use-fake-ui-for-media-stream",
      `--use-file-for-fake-video-capture=${CAMERA}`,
    ],
  },
  permissions: ["microphone"],
  locale: "pt-BR",
  viewport: DESKTOP,
  trace: "off",
});

test.setTimeout(240_000);

/** The page's own account. */
const VIEWER = "lia";

/** The app's own presets (`AVATAR_PRESETS`); half the cast has none. */
const PRESET = (n: number) =>
  [
    "https://api.dicebear.com/9.x/shapes/png?seed=signal",
    "https://api.dicebear.com/9.x/shapes/png?seed=phosphor",
    "https://api.dicebear.com/9.x/shapes/png?seed=mesh",
    "https://api.dicebear.com/9.x/bottts-neutral/svg?seed=pqp1",
    "https://api.dicebear.com/9.x/shapes/png?seed=relay",
  ][n]!;

const PEOPLE: ReadonlyArray<[suffix: string, name: string, avatar: string | null]> = [
  [VIEWER, "Lia", PRESET(4)],
  ["rafa", "Rafa", PRESET(1)],
  ["bia", "Bia", null],
  ["caio", "Caio", PRESET(2)],
  ["duda", "Duda", null],
  ["gui", "Gui", PRESET(3)],
  ["nanda", "Nanda", null],
  ["teo", "Téo", null],
];

/** Online for the whole capture. Everybody else is offline. */
const ONLINE = ["rafa", "bia", "caio", "gui"];

/** Seated in the call beside the viewer. */
const IN_CALL = ["rafa", "bia", "caio"];

const PAPO: ReadonlyArray<[suffix: string, body: string]> = [
  ["rafa", "alguém on hoje à noite pra fechar aquela campanha?"],
  ["bia", "eu! mas só depois das 21h, tô presa no trampo"],
  ["caio", "21h fechou. vou deixar o servidor ligado"],
  ["duda", "trouxe o mapa novo que o Gui fez, ficou insano"],
  ["gui", "ainda tá meio bugado na parte da caverna, não me julguem"],
  ["nanda", "kkkkkk a caverna é o melhor pedaço"],
  ["rafa", "Lia, cê vem?"],
  [VIEWER, "vou sim, levo o lanche dessa vez 🍕"],
  ["teo", "alguém sabe se o patch de ontem quebrou os saves?"],
  ["caio", "quebrou não, só precisa abrir o jogo duas vezes. coisa linda"],
  ["bia", "clássico"],
  ["duda", "vou abrir o Lobby umas 20h50 pra testar o áudio"],
  ["gui", "boa. e dessa vez alguém lembra de gravar"],
  ["nanda", "eu gravo, mas se a internet cair a culpa é da operadora"],
];

/** Index into PAPO, emoji, who reacts. */
const REACTIONS: ReadonlyArray<[index: number, emoji: string, by: string[]]> = [
  [7, "🍕", ["rafa", "bia", "gui"]],
  [13, "😂", ["caio", "duda"]],
  [2, "👍", ["rafa", "teo"]],
];

const AVISOS: ReadonlyArray<[suffix: string, body: string]> = [
  ["caio", "campanha volta sexta, 21h. quem faltar paga o lanche"],
];

const DM: ReadonlyArray<[suffix: string, body: string]> = [
  ["rafa", "ei, cê tem aquele print do boss de ontem?"],
  [VIEWER, "tenho, mas tá horrível, tirei no meio da luta"],
  ["rafa", "manda assim mesmo, quero zoar o Caio"],
  [VIEWER, "kkkk mando quando chegar em casa"],
  ["rafa", "fechou 🙏"],
];

function headers(suffix: string) {
  return {
    "Content-Type": "application/json",
    Authorization: `Bearer ${DEV_TOKEN}:${suffix}`,
  };
}

async function json<T>(response: Response): Promise<T> {
  if (!response.ok) {
    throw new Error(`${response.url} ${response.status} ${await response.text()}`);
  }
  return (await response.json()) as T;
}

/** Past the age gate and onboarding, with a display name a person would pick. */
async function person(
  suffix: string,
  displayName: string,
  avatarUrl: string | null,
): Promise<string> {
  await fetch(`${API}/api/me`, { headers: headers(suffix) });
  await fetch(`${API}/api/me/age-check`, {
    method: "POST",
    headers: headers(suffix),
    body: JSON.stringify({ dateOfBirth: "1990-01-01" }),
  });
  await json(
    await fetch(`${API}/api/me`, {
      method: "PATCH",
      headers: headers(suffix),
      // A handle a person would pick, not the bypass's `dev_user_<suffix>`.
      body: JSON.stringify({ displayName, avatarUrl, username: suffix }),
    }),
  );
  const me = await json<{ id: string }>(await fetch(`${API}/api/me`, { headers: headers(suffix) }));
  await fetch(`${API}/api/me/preferences`, {
    method: "PATCH",
    headers: headers(suffix),
    body: JSON.stringify({
      onboardedAt: new Date().toISOString(),
      firstRunDismissedAt: new Date().toISOString(),
    }),
  });
  return me.id;
}

type Channel = { id: string; name: string; type: string; parentId?: string | null };

async function server(owner: string, name: string): Promise<{ id: string; channels: Channel[] }> {
  const body = await json<{ server: { id: string }; channels: Channel[] }>(
    await fetch(`${API}/api/servers`, {
      method: "POST",
      headers: headers(owner),
      body: JSON.stringify({ name }),
    }),
  );
  return { id: body.server.id, channels: body.channels };
}

async function channel(
  owner: string,
  serverId: string,
  name: string,
  type: "text" | "voice",
  parentId: string | null,
): Promise<string> {
  const body = await json<{ channel: { id: string } }>(
    await fetch(`${API}/api/servers/${serverId}/channels`, {
      method: "POST",
      headers: headers(owner),
      body: JSON.stringify({ name, type, parentId }),
    }),
  );
  return body.channel.id;
}

async function join(owner: string, serverId: string, suffix: string): Promise<void> {
  const { invite } = await json<{ invite: { code: string } }>(
    await fetch(`${API}/api/servers/${serverId}/invites`, {
      method: "POST",
      headers: headers(owner),
      body: JSON.stringify({}),
    }),
  );
  await json(
    await fetch(`${API}/api/invites/${invite.code}/join`, {
      method: "POST",
      headers: headers(suffix),
    }),
  );
}

async function befriend(a: string, b: string, bId: string, aId: string): Promise<void> {
  await fetch(`${API}/api/friends`, {
    method: "POST",
    headers: headers(a),
    body: JSON.stringify({ userId: bId }),
  });
  await fetch(`${API}/api/friends/${aId}/accept`, { method: "POST", headers: headers(b) });
}

type Frame = { type: string; [key: string]: unknown };

/** A real protocol client: presence while open, and the app's own send path. */
class Socket {
  private socket!: WebSocket;
  private frames: Frame[] = [];
  private waiters: { match: (f: Frame) => boolean; resolve: (f: Frame) => void }[] = [];

  constructor(readonly suffix: string) {}

  async connect(): Promise<void> {
    this.socket = new WebSocket(API.replace(/^http/, "ws") + "/ws");
    await new Promise<void>((resolve, reject) => {
      this.socket.addEventListener("open", () => resolve(), { once: true });
      this.socket.addEventListener("error", () => reject(new Error("ws")), { once: true });
    });
    this.socket.addEventListener("message", (event) => {
      const frame = JSON.parse(String(event.data)) as Frame;
      this.frames.push(frame);
      for (const waiter of this.waiters.splice(0)) {
        if (waiter.match(frame)) {
          waiter.resolve(frame);
        } else {
          this.waiters.push(waiter);
        }
      }
    });
    this.send({ type: "auth", token: `${DEV_TOKEN}:${this.suffix}` });
    await this.waitFor((f) => f.type === "ready");
  }

  send(frame: Frame): void {
    this.socket.send(JSON.stringify(frame));
  }

  waitFor(match: (f: Frame) => boolean, timeoutMs = 15_000): Promise<Frame> {
    const existing = this.frames.find(match);
    if (existing) {
      this.frames.splice(this.frames.indexOf(existing), 1);
      return Promise.resolve(existing);
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("timed out waiting for a frame")), timeoutMs);
      this.waiters.push({
        match,
        resolve: (frame) => {
          clearTimeout(timer);
          resolve(frame);
        },
      });
    });
  }

  /** Sends a line and answers its id. A refused line stops the capture. */
  async say(channelId: string, body: string): Promise<string> {
    const nonce = `council-${Math.random().toString(36).slice(2)}`;
    this.send({ type: "message-create", channelId, body, nonce });
    const frame = await this.waitFor(
      (f) =>
        (f.type === "message-broadcast" && f.nonce === nonce) ||
        (f.type === "message-rejected" && f.nonce === nonce),
    );
    if (frame.type === "message-rejected") {
      throw new Error(`message refused: ${String(frame.reason)}`);
    }
    return (frame.message as { id: string }).id;
  }

  react(channelId: string, messageId: string, emoji: string): void {
    this.send({ type: "reaction-toggle", channelId, messageId, emoji });
  }

  async joinVoice(voiceChannelId: string): Promise<void> {
    this.send({ type: "join-voice-room", voiceChannelId });
    await this.waitFor((f) => f.type === "welcome");
  }

  close(): void {
    this.socket?.close();
  }
}

/** Who the page is, and a returning person's furniture already put away. */
async function as(page: Page, theme: "dark" | "light"): Promise<void> {
  await page.addInitScript(
    ([suffix, value, redesign]) => {
      localStorage.setItem("pqp:dev-user-suffix", suffix);
      localStorage.setItem("pqp-theme", value);
      localStorage.setItem("pqp:download-hint-dismissed", "1");
      localStorage.setItem("pqp-redesign", redesign ? "on" : "off");
    },
    [VIEWER, theme, REDESIGN] as const,
  );
  await fetch(`${API}/api/me/preferences`, {
    method: "PATCH",
    headers: headers(VIEWER),
    body: JSON.stringify({ theme }),
  });
}

/** The dev bypass's own banner is not part of the product. */
async function hideDevBanner(page: Page): Promise<void> {
  await page.addStyleTag({
    content: `main > [class*="border-warning/30"] { display: none !important; }`,
  });
}

/** Settled: fonts in, no spinner mid-turn, no caret blinking in a shot. */
async function shoot(page: Page, name: string): Promise<void> {
  await page.evaluate(() => document.fonts.ready);
  await page.addStyleTag({ content: `* { caret-color: transparent !important; }` });
  await page.waitForTimeout(800);
  await page.mouse.move(0, 0);
  await page.screenshot({ path: path.join(OUT!, `${name}.png`) });
}

test("captures the design council screens", async ({ browser }) => {
  fs.mkdirSync(OUT!, { recursive: true });

  const ids: Record<string, string> = {};
  for (const [suffix, name, avatar] of PEOPLE) {
    ids[suffix] = await person(suffix, name, avatar);
  }

  // Three servers, so the rail looks like somebody's.
  const turma = await server(VIEWER, "Turma do Fliperama");
  const general = turma.channels.find((c) => c.type === "text")!;
  const lobby = turma.channels.find((c) => c.type === "voice")!;
  const parent = general.parentId ?? null;
  const avisos = await channel(VIEWER, turma.id, "avisos", "text", parent);
  const papo = await channel(VIEWER, turma.id, "papo", "text", parent);
  await channel(VIEWER, turma.id, "clipes", "text", parent);
  await channel(VIEWER, turma.id, "sala-do-jogo", "voice", parent);
  for (const [suffix] of PEOPLE.slice(1)) {
    await join(VIEWER, turma.id, suffix);
  }
  const rpg = await server("rafa", "Mesa de RPG");
  await join("rafa", rpg.id, VIEWER);
  await server(VIEWER, "Faculdade ADS");

  await befriend("rafa", VIEWER, ids[VIEWER]!, ids.rafa!);
  await befriend("bia", VIEWER, ids[VIEWER]!, ids.bia!);
  const { conversation } = await json<{ conversation: { channelId: string } }>(
    await fetch(`${API}/api/dms`, {
      method: "POST",
      headers: headers("rafa"),
      body: JSON.stringify({ userIds: [ids[VIEWER]] }),
    }),
  );

  // Everybody who speaks gets a socket; the online ones keep theirs.
  const sockets = new Map<string, Socket>();
  for (const [suffix] of PEOPLE) {
    const socket = new Socket(suffix);
    await socket.connect();
    sockets.set(suffix, socket);
  }
  const messageIds: string[] = [];
  for (const [suffix, body] of PAPO) {
    messageIds.push(await sockets.get(suffix)!.say(papo, body));
  }
  for (const [index, emoji, by] of REACTIONS) {
    for (const suffix of by) {
      sockets.get(suffix)!.react(papo, messageIds[index]!, emoji);
    }
  }
  for (const [suffix, body] of DM) {
    await sockets.get(suffix)!.say(conversation.channelId, body);
  }
  // The viewer has read the conversation; #avisos arrives after, as unread.
  sockets.get(VIEWER)!.close();
  for (const [suffix, body] of AVISOS) {
    await sockets.get(suffix)!.say(avisos, body);
  }
  for (const [suffix, socket] of sockets) {
    if (suffix !== VIEWER && !ONLINE.includes(suffix)) {
      socket.close();
      sockets.delete(suffix);
    }
  }

  const chatUrl = `/app/server/${turma.id}/channel/${papo}?lang=pt-BR`;

  try {
    for (const theme of ["dark", "light"] as const) {
      const context = await browser.newContext({ viewport: DESKTOP, locale: "pt-BR" });
      const page = await context.newPage();
      await as(page, theme);

      await page.goto(chatUrl);
      await expect(page.getByRole("button", { name: "Enviar" })).toBeVisible({ timeout: 30_000 });
      await expect(page.getByText(PAPO.at(-1)![1])).toBeVisible();
      await hideDevBanner(page);
      await shoot(page, `01-chat-${theme}`);
      // Message search: the prompt, then results with the arrows on one.
      try {
        await page.getByRole("button", { name: /Buscar mensagens/ }).first().click({ timeout: 5_000 });
        await expect(page.getByRole("dialog")).toBeVisible();
        await page.waitForTimeout(300);
        await shoot(page, `33-search-empty-${theme}`);
        // The pointer out of the way, so the first row keeps the highlight.
        await page.mouse.move(0, 0);
        await page.getByRole("dialog").getByRole("combobox").fill("zzqxv");
        await expect(page.getByRole("dialog").getByText(/zzqxv/).last()).toBeVisible({ timeout: 10_000 });
        await page.waitForTimeout(300);
        await shoot(page, `35-search-none-${theme}`);
        await page.getByRole("dialog").getByRole("combobox").fill("caverna");
        await expect(page.getByRole("dialog").getByRole("option").first()).toBeVisible({ timeout: 10_000 });
        await page.waitForTimeout(300);
        await shoot(page, `34-search-results-${theme}`);
        await page.keyboard.press("Escape");
      } catch (error) {
        console.log("search shots skipped", String(error).slice(0, 300));
        await page.keyboard.press("Escape");
      }
      // The sidebar header up close: the name hovered, the search entry.
      {
        const header = page.locator("[data-server-header]");
        await page.locator("[data-server-menu-trigger]").hover();
        await page.waitForTimeout(300);
        const box = (await header.boundingBox())!;
        await page.screenshot({
          path: path.join(OUT!, `s-sidebar-header-${theme}.png`),
          clip: { x: Math.max(0, box.x - 8), y: Math.max(0, box.y - 8), width: box.width + 16, height: box.height + 72 },
        });
        await page.mouse.move(0, 0);
      }
      // The conversation header up close, the pins tile hovered.
      {
        const header = page.locator("[data-chat-header]");
        await header.getByRole("button", { name: "Fixadas" }).hover();
        await page.waitForTimeout(400);
        const box = (await header.boundingBox())!;
        await page.screenshot({
          path: path.join(OUT!, `s-header-${theme}.png`),
          clip: { x: box.x, y: box.y, width: box.width, height: box.height + 48 },
        });
        await page.mouse.move(0, 0);
      }
      // The open members tile with keyboard focus: the ring sits off the fill.
      try {
        const header = page.locator("[data-chat-header]");
        await page.keyboard.press("Shift");
        await header.locator("[data-member-sidebar-toggle]").focus();
        await page.waitForTimeout(300);
        const box = (await header.boundingBox())!;
        await page.screenshot({
          path: path.join(OUT!, `s-header-focus-${theme}.png`),
          clip: { x: box.x + box.width - 260, y: box.y, width: 260, height: box.height + 8 },
        });
        await page.locator("body").focus();
      } catch {
        console.log("header focus shot skipped");
      }
      // The channel list folded to icons, in place; then unfolded again.
      await page.locator("[data-channel-sidebar-toggle]").first().click();
      await expect(page.locator("[data-channel-rail]")).toBeVisible();
      await page.waitForTimeout(300);
      await shoot(page, `20-sidebar-strip-${theme}`);
      await page.locator("[data-channel-rail-expand]").click();
      await expect(page.locator("[data-channel-rail]")).toBeHidden();
      // The status menu, open from the user panel.
      await page.locator("[data-user-panel-trigger]").first().click();
      await expect(page.getByRole("menu", { name: "Mudar o seu status" })).toBeVisible();
      await page.waitForTimeout(300);
      await shoot(page, `21-status-menu-${theme}`);
      await page.keyboard.press("Escape");
      await expect(page.getByRole("menu", { name: "Mudar o seu status" })).toBeHidden();
      // A short name, so the caret's place after the name shows.
      try {
        await page.getByRole("button", { name: /Faculdade ADS/ }).first().click({ timeout: 5_000 });
        await expect(page.locator("[data-server-name]").first()).toHaveText("Faculdade ADS", { timeout: 10_000 });
        await page.locator("[data-server-menu-trigger]").hover();
        await page.waitForTimeout(300);
        const header = page.locator("[data-server-header]");
        const box = (await header.boundingBox())!;
        await page.screenshot({
          path: path.join(OUT!, `s-sidebar-header-short-${theme}.png`),
          clip: { x: Math.max(0, box.x - 8), y: Math.max(0, box.y - 8), width: box.width + 16, height: box.height + 72 },
        });
        await page.mouse.move(0, 0);
        await page.goto(chatUrl);
        await expect(page.getByRole("button", { name: "Enviar" })).toBeVisible({ timeout: 30_000 });
        await hideDevBanner(page);
      } catch {
        console.log("short-name header shot skipped");
      }
      // A profile card, from a message author's name.
      try {
        // The newest author: the first one in the DOM may sit above the fold.
        const author = page.locator("[data-author-trigger]").last();
        await author.scrollIntoViewIfNeeded();
        await author.click({ timeout: 5_000 });
        await expect(page.locator("[data-profile-card]")).toBeVisible({ timeout: 5_000 });
        await page.waitForTimeout(800);
        await shoot(page, `36-profile-card-${theme}`);
        // Its states: a role ticked, keyboard focus on Mensagem, the pointer on Silenciar.
        try {
          const card = page.locator("[data-profile-card]");
          const mod = card.getByRole("checkbox", { name: /Mod/ }).first();
          await mod.click({ timeout: 3_000 });
          await page.waitForTimeout(600);
          await page.keyboard.press("Shift");
          await card.getByRole("button", { name: "Mensagem" }).first().focus();
          await card.getByText("Silenciar", { exact: true }).first().hover();
          await page.waitForTimeout(300);
          await shoot(page, `36-profile-card-states-${theme}`);
          await mod.click({ timeout: 3_000 });
          await page.waitForTimeout(400);
        } catch (error) {
          console.log(`profile card states shot skipped (${String(error).slice(0, 160)})`);
        }
        await page.keyboard.press("Escape");
        await page.waitForTimeout(300);
      } catch (error) {
        console.log(`profile card shot skipped (${String(error).slice(0, 160)})`);
        await page.keyboard.press("Escape");
      }
      // A popover in place: the composer's emoji picker.
      await page.getByRole("button", { name: "Adicionar emoji", exact: true }).first().click();
      await expect(page.locator(".emoji-mart-shell")).toBeVisible();
      await page.waitForTimeout(600);
      await shoot(page, `17-emoji-picker-${theme}`);
      await page.keyboard.press("Escape");
      // Escape inside the picker's own search does not always reach the
      // panel; a press outside closes it, so the menu shots show the menu alone.
      if (await page.locator(".emoji-mart-shell").isVisible()) {
        await page.getByText(PAPO[0]![1]).click();
      }
      await expect(page.locator(".emoji-mart-shell")).toBeHidden();
      // Menus in place: the server header's, then a message's right-click
      // menu with its quick-reaction strip.
      await page.locator("[data-server-menu-trigger]").first().click();
      await expect(page.locator("[data-server-menu]")).toBeVisible();
      await shoot(page, `15-server-menu-${theme}`);
      // Invites: the panel with the active links, from the same menu.
      await page.getByRole("menuitem", { name: "Convidar pessoas" }).click();
      await expect(page.getByRole("dialog")).toBeVisible();
      await page.waitForTimeout(600);
      await shoot(page, `29-invite-create-${theme}`);
      await page.keyboard.press("Escape");
      // A new server: the name step, then the Discord path.
      await page.getByRole("button", { name: "Criar comunidade" }).first().click();
      await expect(page.getByRole("dialog")).toBeVisible();
      await page.waitForTimeout(400);
      await shoot(page, `30-create-server-${theme}`);
      await page.getByRole("dialog").getByText("Copiar uma estrutura do Discord", { exact: true }).click();
      await page.waitForTimeout(300);
      await shoot(page, `31-create-server-paste-${theme}`);
      await page.keyboard.press("Escape");
      // Joining with a code.
      await page.getByRole("button", { name: "Entrar com convite" }).first().click();
      await expect(page.getByRole("dialog")).toBeVisible();
      await page.waitForTimeout(400);
      await shoot(page, `32-invite-join-${theme}`);
      await page.keyboard.press("Escape");
      await page.getByText(PAPO.at(-1)![1]).click({ button: "right" });
      await expect(page.locator("[data-context-menu]")).toBeVisible();
      await shoot(page, `16-message-menu-${theme}`);
      await page.keyboard.press("Escape");
      // A confirm dialog in place: deleting your own message.
      await page.getByText(PAPO.find(([who]) => who === VIEWER)![1]).click({ button: "right" });
      await page.getByRole("menuitem", { name: "Excluir mensagem" }).click();
      await expect(page.getByRole("dialog")).toBeVisible();
      await page.waitForTimeout(400);
      await shoot(page, `18-confirm-dialog-${theme}`);
      await page.keyboard.press("Escape");

      await page.goto(`/app/dm/${conversation.channelId}?lang=pt-BR`);
      await expect(page.getByTestId("app-chat-column").getByText(DM.at(-1)![1])).toBeVisible({ timeout: 30_000 });
      await hideDevBanner(page);
      await shoot(page, `02-dm-${theme}`);

      await page.goto(`/app/dm?lang=pt-BR`);
      await expect(page.getByText(DM.at(-1)![1]).first()).toBeVisible({ timeout: 30_000 });
      await hideDevBanner(page);
      await shoot(page, `03-home-${theme}`);
      // The communities directory, a full page over the app.
      try {
        await page.getByRole("button", { name: "Comunidades" }).first().click({ timeout: 5_000 });
        await page.waitForTimeout(1200);
        await shoot(page, `35-communities-${theme}`);
        // Every language: the unfiltered empty directory, with its one create button.
        await page.getByRole("button", { name: "Todos", exact: true }).first().click({ timeout: 3_000 }).catch(() => {});
        await page.waitForTimeout(800);
        await shoot(page, `35-communities-all-${theme}`);
        await page.keyboard.press("Escape");
        await page.waitForTimeout(300);
      } catch {
        console.log("communities shot skipped");
      }
      // Novidades: a pane of its own beside the rail.
      await page.getByRole("button", { name: /^Novidades/ }).first().click();
      await page.waitForTimeout(1200);
      await shoot(page, `18-whats-new-${theme}`);

      await page.goto(chatUrl);
      await expect(page.getByRole("button", { name: "Enviar" })).toBeVisible({ timeout: 30_000 });
      await hideDevBanner(page);
      await page.getByRole("button", { name: "Abrir configurações" }).first().click();
      await expect(page.getByRole("dialog")).toBeVisible();
      await shoot(page, `04-settings-${theme}`);
      // Game connections: the providers this host offers, or the note
      // that it offers none.
      await page.getByRole("dialog").getByText("Conexões", { exact: true }).first().click();
      await page.waitForTimeout(600);
      await shoot(page, `37-settings-connections-${theme}`);
      // The linked state, with the host's providers mocked: Steam linked with
      // a long name, Twitch and Battle.net offered.
      try {
        await page.route("**/api/connections/config", (route) =>
          route.fulfill({ json: { steam: true, battlenet: true, twitch: true } }),
        );
        await page.route("**/api/me/connections", (route) =>
          route.fulfill({
            json: {
              connections: [
                {
                  provider: "steam",
                  providerUserId: "76561198000000000",
                  displayName: "lia_joga_tudo_na_madrugada_de_domingo",
                  avatarUrl: null,
                  profileUrl: null,
                  visibility: "shared",
                  connectedAt: "2026-10-01T12:00:00.000Z",
                },
              ],
            },
          }),
        );
        await page.getByRole("dialog").getByText("Perfil", { exact: true }).first().click();
        await page.waitForTimeout(300);
        await page.getByRole("dialog").getByText("Conexões", { exact: true }).first().click();
        await expect(page.getByRole("dialog").getByText("lia_joga_tudo", { exact: false }).first()).toBeVisible({ timeout: 5_000 });
        await page.waitForTimeout(400);
        await shoot(page, `38-settings-connections-linked-${theme}`);
        await page.unroute("**/api/connections/config");
        await page.unroute("**/api/me/connections");
      } catch (error) {
        console.log("linked connections shot skipped", String(error).slice(0, 200));
      }
      // A section made of switches, for the choice controls.
      await page.getByRole("dialog").getByText("Notificações", { exact: true }).first().click();
      await expect(page.getByRole("dialog").getByRole("switch").first()).toBeVisible();
      await shoot(page, `11-settings-switches-${theme}`);
      // The theme and density pickers, for RadioGroup in place.
      await page.getByRole("dialog").getByText("Aparência e idioma", { exact: true }).first().click();
      await expect(page.getByRole("dialog").getByRole("radiogroup").first()).toBeVisible();
      await shoot(page, `12-settings-appearance-${theme}`);
      // The volume sliders, for Slider in place.
      await page.getByRole("dialog").getByText("Voz e vídeo", { exact: true }).first().click();
      await expect(page.getByRole("dialog").getByRole("slider").first()).toBeVisible();
      await shoot(page, `14-settings-voice-${theme}`);
      // An unsaved profile: the bar at the foot of the page and the dot on
      // the Perfil tab, seen from the next tab. Discarded before closing.
      await page.getByRole("dialog").getByText("Perfil", { exact: true }).first().click();
      await page.getByRole("dialog").getByLabel("Nome de exibição").fill("Lia Fliperama");
      await page.getByRole("dialog").getByText("Privacidade", { exact: true }).first().click();
      await expect(page.getByRole("button", { name: "Salvar alterações" })).toBeVisible();
      await page.waitForTimeout(400);
      await shoot(page, `25-settings-unsaved-${theme}`);
      await page.getByRole("button", { name: "Descartar" }).click();
      await page.keyboard.press("Escape");

      await page.locator("[data-server-menu-trigger]").first().click();
      await page.getByRole("menuitem", { name: "Configurações da comunidade" }).click();
      await expect(page.getByRole("dialog")).toBeVisible();
      await shoot(page, `05-server-settings-${theme}`);
      // The role editor's tabs, for Tabs in place.
      await page.getByRole("dialog").getByText("Cargos", { exact: true }).first().click();
      await expect(page.getByRole("dialog").getByRole("tablist", { name: "Nome do cargo" })).toBeVisible();
      await shoot(page, `13-server-roles-${theme}`);
      // The permission groups, for the section labels over them.
      await page.getByRole("dialog").getByRole("tab", { name: "Permissões" }).click();
      await page.waitForTimeout(300);
      await shoot(page, `13-server-roles-perms-${theme}`);
      // The audit log's entries and the danger zone's card.
      await page.getByRole("dialog").getByText("Registro", { exact: true }).first().click();
      await page.waitForTimeout(800);
      await shoot(page, `26-server-audit-${theme}`);
      await page.getByRole("dialog").getByText("Zona de risco", { exact: true }).first().click();
      await page.waitForTimeout(300);
      await shoot(page, `27-server-danger-${theme}`);
      await page.keyboard.press("Escape");
      // Channel settings, from the open channel's gear. Best effort: a
      // missing gear skips the shot instead of the screens after it.
      try {
        const gear = page.getByRole("button", { name: /Configurações do canal/ }).first();
        await gear.hover({ force: true, timeout: 5_000 });
        await gear.click({ force: true, timeout: 5_000 });
        await expect(page.getByRole("dialog")).toBeVisible({ timeout: 5_000 });
        await page.waitForTimeout(500);
        await shoot(page, `28-channel-settings-${theme}`);
        await page.keyboard.press("Escape");
      } catch {
        console.log("channel settings gear not found, shot 28 skipped");
      }
      // A voice room's header, not in the call: the "Entre na call" pill.
      // Best effort, last in the context so a join cannot touch other shots.
      try {
        await page.getByRole("button", { name: /^Lobby/ }).first().click({ timeout: 5_000 });
        const header = page.locator("[data-chat-header]");
        await expect(header.getByRole("button", { name: /Entre na call/ })).toBeVisible({ timeout: 5_000 });
        await page.waitForTimeout(400);
        const box = (await header.boundingBox())!;
        await page.screenshot({
          path: path.join(OUT!, `s-header-voice-${theme}.png`),
          clip: { x: box.x, y: box.y, width: box.width, height: box.height + 48 },
        });
      } catch {
        console.log("voice room header pill not found, s-header-voice skipped");
      }

      // Server bots: the flag on for this one shot, then back to its default.
      try {
        await fetch(`${API}/api/admin/flags`, {
          method: "PUT",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${E2E_ADMIN_TOKEN}` },
          body: JSON.stringify({ key: "custom_bots", enabled: true }),
        });
        await page.reload();
        await expect(page.getByRole("button", { name: "Enviar" })).toBeVisible({ timeout: 30_000 });
        await hideDevBanner(page);
        await page.locator("[data-server-menu-trigger]").first().click();
        await page.getByRole("menuitem", { name: "Configurações da comunidade" }).click();
        await expect(page.getByRole("dialog")).toBeVisible();
        await page.getByRole("dialog").getByText("Bots", { exact: true }).first().click({ timeout: 5_000 });
        await page.waitForTimeout(800);
        await shoot(page, `38-server-bots-${theme}`);
        // The wizard: a coral face chosen, keyboard focus on the faces; then a persona chosen.
        try {
          const dialog = page.getByRole("dialog");
          await dialog.getByRole("button", { name: /Criar meu bot/ }).click({ timeout: 5_000 });
          await dialog.getByRole("textbox").first().fill("Tico");
          await dialog.getByRole("radiogroup", { name: "Cor" }).getByRole("radio", { name: "Coral" }).click();
          const faces = dialog.getByRole("radiogroup", { name: "Cara" });
          await faces.getByRole("radio").nth(1).click();
          await page.keyboard.press("ArrowRight");
          await page.keyboard.press("ArrowLeft");
          await page.waitForTimeout(300);
          await shoot(page, `38-server-bots-wizard-${theme}`);
          await dialog.getByRole("button", { name: "Continuar" }).click({ timeout: 5_000 });
          await dialog.getByRole("button", { name: /^Zoeiro/ }).click({ timeout: 5_000 });
          await page.waitForTimeout(300);
          await shoot(page, `38-server-bots-persona-${theme}`);
        } catch (error) {
          console.log("bots wizard shot skipped", String(error).slice(0, 300));
        }
        // The overview: a bot made through the API, shot, then removed so the
        // next theme's intro shot still finds no bot.
        let botId: string | null = null;
        try {
          const made = await fetch(`${API}/api/servers/${turma.id}/bots`, {
            method: "POST",
            headers: headers(VIEWER),
            body: JSON.stringify({ name: "Tico", color: "coral", face: "curioso", tagline: "Pergunte qualquer coisa", answerToName: true }),
          });
          const body = (await made.json()) as { bot?: { id: string }; id?: string };
          botId = body.bot?.id ?? body.id ?? null;
          await page.keyboard.press("Escape");
          await page.keyboard.press("Escape");
          await page.reload();
          await expect(page.getByRole("button", { name: "Enviar" })).toBeVisible({ timeout: 30_000 });
          await hideDevBanner(page);
          await page.locator("[data-server-menu-trigger]").first().click();
          await page.getByRole("menuitem", { name: "Configurações da comunidade" }).click();
          await page.getByRole("dialog").getByText("Bots", { exact: true }).first().click({ timeout: 5_000 });
          await page.waitForTimeout(1200);
          await shoot(page, `38-server-bots-overview-${theme}`);
        } catch (error) {
          console.log("bots overview shot skipped", String(error).slice(0, 300));
        } finally {
          if (botId) {
            await fetch(`${API}/api/servers/${turma.id}/bots/${botId}`, { method: "DELETE", headers: headers(VIEWER) });
          }
        }
        await page.keyboard.press("Escape");
      } catch (error) {
        console.log("bots shot skipped", String(error).slice(0, 300));
        await page.keyboard.press("Escape");
      } finally {
        await fetch(`${API}/api/admin/flags`, {
          method: "PUT",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${E2E_ADMIN_TOKEN}` },
          body: JSON.stringify({ key: "custom_bots", enabled: null }),
        });
      }

      await context.close();
    }

    // The call: the viewer joins from the browser, then three friends by
    // socket. In that order: a mesh join waits on peers already seated, and a
    // socket peer has no media to answer with.
    const context = await browser.newContext({
      viewport: DESKTOP,
      locale: "pt-BR",
      permissions: ["microphone"],
    });
    const page = await context.newPage();
    await as(page, "dark");
    await page.goto(chatUrl);
    await expect(page.getByRole("button", { name: "Enviar" })).toBeVisible({ timeout: 30_000 });
    await hideDevBanner(page);
    await page.getByRole("button", { name: /^Lobby/ }).first().dblclick();
    await expect(page.getByText("Na call", { exact: true })).toBeVisible({ timeout: 30_000 });
    for (const suffix of IN_CALL) {
      await sockets.get(suffix)!.joinVoice(lobby.id);
    }
    await page.waitForTimeout(3000);
    await shoot(page, "06-call-audio-dark");
    await page.getByRole("button", { name: "Ligar a câmera", exact: true }).first().click();
    await expect(page.locator('[data-testid="call-stage"] video').first()).toBeVisible({
      timeout: 20_000,
    });
    await page.waitForTimeout(2000);
    await shoot(page, "07-call-camera-dark");
    // f-call: the dock alone, the stage open with a camera and with audio
    // only, and the overflow menu, in both looks. The theme flips in place:
    // a second join would cost the three socket friends their seats.
    for (const theme of ["dark", "light"] as const) {
      await page.evaluate((value) => {
        document.documentElement.dataset.theme = value;
      }, theme);
      await page.waitForTimeout(500);
      const dock = page.locator("[data-call-dock]").first();
      if (await dock.isVisible().catch(() => false)) {
        await page.mouse.move(0, 0);
        await dock.screenshot({ path: path.join(OUT!, `f-call-dock-${theme}.png`) });
      }
      // With a camera on the stage is open: the menu over it, the stage
      // itself, then fullscreen, where the bar floats on the picture.
      await page.getByTestId("call-more").first().click();
      await expect(page.getByRole("menu")).toBeVisible();
      await shoot(page, `f-call-menu-${theme}`);
      await page.keyboard.press("Escape");
      await shoot(page, `f-call-stage-camera-${theme}`);
      await page.getByTestId("call-more").first().click({ timeout: 5_000 }).catch(() => {});
      const full = page.getByRole("menuitem", { name: "Tela cheia" });
      if (await full.isVisible().catch(() => false)) {
        await full.click();
        await page.waitForTimeout(1000);
        await page.mouse.move(700, 400);
        await page.waitForTimeout(300);
        await page.screenshot({ path: path.join(OUT!, `f-call-fullscreen-${theme}.png`) });
        await page.keyboard.press("Escape");
        await page.waitForTimeout(800);
      } else {
        console.log("f-call: fullscreen skipped");
        await page.keyboard.press("Escape");
      }
      // Audio only: the camera off, then the stage opened by hand.
      await page.getByRole("button", { name: "Desligar a câmera", exact: true }).first().click({ timeout: 5_000 }).catch(() => {});
      await page.waitForTimeout(1200);
      await page.getByTestId("call-more").first().click();
      // The stage may stay open after the camera goes off; open it if not.
      const expand = page.getByRole("menuitem", { name: "Expandir a call" });
      if (await expand.isVisible().catch(() => false)) {
        await expand.click();
      } else {
        await page.keyboard.press("Escape");
      }
      await page.waitForTimeout(800);
      await shoot(page, `f-call-stage-audio-${theme}`);
      await page.getByRole("button", { name: "Ligar a câmera", exact: true }).first().click({ timeout: 5_000 }).catch(() => {});
      await page.waitForTimeout(1500);
    }
    await page.getByRole("button", { name: "Sair da call" }).first().click().catch(() => {});
    await context.close();

    // A phone, the same conversation.
    const phone = await browser.newContext({
      viewport: PHONE,
      locale: "pt-BR",
      isMobile: true,
      hasTouch: true,
      deviceScaleFactor: 2,
    });
    const phonePage = await phone.newPage();
    await as(phonePage, "dark");
    await phonePage.goto(chatUrl);
    await expect(phonePage.getByText(PAPO.at(-1)![1])).toBeVisible({ timeout: 30_000 });
    await hideDevBanner(phonePage);
    await shoot(phonePage, "08-phone-chat-dark");
    // The drawer open: the sidebar header with its close button.
    await phonePage.getByRole("button", { name: "Abrir navegação" }).first().click();
    await phonePage.waitForTimeout(800);
    await shoot(phonePage, "08-phone-drawer-dark");
    // Close the drawer: reload the conversation before the sheet.
    await phonePage.goto(chatUrl);
    await expect(phonePage.getByText(PAPO.at(-1)![1])).toBeVisible({ timeout: 30_000 });
    await hideDevBanner(phonePage);
    // A sheet: below `sm` a dialog rises from the bottom edge.
    for (const theme of ["dark", "light"] as const) {
      if (theme === "light") {
        await as(phonePage, "light");
        await phonePage.goto(chatUrl);
        await expect(phonePage.getByText(PAPO.at(-1)![1])).toBeVisible({ timeout: 30_000 });
        await hideDevBanner(phonePage);
      }
      await phonePage.getByText(PAPO.find(([who]) => who === VIEWER)![1]).click({ button: "right" });
      await phonePage.getByRole("menuitem", { name: "Excluir mensagem" }).click();
      await expect(phonePage.getByRole("dialog")).toBeVisible();
      await phonePage.waitForTimeout(500);
      await shoot(phonePage, `19-phone-sheet-${theme}`);
      await phonePage.keyboard.press("Escape");
    }
    // Settings on a phone: the rail is a strip of tabs over the page.
    await as(phonePage, "dark");
    await phonePage.goto(chatUrl);
    await expect(phonePage.getByText(PAPO.at(-1)![1])).toBeVisible({ timeout: 30_000 });
    await hideDevBanner(phonePage);
    await phonePage.getByRole("button", { name: "Abrir navegação" }).first().click();
    await phonePage.waitForTimeout(500);
    await phonePage.getByRole("button", { name: "Abrir configurações" }).first().click();
    await expect(phonePage.getByRole("dialog")).toBeVisible();
    await phonePage.waitForTimeout(500);
    await shoot(phonePage, "24-phone-settings-dark");
    await phone.close();
  } finally {
    for (const socket of sockets.values()) {
      socket.close();
    }
  }
});

/**
 * The primitives, one focused shot each, off the token sheet (`/qa/ui`). A
 * primitive's states are drawn side by side there; the shot adds a hovered
 * and a keyboard-focused one, which a static sheet cannot show. Context shots
 * are the screens above, where the primitive is used.
 */
const PRIMITIVES: {
  id: string;
  testId: string;
  hover?: string;
  /** Hover the element holding this text (a row with no button role). */
  hoverText?: string;
  /** Click this button first (opens a disclosure), by its name's start. */
  click?: string;
  focus?: string;
  /** The role the hover and focus targets have. Buttons by default. */
  role?: "button" | "textbox" | "combobox" | "checkbox" | "radio" | "tab" | "slider";
  /**
   * A button that opens a menu: the shot opens it, moves the highlight
   * `arrows` rows down with the keyboard, and frames the block and the menu.
   * `hoverText` first hovers the text it names, for a button that only shows
   * on hover (a message's toolbar).
   */
  open?: { button: string; menu: string; arrows: number; hoverText?: string };
  /** A tall block, cut into shots this tall (`<id>-<n>-<theme>.png`). */
  tiles?: number;
}[] = [
  {
    id: "p-button",
    testId: "qa-primitive-button",
    hover: "secondary default",
    focus: "default default",
  },
  {
    id: "p-icon-button",
    testId: "qa-primitive-icon-button",
    hover: "Remover md",
    focus: "Remover lg",
  },
  // A static specimen: every bubble at once, no hover needed.
  { id: "p-tooltip", testId: "qa-primitive-tooltip" },
  { id: "p-input", testId: "qa-primitive-input", focus: "Padrão", role: "textbox", hover: "Preenchido" },
  { id: "p-select", testId: "qa-primitive-select", focus: "md", role: "combobox", hover: "sm" },
  {
    id: "p-checkbox",
    testId: "qa-primitive-checkbox",
    role: "checkbox",
    hover: "Gerenciar canais",
    focus: "Permitir comentários",
  },
  // Two panels in place: a note with actions, and a picker grid.
  { id: "p-popover", testId: "qa-primitive-popover" },
  // A note that arrived and a session reminder; the close button focused.
  { id: "p-toast", testId: "qa-primitive-toast", focus: "Fechar" },
  // Focus the checked segment, hover an unchecked chip (the first of each
  // name: the small groups repeat the labels).
  { id: "p-radio", testId: "qa-primitive-radio", role: "radio", focus: "Escuro", hover: "Menções" },
  // Focus the selected underline tab, hover an unselected pill.
  { id: "p-tabs", testId: "qa-primitive-tabs", role: "tab", focus: "Visão geral", hover: "Todos" },
  // A card on a pane and inside a dialog surface; no interaction.
  { id: "p-card", testId: "qa-primitive-card", hover: "Microfone liberado" },
  // Monograms with presence, dimmed, a bot and a stack; no interaction.
  { id: "p-avatar", testId: "qa-primitive-avatar" },
  // Status words, the tags beside a name, and counts; no interaction.
  { id: "p-badge", testId: "qa-primitive-badge" },
  { id: "p-scroll", testId: "qa-primitive-scroll" },
  { id: "p-empty", testId: "qa-primitive-empty", hover: "Copiar convite" },
  { id: "p-loading", testId: "qa-primitive-loading" },
  { id: "p-section-header", testId: "qa-primitive-section-header" },
  // Focus a person row, hover a plain channel.
  { id: "p-list-row", testId: "qa-primitive-list-row", focus: "Bia", hover: "geral" },
  // Opened from the keyboard, the highlight on "Só menções" (its detail line).
  { id: "p-menu", testId: "qa-primitive-menu", open: { button: "Abrir menu", menu: "[data-server-menu]", arrows: 1 } },
  // Hovering the scrub shows its thumb; the volume is keyboard-focused.
  { id: "p-slider", testId: "qa-primitive-slider", focus: "Volume", role: "slider", hover: "Scrub" },
  // Focus the connection strip's main action, hover the error's dismiss.
  { id: "p-banner", testId: "qa-primitive-banner", focus: "Tentar agora", hover: "Dispensar" },
  // Two real rails: Conversas open with people waiting, and a server open
  // beside every server cue. Keyboard focus on "Praça", hover on "Oficina".
  { id: "s-rail", testId: "qa-shell-rail", focus: "Praça", hover: "Oficina" },
  // The music queue open in a call's composer; hover a waiting song.
  // The history open, a queue row hovered.
  { id: "m-sheets", testId: "qa-music-queue", click: "Tocadas", hoverText: "Gal Costa - Vapor Barato" },
  { id: "f-apps", testId: "qa-apps" },
  { id: "p-settings-kit", testId: "qa-settings-kit", tiles: 1300 },
  { id: "p-settings-kit", testId: "qa-settings-kit", tiles: 1300 },
  // Two real rails: Conversas open with people waiting, and a server open
  // beside every server cue. Keyboard focus on "Praça", hover on "Oficina".
  { id: "s-rail", testId: "qa-shell-rail", focus: "Praça", hover: "Oficina" },
  { id: "s-sidebar-special", testId: "qa-shell-sidebar-special" },
  { id: "s-category", testId: "qa-shell-categories", focus: "Jogos da semana", hover: "Bate-papo" },
  { id: "s-channel-row", testId: "qa-shell-channel-rows", focus: "general", hover: "clipes" },
  { id: "s-voice-row", testId: "qa-shell-voice-rows" },
  // The icons-only sidebar: hover on "general".
  { id: "s-sidebar-rail", testId: "qa-shell-sidebar-strip", focus: "clipes", hover: "general" },
  // The voice strip in its states.
  { id: "s-voice-strip", testId: "qa-shell-voice-strip", focus: "Sair da call" },
  // The user panel: hover on the settings gear of the first.
  { id: "s-user-panel", testId: "qa-shell-user-panel", hover: "Abrir configurações" },
  { id: "s-banners", testId: "qa-shell-banners" },
  // Directory cards: joined, with a banner, plain, and the skeleton.
  { id: "f-communities", testId: "qa-community-cards" },
  // Message rows in their states.
  { id: "s-message-row", testId: "qa-shell-message-rows", hoverText: "@lia cê vem?" },
  { id: "f-onboarding", testId: "qa-onboarding", focus: "Entendi" },
  { id: "s-message-content", testId: "qa-shell-message-content" },
  // The boot shell and the cannot-reach-the-API page, in desktop frames.
  { id: "f-states", testId: "qa-shell-states", focus: "Tentar de novo" },
  // Bia's reply hovered, its toolbar up and "Mais" open.
  {
    id: "s-message-chrome",
    testId: "qa-shell-message-chrome",
    open: { button: "Mais", menu: '[role="menu"][aria-label="Mais"]', arrows: 0, hoverText: "eu topo, levo o lanche" },
  },
  // Ten reactions that wrap over a thread chip; the one-line continuation hovered.
  { id: "s-message-chrome-wrap", testId: "qa-shell-message-chrome-wrap", hoverText: "quem chegar depois das 20h fica de fora" },
  { id: "s-log-chrome", testId: "qa-shell-log-chrome" },
  // The resting composer's format bar open (it is a toolbar, not a menu).
  {
    id: "s-composer",
    testId: "qa-shell-composer",
    open: { button: "Formatação", menu: '[data-testid="qa-shell-composer"] [role="toolbar"]', arrows: 0 },
  },
  { id: "s-member-list", testId: "qa-shell-member-list", hover: "Mensagem: Duda" },
];

test("captures the primitives", async ({ browser }) => {
  fs.mkdirSync(OUT!, { recursive: true });
  for (const theme of ["dark", "light"] as const) {
    const context = await browser.newContext({
      viewport: { width: 1280, height: 900 },
      locale: "pt-BR",
    });
    const page = await context.newPage();
    await page.addInitScript(
      ([value, redesign]) => {
        localStorage.setItem("pqp-theme", value);
        localStorage.setItem("pqp-redesign", redesign ? "on" : "off");
      },
      [theme, REDESIGN] as const,
    );
    await page.goto("/qa/ui?lang=pt-BR");
    for (const primitive of PRIMITIVES) {
      const block = page.getByTestId(primitive.testId);
      await block.scrollIntoViewIfNeeded();
      await page.evaluate(() => document.fonts.ready);
      if (primitive.focus) {
        // A keyboard focus, so `focus-visible` draws the ring.
        await block.getByRole(primitive.role ?? "button", { name: primitive.focus, exact: true }).first().focus();
        await page.keyboard.press("Shift+Tab");
        await page.keyboard.press("Tab");
      }
      if (primitive.click) {
        await block.getByRole("button", { name: primitive.click }).first().click();
      }
      if (primitive.hover) {
        await block.getByRole(primitive.role ?? "button", { name: primitive.hover, exact: true }).first().hover();
      }
      if (primitive.hoverText) {
        await block.getByText(primitive.hoverText, { exact: true }).first().hover();
      }
      if (primitive.open) {
        if (primitive.open.hoverText) {
          await block.getByText(primitive.open.hoverText, { exact: true }).hover();
        }
        await block.getByRole("button", { name: primitive.open.button, exact: true }).first().focus();
        await page.keyboard.press("Enter");
        const menu = page.locator(primitive.open.menu);
        await expect(menu).toBeVisible();
        for (let i = 0; i < primitive.open.arrows; i++) await page.keyboard.press("ArrowDown");
        await page.waitForTimeout(300);
        const a = (await block.boundingBox())!;
        const b = (await menu.boundingBox())!;
        const x = Math.min(a.x, b.x) - 16;
        const y = Math.min(a.y, b.y) - 16;
        await page.screenshot({
          path: path.join(OUT!, `${primitive.id}-${theme}.png`),
          clip: {
            x,
            y,
            width: Math.max(a.x + a.width, b.x + b.width) + 16 - x,
            height: Math.max(a.y + a.height, b.y + b.height) + 16 - y,
          },
        });
        await page.keyboard.press("Escape");
        continue;
      }
      await page.waitForTimeout(300);
      if (primitive.tiles) {
        const box = (await block.boundingBox())!;
        const top = box.y + (await page.evaluate(() => window.scrollY));
        for (let n = 0, y = 0; y < box.height; n++, y += primitive.tiles) {
          await page.screenshot({
            path: path.join(OUT!, `${primitive.id}-${n + 1}-${theme}.png`),
            fullPage: true,
            clip: { x: box.x, y: top + y, width: box.width, height: Math.min(primitive.tiles, box.height - y) },
          });
        }
        continue;
      }
      await block.screenshot({ path: path.join(OUT!, `${primitive.id}-${theme}.png`) });
    }
    await context.close();
  }
});

/**
 * A forum post open beside its list: the header's icon buttons (expand,
 * close) in context. Last, so its server is not in the other scenes' rail.
 */
/**
 * f-stories: the stories flag on for one server, two friends with a text
 * story each. The strip in the sidebar, a story open, and the composer.
 * The viewer and the composer are dark in every theme by design.
 */
test("captures the stories", async ({ browser }) => {
  fs.mkdirSync(OUT!, { recursive: true });
  await person(VIEWER, "Lia", PRESET(4));
  await person("rafa", "Rafa", PRESET(1));
  await person("bia", "Bia", null);
  const home = await server(VIEWER, "Turma dos stories");
  await join(VIEWER, home.id, "rafa");
  await join(VIEWER, home.id, "bia");
  const flag = await fetch(`${API}/api/admin/flag-overrides`, {
    method: "PUT",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${ADMIN_TOKEN}` },
    body: JSON.stringify({ key: "stories", serverId: home.id, enabled: true }),
  });
  expect(flag.status).toBe(200);
  for (const [who, text, background] of [
    ["rafa", "bora de cs hoje?", "grape"],
    ["bia", "alguém viu meu fone?", "ocean"],
  ] as const) {
    const res = await fetch(`${API}/api/stories`, {
      method: "POST",
      headers: headers(who),
      body: JSON.stringify({
        kind: "text",
        text,
        background,
        audiences: { serverIds: [home.id] },
        publish: true,
      }),
    });
    if (!res.ok) {
      console.log(`f-stories: story refused ${res.status} ${await res.text()}`);
    }
  }
  const text = home.channels.find((channel) => channel.type === "text")!;

  // The strip in both themes first, so Rafa is unseen in both.
  for (const theme of ["dark", "light"] as const) {
    const context = await browser.newContext({ viewport: DESKTOP, locale: "pt-BR" });
    const page = await context.newPage();
    await as(page, theme);
    await page.goto(`/app/server/${home.id}/channel/${text.id}?lang=pt-BR`);
    await expect(page.getByRole("button", { name: "Enviar" })).toBeVisible({ timeout: 30_000 });
    await hideDevBanner(page);
    await expect(page.getByRole("button", { name: /^Story de Rafa/ })).toBeVisible({ timeout: 20_000 });
    await page.waitForTimeout(600);
    await shoot(page, `f-stories-strip-${theme}`);
    await context.close();
  }

  for (const theme of ["dark", "light"] as const) {
    const context = await browser.newContext({ viewport: DESKTOP, locale: "pt-BR" });
    const page = await context.newPage();
    await as(page, theme);
    await page.goto(`/app/server/${home.id}/channel/${text.id}?lang=pt-BR`);
    await expect(page.getByRole("button", { name: "Enviar" })).toBeVisible({ timeout: 30_000 });
    await hideDevBanner(page);
    try {
      const ring = page.getByRole("button", { name: /^Story de Rafa/ });
      await expect(ring).toBeVisible({ timeout: 20_000 });
      await page.waitForTimeout(600);
      await ring.click();
      await expect(page.locator("[data-story-viewer]")).toBeVisible({ timeout: 10_000 });
      await page.waitForTimeout(900);
      await shoot(page, `f-stories-viewer-${theme}`);
      await page.keyboard.press("Escape");
      // States, after the viewer closed so Rafa is seen in both themes:
      // keyboard focus on Bia's ring (new), Rafa's seen ring at rest beside
      // it, the pointer on "Ver todos".
      await page.waitForTimeout(600);
      // Tab out and back so focus-visible matches, and shoot here because
      // shoot() parks the pointer, which would drop the hover.
      const bia = page.getByRole("button", { name: /^Story de Bia/ });
      await bia.focus();
      await page.keyboard.press("Tab");
      await page.keyboard.press("Shift+Tab");
      await page.evaluate(() => document.fonts.ready);
      await page.locator("[data-story-see-all]").first().hover();
      await page.waitForTimeout(800);
      await page.screenshot({ path: path.join(OUT!, `f-stories-states-${theme}.png`) });
      await page.mouse.move(0, 0);
      await page.waitForTimeout(500);
      await page.locator("[data-server-menu-trigger]").first().click();
      await page.getByRole("menuitem", { name: "Postar story" }).click();
      await page.waitForTimeout(900);
      await shoot(page, `f-stories-composer-${theme}`);
      await page.keyboard.press("Escape");
    } catch (error) {
      console.log(`f-stories: skipped (${String(error).slice(0, 200)})`);
    }
    await context.close();
  }
});

/**
 * f-watch-party: a host makes a party, schedules it, goes live; a member sees
 * the sidebar's live block. One server per look, since a server holds one
 * party at a time. CI has no egress, so live HLS is answered on for this
 * page (the same substitution `watch-party.spec.ts` makes) and the build flag
 * comes from `?watchParty=1`.
 */
test("captures the watch party", async ({ browser }) => {
  fs.mkdirSync(OUT!, { recursive: true });
  await person(VIEWER, "Lia", PRESET(4));
  await person("rafa", "Rafa", PRESET(1));
  for (const theme of ["dark", "light"] as const) {
    const home = await server(VIEWER, theme === "dark" ? "Cineclube" : "Cineclube claro");
    await join(VIEWER, home.id, "rafa");
    const text = home.channels.find((channel) => channel.type === "text")!;
    const url = `/app/server/${home.id}/channel/${text.id}?lang=pt-BR&watchParty=1`;
    const hlsOn = async (page: Page) => {
      await page.route("**/api/live-hls/config*", async (route) => {
        const response = await route.fetch();
        const body = (await response.json()) as Record<string, unknown>;
        await route.fulfill({ response, json: { ...body, enabled: true } });
      });
    };

    const context = await browser.newContext({ viewport: DESKTOP, locale: "pt-BR" });
    const page = await context.newPage();
    await as(page, theme);
    await hlsOn(page);
    await page.goto(url);
    await expect(page.getByRole("button", { name: "Enviar" })).toBeVisible({ timeout: 30_000 });
    await hideDevBanner(page);
    try {
      await page.locator("[data-live-party-create]").click({ timeout: 10_000 });
      await page.locator("[data-create-watch-party-name]").fill("Sessão coruja");
      await shoot(page, `f-watch-party-create-${theme}`);
      await page.locator("[data-create-watch-party-schedule]").click();
      await page.waitForTimeout(300);
      await shoot(page, `f-watch-party-create-scheduled-${theme}`);
      await page.locator("[data-create-watch-party-submit]").click();
      await expect(page.getByTestId("watch-party-scheduled")).toBeVisible({ timeout: 20_000 });
      await shoot(page, `f-watch-party-scheduled-${theme}`);
      await page.locator("[data-watch-party-go-live]").first().click();
      await expect(page.getByTestId("watch-party-bar")).toBeVisible({ timeout: 20_000 });
      await page.waitForTimeout(800);
      await shoot(page, `f-watch-party-host-${theme}`);

      const member = await browser.newContext({ viewport: DESKTOP, locale: "pt-BR" });
      const memberPage = await member.newPage();
      await memberPage.addInitScript(
        ([value, redesign]) => {
          localStorage.setItem("pqp:dev-user-suffix", "rafa");
          localStorage.setItem("pqp-theme", value);
          localStorage.setItem("pqp:download-hint-dismissed", "1");
          localStorage.setItem("pqp-redesign", redesign ? "on" : "off");
        },
        [theme, REDESIGN] as const,
      );
      await fetch(`${API}/api/me/preferences`, {
        method: "PATCH",
        headers: headers("rafa"),
        body: JSON.stringify({ theme }),
      });
      await hlsOn(memberPage);
      await memberPage.goto(url);
      await expect(memberPage.getByRole("button", { name: "Enviar" })).toBeVisible({ timeout: 30_000 });
      await hideDevBanner(memberPage);
      const block = memberPage.getByTestId("live-party-block");
      await expect(block).toBeVisible({ timeout: 20_000 });
      await shoot(memberPage, `f-watch-party-member-${theme}`);
      await block.screenshot({ path: path.join(OUT!, `f-watch-party-block-${theme}.png`) });
      await member.close();
    } catch (error) {
      console.log(`f-watch-party: skipped (${String(error).slice(0, 200)})`);
    }
    await context.close();
  }
});

test("captures the forum post", async ({ browser }) => {
  fs.mkdirSync(OUT!, { recursive: true });
  await person(VIEWER, "Lia", PRESET(4));
  await person("rafa", "Rafa", PRESET(1));
  const home = await server(VIEWER, "Oficina");
  const flag = await fetch(`${API}/api/admin/flag-overrides`, {
    method: "PUT",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${ADMIN_TOKEN}` },
    body: JSON.stringify({ key: "forum_channels", serverId: home.id, enabled: true }),
  });
  expect(flag.status).toBe(200);
  const { channel: forum } = await json<{ channel: { id: string } }>(
    await fetch(`${API}/api/servers/${home.id}/channels`, {
      method: "POST",
      headers: headers(VIEWER),
      body: JSON.stringify({ name: "ajuda", type: "forum" }),
    }),
  );
  // f-forum: tags, and a few more posts from a second person, so the list,
  // compact and gallery layouts have something to lay out.
  await join(VIEWER, home.id, "rafa");
  const { tags } = await json<{ tags: { id: string; name: string }[] }>(
    await fetch(`${API}/api/channels/${forum.id}/forum-tags`, {
      method: "PUT",
      headers: headers(VIEWER),
      body: JSON.stringify({
        tags: [
          { name: "Bug", emoji: "🐛", moderated: false },
          { name: "Dúvida", emoji: null, moderated: false },
          { name: "Ideia", emoji: "💡", moderated: false },
        ],
      }),
    }),
  );
  const tag = Object.fromEntries(tags.map((entry) => [entry.name, entry.id]));
  for (const [who, title, body, tagName] of [
    ["rafa", "Dá pra mudar o atalho do push-to-talk?", "Queria usar o botão lateral do mouse.", "Dúvida"],
    ["rafa", "Modo escuro mais escuro, tipo OLED", "Preto puro no fundo economiza bateria no celular.", "Ideia"],
    [VIEWER, "O áudio some quando alguém compartilha a tela", "Acontece no app do Windows. No navegador fica normal.", "Bug"],
  ] as const) {
    await json(
      await fetch(`${API}/api/channels/${forum.id}/posts`, {
        method: "POST",
        headers: headers(who),
        body: JSON.stringify({
          title,
          body,
          tagIds: [tag[tagName]],
          nonce: `council-forum-${title.length}`,
        }),
      }),
    );
  }

  for (const theme of ["dark", "light"] as const) {
    const context = await browser.newContext({ viewport: DESKTOP, locale: "pt-BR" });
    const page = await context.newPage();
    await as(page, theme);
    await page.goto(`/app/server/${home.id}/channel/${forum.id}?lang=pt-BR`);
    await hideDevBanner(page);
    await expect(page.locator("[data-forum-pane]")).toBeVisible({ timeout: 30_000 });
    // The roster takes the width the post would sit in; without it the post
    // opens beside the list, with its expand and close buttons.
    const roster = page.locator("[data-member-sidebar-toggle]");
    if ((await roster.count()) && (await roster.first().getAttribute("aria-pressed")) === "true") {
      await roster.first().click();
    }
    // f-forum: the list in each layout, an empty filter and the composer.
    const layouts = page.locator("[data-forum-layout-switch]");
    for (const [label, name] of [["Cartões", "card"], ["Compacto", "compact"], ["Galeria", "gallery"]] as const) {
      if (await layouts.isVisible().catch(() => false)) {
        await layouts.getByRole("radio", { name: label }).click();
        await page.waitForTimeout(400);
        await shoot(page, `f-forum-${name}-${theme}`);
      } else {
        console.log("f-forum: layout switch skipped");
      }
    }
    if (await layouts.isVisible().catch(() => false)) {
      await layouts.getByRole("radio", { name: "Cartões" }).click();
    }
    const resolved = page.getByRole("radio", { name: "Resolvidos" }).or(page.getByRole("tab", { name: "Resolvidos" })).first();
    if (await resolved.isVisible().catch(() => false)) {
      await resolved.click();
      await page.waitForTimeout(400);
      await shoot(page, `f-forum-empty-${theme}`);
      await page.getByRole("radio", { name: "Todos" }).or(page.getByRole("tab", { name: "Todos" })).first().click();
    }
    // States: the pointer on the first card, keyboard focus on a filter.
    // `shoot` parks the mouse, so this one is a plain screenshot.
    try {
      await page.keyboard.press("Shift");
      await page.getByRole("radio", { name: "Abertos" }).or(page.getByRole("tab", { name: "Abertos" })).first().focus();
      await page.getByRole("link", { name: /Modo escuro/ }).first().hover();
      await page.waitForTimeout(400);
      await page.screenshot({ path: path.join(OUT!, `f-forum-states-${theme}.png`) });
    } catch (error) {
      console.log(`f-forum: states skipped (${String(error).slice(0, 120)})`);
    }
    try {
      await page.getByRole("button", { name: "Novo post" }).first().click();
      await expect(page.getByRole("dialog")).toBeVisible({ timeout: 5_000 });
      await page.waitForTimeout(400);
      await shoot(page, `f-forum-composer-${theme}`);
      await page.keyboard.press("Escape");
      await page.waitForTimeout(300);
    } catch (error) {
      console.log(`f-forum: composer skipped (${String(error).slice(0, 120)})`);
    }
    await page.getByRole("link", { name: /O áudio some/ }).click();
    const panel = page.locator("[data-forum-post-panel]");
    await expect(panel).toBeVisible({ timeout: 15_000 });
    await shoot(page, `09-forum-post-${theme}`);
    // Tooltips in context: an icon button's bubble over the post, then the
    // rail's larger bubble. `shoot` parks the mouse, so hover after it.
    await page.getByRole("button", { name: "Abrir em tela cheia", exact: true }).hover();
    await page.waitForTimeout(600);
    await page.screenshot({ path: path.join(OUT!, `10-tooltip-post-${theme}.png`) });
    await page.getByRole("button", { name: "Criar comunidade", exact: true }).first().hover();
    await page.waitForTimeout(600);
    await page.screenshot({ path: path.join(OUT!, `10-tooltip-rail-${theme}.png`) });
    await context.close();
  }
});

/**
 * The stories strip above the channels (`s-sidebar-special`): my own ring and
 * a friend's new story. Its own server, so the other scenes stay as they were.
 */
test("captures the stories strip", async ({ browser }) => {
  fs.mkdirSync(OUT!, { recursive: true });
  await person(VIEWER, "Lia", PRESET(4));
  await person("bia", "Bia", null);
  const home = await server(VIEWER, "Cineclube");
  await join(VIEWER, home.id, "bia");
  const flag = await fetch(`${API}/api/admin/flag-overrides`, {
    method: "PUT",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${ADMIN_TOKEN}` },
    body: JSON.stringify({ key: "stories", serverId: home.id, enabled: true }),
  });
  expect(flag.status).toBe(200);
  for (const [suffix, text] of [
    [VIEWER, "sessão hoje às 20h"],
    ["bia", "trouxe pipoca"],
  ] as const) {
    const story = await fetch(`${API}/api/stories`, {
      method: "POST",
      headers: headers(suffix),
      body: JSON.stringify({ kind: "text", text, background: "night", audiences: { serverIds: [home.id] } }),
    });
    expect(story.status).toBe(201);
  }
  const text = home.channels.find((c) => c.type === "text")!;

  for (const theme of ["dark", "light"] as const) {
    const context = await browser.newContext({ viewport: DESKTOP, locale: "pt-BR" });
    const page = await context.newPage();
    await as(page, theme);
    await page.goto(`/app/server/${home.id}/channel/${text.id}?lang=pt-BR`);
    const strip = page.locator(`[data-story-strip="server:${home.id}"]`);
    await expect(strip.locator("[data-story-ring]")).toHaveCount(2, { timeout: 30_000 });
    await hideDevBanner(page);
    await page.evaluate(() => document.fonts.ready);
    await page.waitForTimeout(1200);
    await page.mouse.move(0, 0);
    const box = (await strip.boundingBox())!;
    await page.screenshot({
      path: path.join(OUT!, `s-sidebar-stories-${theme}.png`),
      clip: { x: Math.max(0, box.x - 24), y: Math.max(0, box.y - 112), width: box.width + 48, height: box.height + 200 },
    });
    await context.close();
  }
});

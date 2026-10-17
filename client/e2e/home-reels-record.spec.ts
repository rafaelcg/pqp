import {
  expect,
  test,
  type Browser,
  type BrowserContext,
  type CDPSession,
  type Page,
} from "@playwright/test";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Records the real-app loops and stills on the flagship homepage
 * (`client/public/media/home/`).
 *
 * NOT A TEST. Skipped unless `HOME_REELS_DIR` names a working directory for
 * the raw takes, like `bau-demo-record.spec.ts`. It lives here because it
 * needs the dev-bypass identities and a running API + Vite pair.
 *
 * Run it against its OWN API and Vite, started by hand with no feature flags,
 * so the footage shows only what production ships. The Playwright webServer
 * pair turns communities, Baú and the waitlist on, so never let it start:
 *
 *   createdb -h localhost -U pqp pqp_reels          # once; any empty database
 *   PORT=3101 DATABASE_URL=postgresql://pqp:pqp@localhost:5432/pqp_reels \
 *     DEV_AUTH_BYPASS=true NODE_ENV=development DEV_SEED=false \
 *     RATE_LIMIT_API_CAPACITY=10000 RATE_LIMIT_API_REFILL=1000 \
 *     RATE_LIMIT_WRITE_CAPACITY=10000 RATE_LIMIT_WRITE_REFILL=1000 \
 *     RATE_LIMIT_WS_MESSAGE_CAPACITY=10000 RATE_LIMIT_WS_MESSAGE_REFILL=1000 \
 *     pnpm --filter @pqp/server exec tsx src/index.ts &
 *   cd client
 *   VITE_DEV_AUTH_BYPASS=true VITE_API_URL=http://localhost:3101 \
 *     VITE_WS_URL=ws://localhost:3101/ws pnpm exec vite --port 5273 --strictPort &
 *
 * Keep the worktree still while recording, or give Vite a wrapper config
 * (outside the repo) that spreads this one and sets `server.hmr: false` and
 * `server.watch.ignored: ["**\/*"]`: any file saved under client/ otherwise
 * reloads the page in the middle of a take.
 *
 *   HOME_REELS_DIR=/tmp/home-reels npx playwright test e2e/home-reels-record.spec.ts \
 *     --project=chromium            # add -g call / -g chat / ... for one shot
 *
 * Each test seeds (find-or-create, so a re-run reuses the server "A Mesa"),
 * records its shot with a CDP screencast of the camera person's page (2x
 * JPEG frames with their real timestamps), turns the frames into a 30 fps
 * master, cuts a seamless loop (the tail crossfades into the head, so the
 * first frame is also the poster), and encodes mp4 + webm at 1920 and 960
 * wide, the poster webp, and the 2x stills. `manifest.json` is rewritten from
 * whatever is in the output folder at the end of every test.
 *
 * The share test also records raise-hand: an audio-only call has no stage,
 * so the full "Fila pra falar" card only shows with a picture on it.
 *
 * Needs ffmpeg, ffprobe and cwebp on the PATH. No S3: avatars are letters.
 * The Discord import fetches its template from discord.com on the server, so
 * that shot is a still of the paste dialog only.
 */

const API = process.env.E2E_API_URL ?? "http://localhost:3101";
const WS_URL = API.replace(/^http/, "ws") + "/ws";
const RAW = process.env.HOME_REELS_DIR;
const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT =
  process.env.HOME_REELS_OUT ?? path.join(HERE, "..", "public", "media", "home");
const PT = JSON.parse(
  fs.readFileSync(path.join(HERE, "..", "src", "locales", "pt-BR", "translation.json"), "utf8"),
) as Record<string, string>;

test.skip(!RAW, "Set HOME_REELS_DIR to record the homepage reels");

test.use({
  launchOptions: {
    args: [
      "--use-fake-device-for-media-stream",
      "--use-fake-ui-for-media-stream",
      "--autoplay-policy=no-user-gesture-required",
    ],
  },
  trace: "off",
  video: "off",
  screenshot: "off",
});

const SERVER_NAME = "A Mesa";
const CAST = {
  rafa: "Rafa",
  bia: "Bia",
  caio: "Caio",
  nico: "Nico",
  duda: "Duda",
  leo: "Leo",
  lara: "Lara",
} as const;
type Suffix = keyof typeof CAST;

// ------------------------------------------------------------------ API seed

const headers = (suffix: string) => ({
  "Content-Type": "application/json",
  Authorization: `Bearer dev-local-token:${suffix}`,
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function call<T = any>(
  suffix: string,
  method: string,
  route: string,
  body?: unknown,
  { allow = [] as number[] } = {},
): Promise<T> {
  const response = await fetch(`${API}${route}`, {
    method,
    headers: headers(suffix),
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  if (!response.ok && !allow.includes(response.status)) {
    throw new Error(`${method} ${route} as ${suffix}: ${response.status} ${text}`);
  }
  try {
    return JSON.parse(text) as T;
  } catch {
    return text as T;
  }
}

interface Seeded {
  serverId: string;
  ids: Record<Suffix, string>;
  channels: Record<string, string>;
}

async function person(suffix: Suffix): Promise<string> {
  const me = await call(suffix, "GET", "/api/me");
  if (me.ageGate !== "passed") {
    await call(suffix, "POST", "/api/me/age-check", { dateOfBirth: "1990-01-01" }, {
      allow: [409],
    });
  }
  if (me.displayName !== CAST[suffix] || me.username !== suffix) {
    await call(suffix, "PATCH", "/api/me", {
      displayName: CAST[suffix],
      username: suffix,
    });
  }
  const now = new Date().toISOString();
  await call(suffix, "PATCH", "/api/me/preferences", {
    onboardedAt: now,
    firstRunDismissedAt: now,
    communityHomeIntroDismissedAt: now,
    theme: "dark",
    appearance: "signal",
    accentHue: "default",
  });
  return me.id as string;
}

let seeded: Seeded | null = null;

async function seed(): Promise<Seeded> {
  if (seeded) {
    return seeded;
  }
  const ids = {} as Record<Suffix, string>;
  for (const suffix of Object.keys(CAST) as Suffix[]) {
    ids[suffix] = await person(suffix);
  }
  // The guard the whole brief rests on: this must be OUR flag-free API, never
  // the suite's webServer with communities and Baú switched on.
  const communities = await call("rafa", "GET", "/api/communities/config");
  expect(communities.enabled, "communities must be off on the reels API").toBe(false);

  const { servers } = await call("rafa", "GET", "/api/servers");
  let server = (servers as { id: string; name: string }[]).find(
    (one) => one.name === SERVER_NAME,
  );
  if (!server) {
    server = (await call("rafa", "POST", "/api/servers", { name: SERVER_NAME })).server;
  }
  const serverId = server!.id;

  const listChannels = async () =>
    (await call("rafa", "GET", `/api/servers/${serverId}/channels`)).channels as {
      id: string;
      name: string;
      type: string;
    }[];
  let channels = await listChannels();
  const general = channels.find((one) => one.type === "text" && one.name === "general");
  if (general) {
    await call("rafa", "PATCH", `/api/channels/${general.id}`, { name: "geral" });
  }
  const wanted: { name: string; type: string; topic?: string }[] = [
    { name: "geral", type: "text" },
    { name: "fichas", type: "text", topic: "Fichas dos personagens e regras da casa" },
    { name: "memes", type: "text" },
    { name: "Lobby", type: "voice" },
    // Channel names are letters, digits, - and _ only, so no accents or spaces.
    { name: "sessao-de-sabado", type: "voice" },
  ];
  channels = await listChannels();
  for (const one of wanted) {
    if (!channels.some((c) => c.name === one.name && c.type === one.type)) {
      await call("rafa", "POST", `/api/servers/${serverId}/channels`, {
        ...one,
        parentId: null,
      });
    }
  }
  channels = await listChannels();
  const byName = Object.fromEntries(channels.map((c) => [c.name, c.id]));

  // Members.
  const { invite } = await call("rafa", "POST", `/api/servers/${serverId}/invites`, {});
  for (const suffix of ["bia", "caio", "nico", "duda", "leo", "lara"] as Suffix[]) {
    await call(suffix, "POST", `/api/invites/${invite.code}/join`, undefined, {
      allow: [409],
    });
  }

  // Roles: the staff ladder ships with the server; Mestre and Jogadores are ours.
  const roles = async () =>
    (await call("rafa", "GET", `/api/servers/${serverId}/roles`)).roles as {
      id: string;
      name: string;
      systemKey: string | null;
      color: string | null;
    }[];
  let list = await roles();
  const everyone = list.find((one) => one.systemKey === "everyone")!;
  const everyonePerms = BigInt((everyone as unknown as { permissions: string }).permissions);
  for (const role of [
    // Mestre carries ADMINISTRATOR (1 << 3): Bia is the table's admin under
    // the name the group actually uses, so the list shows Mestre, not "Adm".
    { name: "Mestre", color: "#E8834A", permissions: String(everyonePerms | (1n << 3n)) },
    { name: "Jogadores", color: "#5FB98E", permissions: String(everyonePerms) },
  ]) {
    let found = list.find((one) => one.name === role.name);
    if (!found) {
      found = (await call("rafa", "POST", `/api/servers/${serverId}/roles`, { name: role.name })).role;
    }
    await call("rafa", "PATCH", `/api/roles/${found!.id}`, {
      hoist: true,
      color: role.color,
      permissions: role.permissions,
    });
  }
  list = await roles();
  const roleId = (name: string) => list.find((one) => one.name === name || one.systemKey === name)!.id;
  const give = (suffix: Suffix, role: string) =>
    call("rafa", "PUT", `/api/servers/${serverId}/members/${ids[suffix]}/roles/${roleId(role)}`, undefined, {
      allow: [409],
    });
  // The owner holds no assignable roles; Bia runs the table.
  await call("rafa", "DELETE", `/api/servers/${serverId}/members/${ids.bia}/roles/${roleId("admin")}`, undefined, {
    allow: [404, 409],
  });
  await give("bia", "Mestre");
  for (const suffix of ["caio", "nico", "duda", "leo", "lara"] as Suffix[]) {
    await give(suffix, "Jogadores");
  }

  seeded = { serverId, ids, channels: byName };
  return seeded;
}

// ------------------------------------------------------------ chat actors (WS)

/** A cast member typing from Node over the real socket, no browser needed. */
class Actor {
  private socket!: WebSocket;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private waiters = new Map<string, (message: any) => void>();
  constructor(readonly suffix: Suffix) {}

  async connect(channelId: string): Promise<void> {
    this.socket = new WebSocket(WS_URL);
    await new Promise<void>((resolve, reject) => {
      this.socket.addEventListener("open", () => resolve(), { once: true });
      this.socket.addEventListener("error", () => reject(new Error("ws error")), { once: true });
    });
    const ready = new Promise<void>((resolve) => {
      this.socket.addEventListener("message", (event) => {
        const message = JSON.parse(String(event.data));
        if (message.type === "ready") {
          resolve();
        }
        if (message.type === "message-broadcast" && message.nonce) {
          this.waiters.get(message.nonce)?.(message.message);
        }
      });
    });
    this.send({ type: "auth", token: `dev-local-token:${this.suffix}` });
    await ready;
    this.send({ type: "join-channel", channelId });
  }

  send(frame: unknown) {
    this.socket.send(JSON.stringify(frame));
  }

  async say(channelId: string, body: string, extra: Record<string, unknown> = {}) {
    const nonce = `${this.suffix}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const landed = new Promise<{ id: string }>((resolve) => this.waiters.set(nonce, resolve));
    this.send({ type: "message-create", channelId, body, nonce, ...extra });
    const message = await landed;
    this.waiters.delete(nonce);
    return message;
  }

  typing(channelId: string) {
    this.send({ type: "typing", channelId });
  }

  react(channelId: string, messageId: string, emoji: string) {
    this.send({ type: "reaction-toggle", channelId, messageId, emoji });
  }

  vote(channelId: string, messageId: string, optionId: string) {
    this.send({ type: "poll-vote", channelId, messageId, optionId });
  }

  close() {
    this.socket?.close();
  }
}

/** Older history in #geral and in the Lobby's own chat, written once. */
async function seedHistory(data: Seeded) {
  const threads: [string, [Suffix, string][]][] = [
    [
      data.channels.geral,
      [
        ["bia", "Pessoal, sessão de sábado confirmada: 20h, no canal de voz de sempre."],
        ["caio", "Fechou. Vou levar a ficha nova do meu bardo"],
        ["duda", "Eu ainda tô devendo o resumo da última sessão 😅"],
        ["leo", "Alguém lembra quanto ouro sobrou depois da masmorra?"],
        ["nico", "312 peças de ouro. Tá anotado no #fichas"],
        ["rafa", "Trago mapa novo. Ninguém abre a porta vermelha antes de mim"],
      ],
    ],
    [
      data.channels.Lobby,
      [
        ["rafa", "Abri a call, chega aí"],
        ["caio", "Tô pegando um café e já entro"],
        ["bia", "Vou mostrar a arte nova da taverna"],
      ],
    ],
    [
      data.channels["sessao-de-sabado"],
      [
        ["bia", "Antes de começar, olha a arte nova da taverna"],
        ["nico", "Fala que a gente vai pro terraço hoje"],
        ["caio", "Já tô com a ficha aberta aqui"],
        ["rafa", "Vamos lá. Rolem iniciativa quando eu chamar"],
      ],
    ],
  ];
  for (const [channelId, lines] of threads) {
    const existing = await call("rafa", "GET", `/api/channels/${channelId}/messages`);
    if ((existing.messages ?? []).length > 0) {
      continue;
    }
    const actors = new Map<Suffix, Actor>();
    for (const [suffix, body] of lines) {
      let actor = actors.get(suffix);
      if (!actor) {
        actor = new Actor(suffix);
        await actor.connect(channelId);
        actors.set(suffix, actor);
      }
      await actor.say(channelId, body);
    }
    for (const actor of actors.values()) {
      actor.close();
    }
  }
}

/** Closes the "download the app" card in the sidebar if it is there. */
async function tidy(page: Page) {
  const card = page.getByText(PT["downloadPage.title"], { exact: true });
  if (await card.isVisible().catch(() => false)) {
    const close = card.locator("xpath=ancestor::*[.//button][1]").getByRole("button").last();
    await close.click().catch(() => {});
  }
}

// ----------------------------------------------------------- browser contexts

const DESKTOP = { width: 1440, height: 900 };
const PHONE = { width: 390, height: 844 };

/** Painted rooftop at dusk, slowly panning: what a "screen share" shows. */
function shareOverride() {
  const devices = navigator.mediaDevices;
  if (!devices) {
    return;
  }
  devices.getDisplayMedia = async () => {
    const image = new Image();
    image.src = "/images/hero/hero-1536.webp";
    await image.decode();
    const canvas = document.createElement("canvas");
    canvas.width = 1920;
    canvas.height = 1080;
    const g = canvas.getContext("2d")!;
    const started = performance.now();
    const draw = () => {
      const t = (performance.now() - started) / 1000;
      // Cover-fit the 3:2 painting into 16:9, then a slow zoom and drift.
      const zoom = 1.06 + 0.04 * Math.sin((t / 24) * Math.PI * 2);
      const scale = (canvas.width / image.width) * zoom;
      const w = image.width * scale;
      const h = image.height * scale;
      const x = (canvas.width - w) / 2 + Math.sin((t / 30) * Math.PI * 2) * 24;
      const y = (canvas.height - h) / 2 + (h - canvas.height) * 0.12;
      g.drawImage(image, x, y, w, h);
    };
    draw();
    setInterval(draw, 33);
    const stream = canvas.captureStream(30);
    (window as unknown as { __reelsShare: MediaStream }).__reelsShare = stream;
    try {
      const audio = new AudioContext();
      const tone = audio.createOscillator();
      const gain = audio.createGain();
      gain.gain.value = 0.04;
      tone.frequency.value = 196;
      const sink = audio.createMediaStreamDestination();
      tone.connect(gain).connect(sink);
      tone.start();
      void audio.resume();
      stream.addTrack(sink.stream.getAudioTracks()[0]);
    } catch {
      /* video only */
    }
    return stream;
  };
}

interface Person {
  suffix: Suffix;
  context: BrowserContext;
  page: Page;
}

async function open(
  browser: Browser,
  suffix: Suffix,
  {
    camera = false,
    phone = false,
    share = false,
  }: { camera?: boolean; phone?: boolean; share?: boolean } = {},
): Promise<Person> {
  const context = await browser.newContext({
    viewport: phone ? PHONE : camera ? DESKTOP : { width: 1100, height: 760 },
    deviceScaleFactor: phone ? 3 : camera ? 2 : 1,
    isMobile: phone,
    hasTouch: phone,
    locale: "pt-BR",
    timezoneId: "America/Sao_Paulo",
    colorScheme: "dark",
    permissions: ["microphone", "camera"],
  });
  await context.addInitScript((value) => {
    localStorage.setItem("pqp:dev-user-suffix", value);
    localStorage.setItem("pqp:locale", "pt-BR");
    const hide = () => {
      if (document.getElementById("reels-hide")) {
        return;
      }
      const style = document.createElement("style");
      style.id = "reels-hide";
      // The dev-bypass banner is not part of the product.
      // So is the dev build stamp ("pqp web · dev") in the settings rail.
      style.textContent =
        "main > div.bg-warning\\/10 { display: none !important }" +
        " *:has(> [data-build-line]) { visibility: hidden !important }";
      document.head.appendChild(style);
    };
    if (document.head) {
      hide();
    } else {
      document.addEventListener("DOMContentLoaded", hide);
    }
  }, suffix);
  if (share) {
    await context.addInitScript(shareOverride);
  }
  const page = await context.newPage();
  const log = path.join(RAW!, "console");
  fs.mkdirSync(log, { recursive: true });
  page.on("console", (message) => {
    if (message.type() === "warning" || message.type() === "error") {
      fs.appendFileSync(
        path.join(log, `${suffix}${phone ? "-phone" : ""}.log`),
        `${new Date().toISOString()} ${message.type()} ${message.text().slice(0, 400)}\n`,
      );
    }
  });
  return { suffix, context, page };
}

async function goto(page: Page, route: string) {
  await page.goto(route);
  await page.waitForLoadState("domcontentloaded");
}

async function openChannel(who: Person, seededData: Seeded, channel = "geral") {
  await goto(who.page, `/app/server/${seededData.serverId}/channel/${seededData.channels[channel]}`);
  await expect(who.page.getByRole("button", { name: PT["composer.send"], exact: true })).toBeVisible({
    timeout: 30_000,
  });
}

/** In-app navigation (a reload would drop the call). */
async function _clickChannel(who: Person, name: string) {
  await who.page
    .getByRole("button", { name: new RegExp(`^#?\\s*${name}\\b`, "i") })
    .first()
    .click();
  await who.page.waitForTimeout(400);
}

async function joinVoice(who: Person, channel: string) {
  await who.page
    .getByRole("button", { name: new RegExp(channel, "i") })
    .first()
    .dblclick();
  await expect(who.page.getByText(PT["voice.bar.connected"]).first()).toBeVisible({
    timeout: 30_000,
  });
}

// ------------------------------------------------------------------ recording

class Screencast {
  private session!: CDPSession;
  private frames: { file: string; ts: number; wall: number }[] = [];
  private dir: string;
  private stopped = false;
  firstWall = 0;

  constructor(
    private page: Page,
    readonly name: string,
    private scale = 2,
  ) {
    this.dir = path.join(RAW!, name, "frames");
  }

  async start() {
    fs.rmSync(this.dir, { recursive: true, force: true });
    fs.mkdirSync(this.dir, { recursive: true });
    this.session = await this.page.context().newCDPSession(this.page);
    this.session.on("Page.screencastFrame", (frame) => {
      if (this.stopped) {
        return;
      }
      const file = path.join(this.dir, `f${String(this.frames.length).padStart(5, "0")}.jpg`);
      fs.writeFileSync(file, Buffer.from(frame.data, "base64"));
      const wall = Date.now() / 1000;
      if (!this.firstWall) {
        this.firstWall = wall;
      }
      this.frames.push({ file, ts: frame.metadata.timestamp ?? wall, wall });
      void this.session
        .send("Page.screencastFrameAck", { sessionId: frame.sessionId })
        .catch(() => {});
    });
    // Chrome only sends a screencast frame when the page repaints, so the end
    // of a compositor-only animation (the dice settling) can be missed. A
    // 1px corner dot that changes every frame keeps repaints flowing; its
    // alpha stays near zero, so it never shows in the footage.
    await this.page.evaluate(() => {
      const dot = document.createElement("div");
      dot.id = "reels-heartbeat";
      dot.style.cssText =
        "position:fixed;right:0;bottom:0;width:1px;height:1px;pointer-events:none;z-index:2147483647";
      document.body.appendChild(dot);
      let flip = false;
      const tick = () => {
        if (!dot.isConnected) return;
        flip = !flip;
        dot.style.background = flip ? "rgba(0,0,0,0.01)" : "rgba(0,0,0,0.02)";
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });
    const viewport = this.page.viewportSize()!;
    await this.session.send("Page.startScreencast", {
      format: "jpeg",
      quality: 95,
      maxWidth: viewport.width * this.scale,
      maxHeight: viewport.height * this.scale,
      everyNthFrame: 1,
    });
    await expect.poll(() => this.frames.length, { timeout: 10_000 }).toBeGreaterThan(0);
  }

  /** Seconds since the first frame: where an event lands in the master. */
  now(): number {
    return Date.now() / 1000 - this.firstWall;
  }

  /** Stops, writes the concat list with real durations, returns the 30 fps master. */
  async stop(): Promise<string> {
    const end = Date.now() / 1000;
    await this.session.send("Page.stopScreencast").catch(() => {});
    await this.page
      .evaluate(() => document.getElementById("reels-heartbeat")?.remove())
      .catch(() => {});
    this.stopped = true;
    await this.session.detach().catch(() => {});
    const lines: string[] = [];
    this.frames.forEach((frame, index) => {
      const next = this.frames[index + 1];
      const duration = next
        ? Math.max(0.001, next.ts - frame.ts)
        : Math.max(0.04, end - frame.wall);
      lines.push(`file '${frame.file}'`, `duration ${duration.toFixed(4)}`);
    });
    lines.push(`file '${this.frames[this.frames.length - 1].file}'`);
    const list = path.join(RAW!, this.name, "frames.txt");
    fs.writeFileSync(list, lines.join("\n") + "\n");
    const master = path.join(RAW!, this.name, "master.mp4");
    run("ffmpeg", [
      "-y", "-loglevel", "error", "-f", "concat", "-safe", "0", "-i", list,
      // cfr: without it the muxer keeps a held frame as one sample, and the
      // trim and xfade in encodeLoop then misplace everything after it.
      "-vf", "fps=30,format=yuv420p", "-fps_mode", "cfr", "-c:v", "libx264", "-crf", "12",
      "-preset", "fast", master,
    ]);
    const span = this.frames[this.frames.length - 1].ts - this.frames[0].ts;
    console.log(`[reels] ${this.name}: ${this.frames.length} frames over ${span.toFixed(1)}s -> ${master}`);
    return master;
  }
}

function run(command: string, args: string[]): string {
  const result = spawnSync(command, args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")}\n${result.stderr}`);
  }
  return result.stdout;
}

interface LoopCut {
  /** Seconds into the master where the loop's source window starts. */
  start: number;
  /** Loop length in seconds (what the viewer sees before it repeats). */
  length: number;
  /** Crossfade of the tail into the head. */
  fade?: number;
  /** ffmpeg crop in master pixels (2x), e.g. "2400:1800:480:0". */
  crop?: string;
  crf?: number;
  crfSmall?: number;
  description: string;
}

/**
 * Seamless loop: the window is length + fade long; the output plays
 * [fade .. length+fade] and its last `fade` seconds blend into the window's
 * first `fade` seconds, so the last frame flows into the first one.
 */
function encodeLoop(name: string, master: string, cut: LoopCut) {
  const fade = cut.fade ?? 0.8;
  const dir = path.join(RAW!, name);
  const looped = path.join(dir, "loop.mp4");
  const crop = cut.crop ? `crop=${cut.crop},` : "";
  run("ffmpeg", [
    "-y", "-loglevel", "error",
    "-ss", cut.start.toFixed(3), "-t", (cut.length + fade + 0.2).toFixed(3), "-i", master,
    "-filter_complex",
    `[0:v]${crop}setpts=PTS-STARTPTS,split[s1][s2];` +
      `[s1]trim=start=0:end=${fade},setpts=PTS-STARTPTS[head];` +
      `[s2]trim=start=${fade}:end=${cut.length + fade},setpts=PTS-STARTPTS[body];` +
      `[body][head]xfade=transition=fade:duration=${fade}:offset=${(cut.length - fade).toFixed(3)},fps=30,format=yuv420p[v]`,
    "-map", "[v]", "-c:v", "libx264", "-crf", "10", "-preset", "fast", looped,
  ]);
  fs.mkdirSync(OUT, { recursive: true });
  const crf = cut.crf ?? 23;
  const crfSmall = cut.crfSmall ?? crf;
  for (const [suffix, width, h264, vp9] of [
    ["", 1920, crf, 33 + (crf - 23)],
    ["-960", 960, crfSmall, 33 + (crfSmall - 23)],
  ] as const) {
    const scale = `scale=${width}:-2:flags=lanczos`;
    run("ffmpeg", [
      "-y", "-loglevel", "error", "-i", looped, "-vf", scale,
      "-c:v", "libx264", "-crf", String(h264), "-preset", "slow", "-pix_fmt", "yuv420p",
      "-movflags", "+faststart", "-an", path.join(OUT, `${name}${suffix}.mp4`),
    ]);
    run("ffmpeg", [
      "-y", "-loglevel", "error", "-i", looped, "-vf", scale,
      "-c:v", "libvpx-vp9", "-crf", String(vp9), "-b:v", "0", "-row-mt", "1",
      "-deadline", "good", "-cpu-used", "2", "-an", path.join(OUT, `${name}${suffix}.webm`),
    ]);
    const png = path.join(dir, `poster${suffix}.png`);
    run("ffmpeg", ["-y", "-loglevel", "error", "-i", looped, "-vf", scale, "-frames:v", "1", png]);
    run("cwebp", ["-quiet", "-q", "82", png, "-o", path.join(OUT, `${name}${suffix}.webp`)]);
  }
  describe(name, cut.description);
}

/** A 2x PNG of the page (or a clip of it), saved as `still-<name>.webp`. */
async function still(
  page: Page,
  name: string,
  description: string,
  clip?: { x: number; y: number; width: number; height: number },
) {
  const dir = path.join(RAW!, "stills");
  fs.mkdirSync(dir, { recursive: true });
  fs.mkdirSync(OUT, { recursive: true });
  const png = path.join(dir, `${name}.png`);
  await page.screenshot({ path: png, ...(clip ? { clip } : {}) });
  run("cwebp", ["-quiet", "-q", "85", png, "-o", path.join(OUT, `still-${name}.webp`)]);
  describe(`still-${name}`, description);
}

/** Debug screenshot into the raw folder, never the output. */
async function peek(page: Page, name: string) {
  const dir = path.join(RAW!, "peek");
  fs.mkdirSync(dir, { recursive: true });
  await page.screenshot({ path: path.join(dir, `${name}.png`) });
}

// ------------------------------------------------------------------- manifest

const DESCRIPTIONS_FILE = () => path.join(RAW!, "descriptions.json");

function describe(name: string, text: string) {
  const file = DESCRIPTIONS_FILE();
  const all = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : {};
  all[name] = text;
  fs.writeFileSync(file, JSON.stringify(all, null, 2));
  writeManifest();
}

function probe(file: string) {
  const out = run("ffprobe", [
    "-v", "error", "-select_streams", "v:0",
    "-show_entries", "stream=width,height:format=duration",
    "-of", "json", file,
  ]);
  const parsed = JSON.parse(out);
  return {
    width: parsed.streams[0].width as number,
    height: parsed.streams[0].height as number,
    duration: parsed.format?.duration ? Number(Number(parsed.format.duration).toFixed(2)) : undefined,
  };
}

function writeManifest() {
  if (!fs.existsSync(OUT)) {
    return;
  }
  const descriptions = fs.existsSync(DESCRIPTIONS_FILE())
    ? JSON.parse(fs.readFileSync(DESCRIPTIONS_FILE(), "utf8"))
    : {};
  const files = fs.readdirSync(OUT).filter((file) => file !== "manifest.json").sort();
  const clips: Record<string, unknown>[] = [];
  const stills: Record<string, unknown>[] = [];
  const names = new Set(
    files.filter((file) => /\.mp4$/.test(file) && !/-960\.mp4$/.test(file)).map((file) => file.replace(/\.mp4$/, "")),
  );
  for (const name of [...names].sort()) {
    const entry: Record<string, unknown> = { name, description: descriptions[name] ?? "" };
    for (const variant of [`${name}.mp4`, `${name}.webm`, `${name}-960.mp4`, `${name}-960.webm`, `${name}.webp`, `${name}-960.webp`]) {
      if (files.includes(variant)) {
        const info = probe(path.join(OUT, variant));
        entry[variant] = {
          width: info.width,
          height: info.height,
          ...(variant.endsWith(".webp") ? {} : { duration: info.duration }),
          bytes: fs.statSync(path.join(OUT, variant)).size,
        };
      }
    }
    clips.push(entry);
  }
  for (const file of files.filter((one) => one.startsWith("still-"))) {
    const info = probe(path.join(OUT, file));
    const name = file.replace(/\.webp$/, "");
    stills.push({
      file,
      width: info.width,
      height: info.height,
      bytes: fs.statSync(path.join(OUT, file)).size,
      description: descriptions[name] ?? "",
    });
  }
  fs.writeFileSync(
    path.join(OUT, "manifest.json"),
    JSON.stringify(
      {
        generatedBy: "client/e2e/home-reels-record.spec.ts",
        recordedAt: new Date().toISOString().slice(0, 10),
        note: "Real pqp app, dev-bypass accounts, pt-BR, dark theme. Clips are seamless loops; the .webp beside each clip is its first frame.",
        clips,
        stills,
        skipped: [
          {
            name: "import",
            reason: "The Discord template import fetches the template from discord.com on the server, so there is no offline flow to film. still-import.webp shows the paste dialog instead.",
          },
        ],
      },
      null,
      2,
    ) + "\n",
  );
}

// ------------------------------------------------------------- call helpers

const wait = (page: Page, ms: number) => page.waitForTimeout(ms);

/** Seats from an earlier take are held 90 s for a resume; wait them out. */
async function waitLobbyEmpty(page: Page) {
  await expect
    .poll(() => page.getByText(/^Na call: /).count(), { timeout: 120_000, intervals: [2_000] })
    .toBe(0);
}

async function leaveVoice(who: Person) {
  const sidebar = who.page.getByRole("button", { name: PT["voice.bar.leave"], exact: true }).first();
  const dock = who.page.getByRole("button", { name: PT["voice.control.leave"], exact: true }).first();
  for (const button of [sidebar, dock]) {
    if (await button.isVisible().catch(() => false)) {
      await button.click({ timeout: 5_000 }).catch(() => {});
      await who.page.waitForTimeout(400);
      return;
    }
  }
}

async function closeAll(people: Person[]) {
  for (const one of people) {
    await leaveVoice(one).catch(() => {});
  }
  for (const one of people) {
    await one.context.close().catch(() => {});
  }
}

/** Mutes through the call dock and waits until the dock says so. */
async function mute(who: Person) {
  const dock = who.page.getByTestId("call-stage-collapsed");
  const off = dock.getByRole("button", { name: PT["voice.control.mute"], exact: true }).first();
  const on = dock.getByRole("button", { name: PT["voice.control.unmute"], exact: true }).first();
  await expect(off.or(on)).toBeVisible({ timeout: 20_000 });
  for (let attempt = 0; attempt < 3 && !(await on.isVisible().catch(() => false)); attempt++) {
    await off.click().catch(() => {});
    await who.page.waitForTimeout(600);
  }
  await expect(on).toBeVisible({ timeout: 5_000 });
}

/** Where a loop starts and how long it runs, from the moments that matter. */
function window(posterAt: number, endAt: number, fade = 0.8) {
  const start = Math.max(0, posterAt - fade);
  return { start, length: endAt - start, fade };
}

// --------------------------------------------------------------------- shots

test("call", async ({ browser }) => {
  test.setTimeout(420_000);
  const data = await seed();
  await seedHistory(data);
  const rafa = await open(browser, "rafa", { camera: true });
  const people: Person[] = [rafa];
  try {
    await openChannel(rafa, data);
    await tidy(rafa.page);
    await waitLobbyEmpty(rafa.page);
    const cast: Record<string, Person> = {};
    for (const suffix of ["bia", "caio", "nico", "duda", "leo"] as Suffix[]) {
      cast[suffix] = await open(browser, suffix);
      people.push(cast[suffix]);
      await openChannel(cast[suffix], data);
    }
    await joinVoice(rafa, "Lobby");
    await wait(rafa.page, 2500);

    // 1. call-join: the crew drops in one by one.
    const rec = new Screencast(rafa.page, "call-join");
    await rec.start();
    await wait(rafa.page, 1200);
    const joins: number[] = [];
    for (const suffix of ["bia", "caio", "nico", "duda", "leo"]) {
      joins.push(rec.now());
      await joinVoice(cast[suffix], "Lobby");
      await wait(rafa.page, 900);
    }
    await wait(rafa.page, 2200);
    await still(rafa.page, "call-join", "Voice channel Lobby in A Mesa with six people in the call, speaking rings lit, Lobby chat in the middle.");
    const joinMaster = await rec.stop();
    console.log("[reels] joins at", joins.map((t) => t.toFixed(2)).join(", "));
    encodeLoop("call-join", joinMaster, {
      ...window(joins[0] - 0.6, joins[joins.length - 1] + 1.9),
      description:
        "Hero loop: in the voice channel Lobby, Bia, Caio, Nico, Duda and Leo drop into the call one by one and their speaking rings light up.",
    });

    // Stills of the full sidebar voice list and the role-coloured member list.
    await still(rafa.page, "voice-list", "Channel sidebar of A Mesa: text channels, then Lobby with six people in the call and their speaking rings.", {
      x: 0, y: 0, width: 328, height: 760,
    });
    await still(rafa.page, "members", "Member list grouped by role colour: Dono (Rafa), Mestre (Bia), Jogadores, each with 'Na call: Lobby'.", {
      x: 1200, y: 0, width: 240, height: 640,
    });

    // The raise-hand clip is recorded in the share test: an audio-only call
    // has no stage, so the full "Fila pra falar" card only shows there.

    // 2. Phone still of the call, from Lara's phone.
    const lara = await open(browser, "lara", { phone: true });
    people.push(lara);
    await goto(lara.page, `/app/server/${data.serverId}/channel/${data.channels.Lobby}`);
    await wait(lara.page, 3000);
    const joinButton = lara.page.getByRole("button", { name: PT["voice.join"] }).first();
    if (await joinButton.isVisible().catch(() => false)) {
      await joinButton.click();
    }
    await wait(lara.page, 4000);
    await peek(lara.page, "phone-call");
    await still(lara.page, "phone-call", "Phone (390 wide): Lara's view of the Lobby call in A Mesa.");
  } finally {
    await closeAll(people);
  }
});

test("chat", async ({ browser }) => {
  test.setTimeout(300_000);
  const data = await seed();
  // A re-run starts #geral from its seeded history again, so an older take's
  // poll and roll never sit above (or get voted instead of) this one's.
  for (let sweep = 0; sweep < 3; sweep++) {
    const swept = await call<{ deleted: number }>(
      "rafa", "POST", `/api/channels/${data.channels.geral}/messages/bulk-delete`, { count: 100 },
    );
    if (swept.deleted < 100) break;
  }
  await seedHistory(data);
  const channelId = data.channels.geral;
  const actors: Record<string, Actor> = {};
  for (const suffix of ["bia", "caio", "nico", "duda", "leo"] as Suffix[]) {
    actors[suffix] = new Actor(suffix);
    await actors[suffix].connect(channelId);
  }
  const rafa = await open(browser, "rafa", { camera: true });
  const people: Person[] = [rafa];
  try {
    await openChannel(rafa, data);
    await tidy(rafa.page);
    await wait(rafa.page, 1500);

    const rec = new Screencast(rafa.page, "chat");
    await rec.start();
    await wait(rafa.page, 700);
    const firstAt = rec.now();
    actors.nico.typing(channelId);
    await wait(rafa.page, 600);
    const ask = await actors.nico.say(channelId, "E a noite de jogos de sexta, ainda tá de pé?");
    await wait(rafa.page, 300);
    actors.duda.typing(channelId);
    await wait(rafa.page, 600);
    const yes = await actors.duda.say(channelId, "Tá sim! Eu levo os salgadinhos 🍿", { replyToId: ask.id });
    await wait(rafa.page, 400);
    for (const suffix of ["caio", "leo", "nico"]) {
      actors[suffix].react(channelId, yes.id, "🙌");
      await wait(rafa.page, 280);
    }
    actors.bia.react(channelId, ask.id, "❤️");
    await wait(rafa.page, 450);
    const poll = (await actors.bia.say(channelId, "", {
      poll: {
        question: "Que horas começa a sessão de sábado?",
        options: ["19h", "20h", "21h"],
        durationSeconds: 86_400,
        allowMultiselect: false,
      },
    })) as unknown as { id: string; poll: { options: { id: string; label: string }[] } };
    const option = (label: string) => poll.poll.options.find((one) => one.label === label)!.id;
    await wait(rafa.page, 600);
    for (const [suffix, label] of [["caio", "20h"], ["leo", "20h"], ["nico", "19h"]] as const) {
      actors[suffix].vote(channelId, poll.id, option(label));
      await wait(rafa.page, 300);
    }
    // The camera votes through the real card, then the pointer leaves so no
    // hover toolbar is left standing (blur too: focus keeps it up).
    await rafa.page
      .locator("[data-poll] li button")
      .filter({ hasText: "20h" })
      .first()
      .click();
    await rafa.page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    await rafa.page.mouse.move(1000, 30);
    await wait(rafa.page, 350);
    actors.duda.vote(channelId, poll.id, option("20h"));
    await wait(rafa.page, 600);
    await actors.leo.say(channelId, "", { chance: { type: "roll", notation: "1d20", comment: "iniciativa" } });
    // The die spins for about two seconds; hold on the result before the loop.
    await wait(rafa.page, 3000);
    const endAt = rec.now();
    await still(rafa.page, "chat", "#geral in A Mesa: a reply, 🙌 reactions, a poll with votes for the Saturday session and a 1d20 initiative roll.");
    const master = await rec.stop();
    encodeLoop("chat", master, {
      ...window(firstAt - 0.3, endAt),
      description:
        "#geral: messages arrive from the crew, a reply, 🙌 reactions count up, Bia's poll gets votes (Rafa votes 20h) and Leo rolls 1d20 for initiative.",
    });

    // Phone stills from Lara's phone: the chat and the server list.
    const lara = await open(browser, "lara", { phone: true });
    people.push(lara);
    await goto(lara.page, `/app/server/${data.serverId}/channel/${channelId}`);
    await expect(lara.page.locator("[data-poll]").first()).toBeVisible({ timeout: 30_000 });
    await wait(lara.page, 1500);
    // Lara has never read #geral, so it opens at the unread line: jump down.
    const present = lara.page.getByRole("button", { name: PT["chat.jump.present"] }).first();
    if (await present.isVisible().catch(() => false)) {
      await present.click();
      await wait(lara.page, 1200);
    }
    await still(lara.page, "phone-chat", "Phone (390 wide): #geral in A Mesa with the poll and the roll.");
    await lara.page.getByRole("button", { name: PT["chrome.openNav"] }).first().click();
    await wait(lara.page, 1200);
    await tidy(lara.page);
    await wait(lara.page, 500);
    await peek(lara.page, "phone-nav");
    await still(lara.page, "phone-servers", "Phone (390 wide): the server rail and A Mesa's channel list.");
  } finally {
    for (const actor of Object.values(actors)) {
      actor.close();
    }
    await closeAll(people);
  }
});

test("appearance", async ({ browser }) => {
  test.setTimeout(240_000);
  const data = await seed();
  const rafa = await open(browser, "rafa", { camera: true });
  try {
    await openChannel(rafa, data);
    await tidy(rafa.page);
    await rafa.page.getByRole("button", { name: PT["userPanel.openSettings"] }).first().click();
    await expect(rafa.page.getByRole("dialog")).toBeVisible();
    await rafa.page.getByRole("tab", { name: PT["settings.section.appearance"] }).click();
    await wait(rafa.page, 1200);
    await rafa.page.mouse.move(1380, 860);
    const panel = rafa.page.getByRole("tabpanel");
    const scroller = rafa.page.locator("[role=tabpanel]").first();
    const radio = (name: string) => panel.getByRole("radio", { name, exact: true }).first();
    const visual = (name: string) => panel.getByRole("radio").filter({ hasText: name }).first();
    const scrollBy = async (dy: number) => {
      await scroller.evaluate((el, d) => {
        let node: HTMLElement | null = el as HTMLElement;
        while (node && node.scrollHeight <= node.clientHeight + 4) node = node.parentElement;
        (node ?? (el as HTMLElement)).scrollBy({ top: d, behavior: "smooth" });
      }, dy);
    };
    const click = async (target: ReturnType<typeof radio>, ms: number) => {
      await target.click();
      await rafa.page.mouse.move(1380, 860);
      await wait(rafa.page, ms);
    };

    const rec = new Screencast(rafa.page, "appearance");
    await rec.start();
    await wait(rafa.page, 700);
    const firstAt = rec.now();
    await click(radio("Claro"), 1100);
    await click(radio("Escuro"), 800);
    await click(visual("Lareira"), 950);
    await click(visual("Harmonia"), 750);
    await scrollBy(520);
    await wait(rafa.page, 650);
    await click(radio("Roxo"), 800);
    await click(radio("Rosa"), 900);
    await click(radio("Do visual"), 400);
    await scrollBy(-520);
    await wait(rafa.page, 600);
    await click(visual("Clássico"), 700);
    const endAt = rec.now();
    const master = await rec.stop();
    encodeLoop("appearance", master, {
      ...window(firstAt - 0.1, endAt, 0.6),
      description:
        "Settings, Aparência e idioma: light then dark mode, the Lareira and Harmonia visuals, purple and pink accents, all applied live, then back to Clássico.",
    });
    // The still, after the take: Harmonia with the pink accent.
    await click(visual("Harmonia"), 500);
    await scrollBy(520);
    await wait(rafa.page, 700);
    await click(radio("Rosa"), 800);
    await still(rafa.page, "appearance", "Settings, Aparência e idioma: the Harmonia visual with a pink accent, applied live to the whole app.");
  } finally {
    await rafa.context.close();
    // Leave Rafa on the defaults for every later take.
    await call("rafa", "PATCH", "/api/me/preferences", { theme: "dark", appearance: "signal", accentHue: "default" });
  }
});

async function befriend(a: Suffix, b: Suffix, ids: Record<Suffix, string>) {
  const asked = await call(a, "POST", "/api/friends", { userId: ids[b] }, { allow: [409] });
  if (asked?.state !== "accepted") {
    await call(b, "POST", `/api/friends/${ids[a]}/accept`, undefined, { allow: [404, 409] });
  }
}

test("profile", async ({ browser }) => {
  test.setTimeout(240_000);
  const data = await seed();
  const handle = "rafa";
  const me = await call("rafa", "GET", "/api/me");
  if (me.handle !== handle) {
    await call("rafa", "PATCH", "/api/me", { handle });
  }
  await call("rafa", "PATCH", "/api/me", { customStatus: "Mestre de RPG nas horas vagas" });
  const shown = await call("rafa", "GET", `/api/users/${data.ids.rafa}/depoimentos`);
  if ((shown.depoimentos ?? []).length < 2) {
    const notes: [Suffix, string][] = [
      ["bia", "O Rafa prepara cada sessão como se fosse a última. Mapa novo toda semana e ninguém fica de fora da história."],
      ["caio", "Melhor mestre que já tive. Paciente com quem tá começando e sempre com uma reviravolta guardada."],
    ];
    for (const [suffix, body] of notes) {
      await befriend("rafa", suffix, data.ids);
      await call(suffix, "POST", `/api/users/${data.ids.rafa}/depoimentos`, { body }, { allow: [409, 429] });
    }
    const pending = await call("rafa", "GET", "/api/me/depoimentos/pending");
    for (const one of pending.depoimentos ?? []) {
      await call("rafa", "POST", `/api/depoimentos/${one.id}/approve`);
    }
  }
  const lara = await open(browser, "lara", { camera: true });
  try {
    await goto(lara.page, `/@${handle}`);
    await expect(lara.page.getByText(`@${handle}`).first()).toBeVisible({ timeout: 30_000 });
    await wait(lara.page, 2000);
    await peek(lara.page, "profile-top");
    await still(lara.page, "profile", "Rafa's public page at pqp.gg/@rafa with two approved depoimentos from Bia and Caio.");
    const height = await lara.page.evaluate(() => document.documentElement.scrollHeight - innerHeight);
    console.log("[reels] profile scrollable px", height);
    const rec = new Screencast(lara.page, "profile");
    await rec.start();
    await wait(lara.page, 800);
    const firstAt = rec.now();
    // The card fits the screen; a short travel shows the depoimentos settle
    // without scrolling into the footer.
    const travel = Math.min(Math.max(height, 0), 200);
    // A gentle, eased scroll down and back up, so the loop ends where it starts.
    await lara.page.evaluate(async (distance) => {
      const ease = (t: number) => 0.5 - 0.5 * Math.cos(Math.PI * t);
      const run = (from: number, to: number, ms: number) =>
        new Promise<void>((resolve) => {
          const t0 = performance.now();
          const step = (now: number) => {
            const t = Math.min(1, (now - t0) / ms);
            window.scrollTo(0, from + (to - from) * ease(t));
            if (t < 1) requestAnimationFrame(step);
            else resolve();
          };
          requestAnimationFrame(step);
        });
      await run(0, distance, 3200);
      await new Promise((r) => setTimeout(r, 1300));
      await run(distance, 0, 3000);
    }, travel);
    await wait(lara.page, 700);
    const endAt = rec.now();
    const master = await rec.stop();
    encodeLoop("profile", master, {
      ...window(firstAt, endAt, 0.5),
      description: "Rafa's public profile page (/@rafa), scrolling gently down to the approved depoimentos and back.",
    });
  } finally {
    await lara.context.close();
  }
});

test("import", async ({ browser }) => {
  test.setTimeout(120_000);
  const data = await seed();
  const rafa = await open(browser, "rafa", { camera: true });
  try {
    await openChannel(rafa, data);
    await tidy(rafa.page);
    await peek(rafa.page, "import-0");
    const add = rafa.page.getByRole("button", { name: /Adicionar um servidor|Criar|Novo servidor/i }).first();
    await add.click();
    await wait(rafa.page, 800);
    await peek(rafa.page, "import-1");
    await rafa.page.getByText(PT["importDiscord.mode.discord"]).first().click({ timeout: 10_000 });
    await wait(rafa.page, 900);
    await peek(rafa.page, "import-2");
    await still(rafa.page, "import", "The Discord template import dialog: paste a discord.new link or a template code to copy a server's layout.");
  } finally {
    await rafa.context.close();
  }
});

test("share", async ({ browser }) => {
  test.setTimeout(420_000);
  const data = await seed();
  await seedHistory(data);
  const room = "sessao-de-sabado";
  const rafa = await open(browser, "rafa", { camera: true });
  const people: Person[] = [rafa];
  try {
    await openChannel(rafa, data);
    await tidy(rafa.page);
    // Nobody in ANY call yet: a seat left by the call test (held 90 s for a
    // resume) would otherwise flicker out of the member list mid-loop.
    await waitLobbyEmpty(rafa.page);
    const cast: Record<string, Person> = {};
    for (const suffix of ["bia", "caio", "nico"] as Suffix[]) {
      cast[suffix] = await open(browser, suffix, { share: suffix === "bia" });
      people.push(cast[suffix]);
      await openChannel(cast[suffix], data);
    }
    await joinVoice(rafa, room);
    for (const suffix of ["bia", "caio", "nico"]) {
      await joinVoice(cast[suffix], room);
    }
    await mute(cast.caio);
    await mute(cast.nico);
    await rafa.page.mouse.move(760, 24);
    await wait(rafa.page, 2500);

    const stageVideo = rafa.page.locator('[data-testid="call-stage"] video.object-contain').first();
    const rec = new Screencast(rafa.page, "share");
    await rec.start();
    await wait(rafa.page, 1200);
    const sharedAt = rec.now();
    await cast.bia.page.getByRole("button", { name: PT["voice.control.share"], exact: true }).first().click();
    await expect(stageVideo).toBeVisible({ timeout: 20_000 });
    await expect
      .poll(() => stageVideo.evaluate((el) => (el as HTMLVideoElement).videoWidth), { timeout: 20_000 })
      .toBeGreaterThan(0);
    const visibleAt = rec.now();
    console.log(`[reels] share clicked at ${sharedAt.toFixed(2)}, on stage at ${visibleAt.toFixed(2)}`);
    await rafa.page.mouse.move(760, 24);
    await wait(rafa.page, 7000);
    const endAt = rec.now();
    const master = await rec.stop();
    encodeLoop("share", master, {
      ...window(sharedAt - 0.5, Math.min(endAt, sharedAt + 9.2), 0.9),
      description:
        "Bia starts a screen share in the voice channel sessao-de-sabado: the painted rooftop at dusk fills the stage, with the people in the call and the call chat below it.",
    });

    // The picture has had time to sharpen: the hero still.
    await wait(rafa.page, 4000);
    await still(rafa.page, "hero", "Hero still: the full app with a voice call on the stage (Bia sharing the painted rooftop) and the call's chat side by side.");
    await still(rafa.page, "share", "Bia's screen share on the stage of the sessao-de-sabado call, with the listener strip and the call chat.");

    // Raised hands on the stage: the queue card lists them in order.
    const hands = new Screencast(rafa.page, "raise-hand");
    await hands.start();
    await wait(rafa.page, 1000);
    const raisedAt = hands.now();
    await cast.caio.page.locator("[data-raise-hand]").first().click();
    await wait(rafa.page, 1700);
    await cast.nico.page.locator("[data-raise-hand]").first().click();
    await wait(rafa.page, 3800);
    await still(rafa.page, "raise-hand", "Call with a screen share on the stage: Caio and Nico raised their hands and the 'Fila pra falar' card lists them in order.");
    const handsEnd = hands.now();
    const handsMaster = await hands.stop();
    encodeLoop("raise-hand", handsMaster, {
      ...window(raisedAt - 0.5, handsEnd - 0.2),
      description:
        "In a call with a screen share on the stage, Caio then Nico raise their hands; the 'Fila pra falar' card lists Caio first, Nico second.",
    });
    for (const suffix of ["caio", "nico"]) {
      await cast[suffix].page.locator("[data-raise-hand]").first().click({ timeout: 3_000 }).catch(() => {});
    }
  } finally {
    await closeAll(people);
  }
});

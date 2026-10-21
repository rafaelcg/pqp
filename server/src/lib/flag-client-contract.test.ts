import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { FEATURE_FLAGS } from "./flags.js";
import { shareConfigForServer } from "./share-config.js";
import { voiceConfigForServer } from "./voice-config.js";
import { forumConfigForServer } from "./forum-config.js";
import { liveHlsConfig } from "../voice/hls-egress.js";

/**
 * THE TWO HALVES OF A FLAG, COMPARED.
 *
 * A flag that reaches a client is two pieces of code in two packages that
 * nothing links: the server registers it and serves a field, the client reads
 * that field by name. `linux_desktop_system_audio` shipped (desktop 0.2.3) with
 * every client and shell piece and none of the server: the client read
 * `linuxDesktopSystemAudio` from `/api/share/config`, the server never sent it,
 * so the answer was "off" forever and the dashboard had no switch. Every test
 * on each side passed, because each side tested itself. Same shape as CLAUDE.md
 * pitfalls 9 and 12: the test did not exercise the path production uses.
 *
 * This file reads the client's source and asks the server's side the same
 * question, so a field one side names and the other lacks fails here.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const serverSrc = path.resolve(here, "..");
const clientSrc = path.resolve(here, "../../../client/src");

function sourceFiles(root: string): string[] {
  return (readdirSync(root, { recursive: true, encoding: "utf8" }) as string[])
    .filter(
      (file) =>
        /\.(ts|tsx)$/.test(file) &&
        !/\.test\.(ts|tsx)$/.test(file) &&
        !file.split(path.sep).includes("node_modules"),
    )
    .map((file) => path.join(root, file));
}

const clientFiles = sourceFiles(clientSrc).map((file) => ({
  file,
  text: readFileSync(file, "utf8"),
}));
const serverFiles = sourceFiles(serverSrc)
  .filter((file) => path.basename(file) !== "flags.ts")
  .map((file) => ({ file, text: readFileSync(file, "utf8") }));

function mentions(files: { text: string }[], field: string): boolean {
  const word = new RegExp(`\\b${field}\\b`);
  return files.some(({ text }) => word.test(text));
}

describe("GET /api/share/config against the client that reads it", () => {
  const served = Object.keys(shareConfigForServer(null)).sort();

  it("the client's ShareConfig type names exactly the fields the server sends", () => {
    const api = readFileSync(path.join(clientSrc, "lib/api.ts"), "utf8");
    const body = /export interface ShareConfig \{([\s\S]*?)\n\}/.exec(api)?.[1];
    expect(body, "client ShareConfig interface not found in lib/api.ts").toBeTruthy();
    const declared = [...body!.matchAll(/^\s{2}([A-Za-z]\w*)\??:/gm)]
      .map((match) => match[1]!)
      .sort();
    expect(declared).toEqual(served);
  });

  it("every field the client reads off a fetched share config is one the server sends", () => {
    const readers = clientFiles.filter(({ text }) => text.includes("fetchShareConfig"));
    // The three readers today: native share audio, the guard and hint, Linux.
    // If one is renamed this still has to find them, or it asserts nothing.
    expect(readers.length).toBeGreaterThanOrEqual(3);
    const read = new Set<string>();
    for (const { text } of readers) {
      for (const match of text.matchAll(/\bconfig\??\.([A-Za-z]\w*)/g)) {
        read.add(match[1]!);
      }
    }
    expect([...read].sort()).toEqual(
      expect.arrayContaining([
        "desktopShareAudioNative",
        "shareHighMotionGuard",
        "shareGameCaptureHint",
        "shareFastStartQuality",
        "linuxDesktopSystemAudio",
      ]),
    );
    for (const field of read) {
      expect(served, `client reads \`${field}\` from /api/share/config`).toContain(field);
    }
  });

  it("the route the client calls is mounted and answers with that config, asked per server", () => {
    const api = readFileSync(path.join(serverSrc, "api/index.ts"), "utf8");
    const route = /router\.get\("\/api\/share\/config"[\s\S]*?\);/.exec(api)?.[0];
    expect(route, "GET /api/share/config is not mounted").toBeTruthy();
    expect(route).toContain("shareConfigForServer(");
    expect(route).toContain('searchParams.get("serverId")');
  });

  it("every share flag the server registers is served under the field its registry entry names", () => {
    for (const [key, def] of Object.entries(FEATURE_FLAGS)) {
      const clientVia = "clientVia" in def ? def.clientVia : undefined;
      if (!clientVia?.startsWith("GET /api/share/config")) {
        continue;
      }
      const field = /\((\w+)\)/.exec(clientVia)?.[1];
      expect(field, `${key} names no field in clientVia`).toBeTruthy();
      expect(served, `${key} is registered as served by /api/share/config`).toContain(field);
    }
  });
});

describe("GET /api/voice/config against the client that reads it", () => {
  // Audience mode (`audience_mode`), the one field today. Same checks as the
  // share config above, written the day the flag was born rather than the
  // day after its server half went missing.
  const served = Object.keys(voiceConfigForServer(null)).sort();

  it("the client's VoiceConfig type names exactly the fields the server sends", () => {
    const api = readFileSync(path.join(clientSrc, "lib/api.ts"), "utf8");
    const body = /export interface VoiceConfig \{([\s\S]*?)\n\}/.exec(api)?.[1];
    expect(body, "client VoiceConfig interface not found in lib/api.ts").toBeTruthy();
    const declared = [...body!.matchAll(/^\s{2}([A-Za-z]\w*)\??:/gm)]
      .map((match) => match[1]!)
      .sort();
    expect(declared).toEqual(served);
  });

  it("the client asks with the call's server and reads audienceMode off the answer", () => {
    const hook = readFileSync(path.join(clientSrc, "hooks/use-voice-config.ts"), "utf8");
    expect(hook).toContain("fetchVoiceConfig(serverId)");
    const api = readFileSync(path.join(clientSrc, "lib/api.ts"), "utf8");
    expect(api).toMatch(/\/api\/voice\/config\?serverId=/);
    const readers = clientFiles.filter(({ text }) => text.includes("useVoiceConfig("));
    expect(readers.length).toBeGreaterThanOrEqual(1);
    const read = new Set<string>();
    for (const { text } of readers) {
      for (const match of text.matchAll(/\bvoiceConfig\??\.([A-Za-z]\w*)/g)) {
        read.add(match[1]!);
      }
    }
    expect([...read]).toContain("audienceMode");
    for (const field of read) {
      expect(served, `client reads \`${field}\` from /api/voice/config`).toContain(field);
    }
  });

  it("the route the client calls is mounted and answers with that config, asked per server", () => {
    const api = readFileSync(path.join(serverSrc, "api/index.ts"), "utf8");
    const route = /router\.get\("\/api\/voice\/config"[\s\S]*?\);/.exec(api)?.[0];
    expect(route, "GET /api/voice/config is not mounted").toBeTruthy();
    expect(route).toContain("voiceConfigForServer(");
    expect(route).toContain('searchParams.get("serverId")');
  });

  it("every voice flag the server registers is served under the field its registry entry names", () => {
    let checked = 0;
    for (const [key, def] of Object.entries(FEATURE_FLAGS)) {
      const clientVia = "clientVia" in def ? def.clientVia : undefined;
      if (!clientVia?.startsWith("GET /api/voice/config")) {
        continue;
      }
      const field = /\((\w+)\)/.exec(clientVia)?.[1];
      expect(field, `${key} names no field in clientVia`).toBeTruthy();
      expect(served, `${key} is registered as served by /api/voice/config`).toContain(field);
      checked += 1;
    }
    expect(checked).toBeGreaterThanOrEqual(1);
  });

  it("audience_mode is per server, off by default, and the dashboard has a note for it", () => {
    expect(FEATURE_FLAGS.audience_mode.perServer).toBe(true);
    expect(FEATURE_FLAGS.audience_mode.codeDefault).toBe(false);
    const dashboard = readFileSync(
      path.resolve(here, "../../../tools/admin-dashboard/site/novo.js"),
      "utf8",
    );
    expect(dashboard).toMatch(/\baudience_mode:\s*"/);
  });

  it("clean_voice_default is global, on by default, read off the global config and handed to the settings resolver", () => {
    const def = FEATURE_FLAGS.clean_voice_default;
    expect(def.perServer).toBe(false);
    expect(def.codeDefault).toBe(true);
    expect(def.clientVia).toBe("GET /api/voice/config (cleanVoiceDefault)");
    expect(served).toContain("cleanVoiceDefault");
    const flag = readFileSync(path.join(clientSrc, "lib/clean-voice-default.ts"), "utf8");
    // The global ask (no server), and the field read by name off it.
    expect(flag).toContain("fetchGlobalVoiceConfig()");
    expect(flag).toMatch(/answer\.cleanVoiceDefault === true/);
    // The answer reaches what the microphone is opened with: the stored
    // settings resolve through it, and the app re-resolves when it moves.
    const local = readFileSync(path.join(clientSrc, "components/settings/local-settings.ts"), "utf8");
    expect(local).toContain("currentDefaultNoiseSuppression()");
    const app = readFileSync(path.join(clientSrc, "App.tsx"), "utf8");
    expect(app).toContain("startCleanVoiceDefaultFlag()");
    expect(app).toContain("useCleanVoiceDefaultMode()");
    const dashboard = readFileSync(
      path.resolve(here, "../../../tools/admin-dashboard/site/novo.js"),
      "utf8",
    );
    expect(dashboard).toMatch(/\bclean_voice_default:\s*"/);
  });
});

describe("every flag that says it reaches the client", () => {
  const withField = Object.entries(FEATURE_FLAGS).flatMap(([key, def]) => {
    const clientVia = "clientVia" in def ? def.clientVia : undefined;
    const field = clientVia ? /\((\w+)\)/.exec(clientVia)?.[1] : undefined;
    return field ? [{ key, field, clientVia: clientVia! }] : [];
  });

  it("has flags to check", () => {
    expect(withField.length).toBeGreaterThan(10);
  });

  it.each(withField)("$key: the server writes `$field` and the client reads it", ({ field }) => {
    expect(mentions(serverFiles, field), `no server source outside flags.ts mentions ${field}`).toBe(
      true,
    );
    expect(mentions(clientFiles, field), `no client source mentions ${field}`).toBe(true);
  });
});

describe("share_fast_start_quality, every link from the switch to the session", () => {
  // The flag acts in two places the share config never reaches directly: the
  // viewer's subscription and the presenter's publish, both inside the LiveKit
  // session. A field served and read but never handed on would pass every test
  // above and still do nothing, so the chain is checked link by link.
  const read = (file: string) => readFileSync(path.join(clientSrc, file), "utf8");

  it("is registered per server and served under the field the client reads", () => {
    const def = FEATURE_FLAGS.share_fast_start_quality;
    expect(def.perServer).toBe(true);
    expect(def.codeDefault).toBe(false);
    expect(def.clientVia).toBe("GET /api/share/config (shareFastStartQuality)");
    expect(Object.keys(shareConfigForServer(null))).toContain("shareFastStartQuality");
  });

  it("the share config's answer is handed to the store the session reads", () => {
    expect(read("lib/share-guard-flag.ts")).toMatch(
      /recordShareFastStartQuality\(\s*serverId,\s*config\.shareFastStartQuality === true/,
    );
  });

  it("the call names its server before the media connects", () => {
    const app = read("App.tsx");
    expect(app).toMatch(/setShareFastStartServer\(serverId\)/);
    expect(app).toMatch(/noteCallServer\(selectedServerId\)/);
  });

  it("the LiveKit session reads it on both sides", () => {
    const session = read("lib/livekit-session.ts");
    expect(session).toContain("requestShareQualityBeforeSubscribe");
    expect(session).toMatch(/trigger === "room" && shareFastStartQualityActive\(\)/);
    expect(session).toMatch(/shareFastStartQualityActive\(\) &&\s*\(hlsSource === null/);
  });
});

/**
 * THE WATCH NOW FLAGS, `watch_now_banner` and `stream_start_notifications`.
 *
 * Same lesson as the share config above, one more time, because this feature
 * is the one that could ship its client and its server as two halves. Both
 * flags reach the client as booleans on `GET /api/live-hls/config?serverId=`;
 * the client reads them off the answer `useLiveHlsConfig` hands the app, and
 * the start-of-stream notice reaches it as a `stream-started` frame. Each piece
 * is pinned from BOTH sides: the field the client's type names must be a field
 * the server sends, the flag the registry names must be the one the answer is
 * built from, and the frame the server writes must be one the client handles.
 */
describe("the watch now flags against the live-hls config the client reads", () => {
  const FIELDS = [
    { key: "watch_now_banner", field: "watchNowBanner" },
    { key: "stream_start_notifications", field: "streamStartNotifications" },
  ] as const;

  it("the client's LiveHlsConfig type names both fields", () => {
    const api = readFileSync(path.join(clientSrc, "lib/api.ts"), "utf8");
    const body = /export interface LiveHlsConfig \{([\s\S]*?)\n\}/.exec(api)?.[1];
    expect(body, "client LiveHlsConfig interface not found in lib/api.ts").toBeTruthy();
    for (const { field } of FIELDS) {
      expect(body, `LiveHlsConfig does not declare ${field}`).toMatch(
        new RegExp(`^\\s{2}${field}\\??:`, "m"),
      );
    }
  });

  it("the deployment-wide answer carries both, as booleans", () => {
    const served = liveHlsConfig() as unknown as Record<string, unknown>;
    for (const { field } of FIELDS) {
      expect(typeof served[field], `${field} on liveHlsConfig()`).toBe("boolean");
    }
  });

  it("the per-server answer reads each flag for THAT server, and the registry says so", () => {
    const egress = readFileSync(path.join(serverSrc, "voice/hls-egress.ts"), "utf8");
    const perServer = /export async function liveHlsConfigForServer[\s\S]*?\n\}\n/.exec(egress)?.[0];
    expect(perServer, "liveHlsConfigForServer not found").toBeTruthy();
    for (const { key, field } of FIELDS) {
      expect(perServer, `${field} is not built in liveHlsConfigForServer`).toMatch(
        new RegExp(`${field}:\\s*isEnabled\\(\\s*"${key}",\\s*\\{\\s*serverId`),
      );
      const def = FEATURE_FLAGS[key];
      expect(def.perServer, `${key} must be per server: the config is asked per server`).toBe(true);
      expect(def.clientVia).toContain(`(${field})`);
      expect(def.clientVia).toContain("/api/live-hls/config");
    }
  });

  it("the client reads both fields off the config the app holds", () => {
    const readers = clientFiles.filter(
      ({ text }) => text.includes("useLiveHlsConfig") || text.includes("fetchLiveHlsConfig"),
    );
    expect(readers.length).toBeGreaterThan(0);
    // Outside the type declaration itself: a field only `lib/api.ts` names is a
    // field nothing reads.
    const outsideTheType = clientFiles.filter(
      ({ file }) => !file.endsWith(path.join("lib", "api.ts")),
    );
    for (const { field } of FIELDS) {
      expect(mentions(outsideTheType, field), `no client source reads ${field}`).toBe(true);
    }
  });
});

describe("the stream-started frame", () => {
  it("is written by the server and handled by the client", () => {
    expect(
      mentions(serverFiles, "stream-started"),
      "no server source sends a stream-started frame",
    ).toBe(true);
    const handlers = clientFiles.filter(({ text }) => /["']stream-started["']/.test(text));
    expect(handlers.length, "no client source handles a stream-started frame").toBeGreaterThan(0);
  });

  it("is a type the chat socket's schema knows, so the client parses it", () => {
    const chat = readFileSync(path.resolve(here, "../../../packages/shared/src/chat.ts"), "utf8");
    expect(chat).toContain("streamStartedSchema");
  });
});

/**
 * `newcomer_invite_moment`, the "chama teus amigos" strip. A global client
 * flag on its own config route: pinned from both sides so the strip cannot
 * ship reading a field the server never sends.
 */
describe("newcomer_invite_moment against the onboarding config the client reads", () => {
  it("is global, off by default, and named under the field the route serves", () => {
    const def = FEATURE_FLAGS.newcomer_invite_moment;
    expect(def.perServer).toBe(false);
    expect(def.codeDefault).toBe(false);
    expect(def.clientVia).toBe("GET /api/onboarding/config (inviteMoment)");
  });

  it("the route is mounted and answers from the flag", () => {
    const api = readFileSync(path.join(serverSrc, "api/index.ts"), "utf8");
    const route = /router\.get\("\/api\/onboarding\/config"[\s\S]*?\);/.exec(api)?.[0];
    expect(route, "GET /api/onboarding/config is not mounted").toBeTruthy();
    expect(route).toContain('inviteMoment: isEnabled("newcomer_invite_moment")');
  });

  it("the client asks that route and reads inviteMoment off the answer", () => {
    const lib = readFileSync(path.join(clientSrc, "lib/newcomer-invite.ts"), "utf8");
    expect(lib).toContain("/api/onboarding/config");
    expect(lib).toMatch(/\.inviteMoment === true/);
    const app = readFileSync(path.join(clientSrc, "App.tsx"), "utf8");
    expect(app).toMatch(/newcomerInviteUserId \? startNewcomerInviteConfig\(\) : undefined/);
  });
});

/**
 * `discord_import_notice`, the "veio do Discord?" card in a small, new
 * server's main channel. A global client flag on the same config route as
 * the newcomer strip, plus one field on the arrivals route.
 */
describe("discord_import_notice against the onboarding config the client reads", () => {
  it("is global, off by default, and named under the fields the routes serve", () => {
    const def = FEATURE_FLAGS.discord_import_notice;
    expect(def.perServer).toBe(false);
    expect(def.codeDefault).toBe(false);
    expect(def.clientVia).toContain("GET /api/onboarding/config (discordImportNotice)");
    expect(def.clientVia).toContain("GET /api/servers/:id/import-arrivals (imported)");
  });

  it("the config route answers from the flag", () => {
    const api = readFileSync(path.join(serverSrc, "api/index.ts"), "utf8");
    const route = /router\.get\("\/api\/onboarding\/config"[\s\S]*?\);/.exec(api)?.[0];
    expect(route, "GET /api/onboarding/config is not mounted").toBeTruthy();
    expect(route).toContain('discordImportNotice: isEnabled("discord_import_notice")');
  });

  it("the client reads discordImportNotice and imported off those answers", () => {
    const lib = readFileSync(path.join(clientSrc, "lib/discord-import-notice.ts"), "utf8");
    expect(lib).toContain("/api/onboarding/config");
    expect(lib).toMatch(/\.discordImportNotice === true/);
    const app = readFileSync(path.join(clientSrc, "App.tsx"), "utf8");
    expect(app).toMatch(/startDiscordImportNoticeConfig\(\)/);
    // The app hands the arrivals answer's field over, and the rule demands an
    // explicit `false` (an older API's missing field must show nothing).
    expect(app).toMatch(/imported: bringCrew\.arrivals\?\.imported/);
    expect(lib).toMatch(/facts\.imported === false/);
  });
});

/**
 * `hint_diet` and `hint_budget`, the hints audit's two switches. Global client
 * flags on the onboarding config route, read by one client module.
 */
describe("hint_diet and hint_budget against the onboarding config the client reads", () => {
  it("are global, off by default, and named under the fields the route serves", () => {
    for (const [key, field] of [
      ["hint_diet", "hintDiet"],
      ["hint_budget", "hintBudget"],
    ] as const) {
      const def = FEATURE_FLAGS[key];
      expect(def.perServer, key).toBe(false);
      expect(def.codeDefault, key).toBe(false);
      expect(def.clientVia, key).toBe(`GET /api/onboarding/config (${field})`);
    }
  });

  it("the config route answers from both flags", () => {
    const api = readFileSync(path.join(serverSrc, "api/index.ts"), "utf8");
    const route = /router\.get\("\/api\/onboarding\/config"[\s\S]*?\);/.exec(api)?.[0];
    expect(route, "GET /api/onboarding/config is not mounted").toBeTruthy();
    expect(route).toContain('hintDiet: isEnabled("hint_diet")');
    expect(route).toContain('hintBudget: isEnabled("hint_budget")');
  });

  it("the client asks that route, reads both fields, and App starts the reader", () => {
    const config = readFileSync(path.join(clientSrc, "lib/hint-config.ts"), "utf8");
    expect(config).toContain("/api/onboarding/config");
    const diet = readFileSync(path.join(clientSrc, "lib/hint-diet.ts"), "utf8");
    expect(diet).toMatch(/\.hintDiet === true/);
    const quiet = readFileSync(path.join(clientSrc, "lib/hint-quiet.ts"), "utf8");
    expect(quiet).toMatch(/\.hintBudget === true/);
    const app = readFileSync(path.join(clientSrc, "App.tsx"), "utf8");
    expect(app).toMatch(/newcomerInviteUserId \? startHintConfig\(\) : undefined/);
  });
});

/**
 * `conversations_home` and `conversations_home_phone_tabs`, Conversas. Two
 * global client flags served on one route that web, iOS and Android all read.
 */
describe("conversations_home against GET /api/dms/config", () => {
  it("both flags are global, off by default, and named under the fields the route serves", () => {
    const home = FEATURE_FLAGS.conversations_home;
    expect(home.perServer).toBe(false);
    expect(home.codeDefault).toBe(false);
    expect(home.clientVia).toBe("GET /api/dms/config (home)");
    const tabs = FEATURE_FLAGS.conversations_home_phone_tabs;
    expect(tabs.perServer).toBe(false);
    expect(tabs.codeDefault).toBe(false);
    expect(tabs.clientVia).toBe("GET /api/dms/config (phoneTabs)");
  });

  it("the route is mounted and answers from both flags", () => {
    const api = readFileSync(path.join(serverSrc, "api/index.ts"), "utf8");
    const route = /router\.get\("\/api\/dms\/config"[\s\S]*?\n\}\);/.exec(api)?.[0];
    expect(route, "GET /api/dms/config is not mounted").toBeTruthy();
    expect(route).toContain('isEnabled("conversations_home")');
    expect(route).toContain('isEnabled("conversations_home_phone_tabs")');
    expect(route).toMatch(/\bhome,/);
    expect(route).toMatch(/\bphoneTabs:/);
  });

  it("the web client asks that route and reads both fields off the answer", () => {
    const lib = readFileSync(path.join(clientSrc, "lib/conversations-config.ts"), "utf8");
    expect(lib).toContain('"/api/dms/config"');
    expect(lib).toMatch(/answer\.home === true/);
    expect(lib).toMatch(/answer\.phoneTabs === true/);
  });
});

/**
 * `forum_channels`, born with forum PR 0. Per server, off by default, and the
 * one flag here whose field (`enabled`) is too common a word for the generic
 * "both sides mention it" check above to mean anything, so each half is
 * pinned by name: the route, the per-server read, the create guard the flag
 * exists for, and the client's type and fetcher.
 */
describe("forum_channels against the forum config the client reads", () => {
  it("is per server, off by default, and served as `enabled`", () => {
    const def = FEATURE_FLAGS.forum_channels;
    expect(def.perServer).toBe(true);
    expect(def.codeDefault).toBe(false);
    expect(def.clientVia).toBe("GET /api/forum/config?serverId= (enabled)");
    expect(Object.keys(forumConfigForServer(null))).toEqual(["enabled"]);
  });

  it("the route is mounted, asked per server, and answers from the flag", () => {
    const api = readFileSync(path.join(serverSrc, "api/index.ts"), "utf8");
    const route = /router\.get\("\/api\/forum\/config"[\s\S]*?\);/.exec(api)?.[0];
    expect(route, "GET /api/forum/config is not mounted").toBeTruthy();
    expect(route).toContain("forumConfigForServer(");
    expect(route).toContain('searchParams.get("serverId")');
    const lib = readFileSync(path.join(serverSrc, "lib/forum-config.ts"), "utf8");
    expect(lib).toMatch(/isEnabled\("forum_channels",\s*\{\s*serverId\s*\}\)/);
  });

  it("creating a forum channel is refused unless the flag is on for that server", () => {
    const api = readFileSync(path.join(serverSrc, "api/index.ts"), "utf8");
    const route = /router\.post\(\s*"\/api\/servers\/:serverId\/channels"[\s\S]*?\n\);/.exec(
      api,
    )?.[0];
    expect(route, "POST /api/servers/:serverId/channels not found").toBeTruthy();
    expect(route).toMatch(
      /body\.type === "forum" && !forumChannelsEnabled\(serverId!\)[\s\S]*?FORUM_CHANNELS_OFF/,
    );
  });

  it("the client's ForumConfig names exactly the field the server sends, asked per server", () => {
    const api = readFileSync(path.join(clientSrc, "lib/api.ts"), "utf8");
    const body = /export interface ForumConfig \{([\s\S]*?)\n\}/.exec(api)?.[1];
    expect(body, "client ForumConfig interface not found in lib/api.ts").toBeTruthy();
    const declared = [...body!.matchAll(/^\s{2}([A-Za-z]\w*)\??:/gm)].map((match) => match[1]!);
    expect(declared).toEqual(Object.keys(forumConfigForServer(null)));
    expect(api).toMatch(/\/api\/forum\/config\?serverId=/);
  });

  it("the dashboard has a note for it", () => {
    const dashboard = readFileSync(
      path.resolve(here, "../../../tools/admin-dashboard/site/novo.js"),
      "utf8",
    );
    expect(dashboard).toMatch(/\bforum_channels:\s*"/);
  });
});

/**
 * Stories: `stories` per server, `stories_friends` global, both off. No
 * `(field)` in `clientVia` until a client reads the config (the generic check
 * above would rightly fail a field nobody reads); the route halves are pinned
 * by the stories server tests. What is pinned here is the registry the
 * dashboard draws, and that the operator gets a note before flipping either.
 */
describe("the stories flags", () => {
  it("stories is per server and off; stories_friends is global and off", () => {
    expect(FEATURE_FLAGS.stories.perServer).toBe(true);
    expect(FEATURE_FLAGS.stories.codeDefault).toBe(false);
    expect(FEATURE_FLAGS.stories_friends.perServer).toBe(false);
    expect(FEATURE_FLAGS.stories_friends.codeDefault).toBe(false);
  });

  it("the dashboard has a note for both", () => {
    const dashboard = readFileSync(
      path.resolve(here, "../../../tools/admin-dashboard/site/novo.js"),
      "utf8",
    );
    expect(dashboard).toMatch(/\bstories:\s*"/);
    expect(dashboard).toMatch(/\bstories_friends:\s*"/);
  });

  it("the config route is mounted and answers from both flags, per server", () => {
    const api = readFileSync(path.join(serverSrc, "api/index.ts"), "utf8");
    const route = /router\.get\("\/api\/stories\/config"[\s\S]*?\}\);/.exec(api)?.[0];
    expect(route, "GET /api/stories/config is not mounted").toBeTruthy();
    expect(route).toContain("storiesConfig(");
    expect(route).toContain('searchParams.get("serverId")');
    const service = readFileSync(path.join(serverSrc, "services/stories.ts"), "utf8");
    expect(service).toMatch(/isEnabled\("stories", \{ serverId \}\)/);
    expect(service).toMatch(/isEnabled\("stories_friends"\)/);
  });
});

/**
 * `apps` and `locadora_share`, born with the apps platform. `apps` is per
 * server, off by default, and served as `enabled` by `GET /api/apps/config`
 * (its route lives in `api/app-routes.ts`, mounted from `api/index.ts`).
 * `locadora_share` has no `(field)` in `clientVia` until a client reads the
 * per-app `shareAllowed`, which the generic check above would rightly fail; the
 * server half (the field, the read) is pinned here instead.
 */
describe("apps and locadora_share against the config the client reads", () => {
  it("apps is per server, off by default, and served as `enabled`", () => {
    const def = FEATURE_FLAGS.apps;
    expect(def.perServer).toBe(true);
    expect(def.codeDefault).toBe(false);
    expect(def.clientVia).toBe("GET /api/apps/config?serverId= (enabled)");
  });

  it("the route is mounted from the router file and asked per server", () => {
    const api = readFileSync(path.join(serverSrc, "api/index.ts"), "utf8");
    expect(api).toMatch(/registerAppRoutes\(router\)/);
    const routes = readFileSync(path.join(serverSrc, "api/app-routes.ts"), "utf8");
    const route = /router\.get\("\/api\/apps\/config"[\s\S]*?\n {2}\}\);/.exec(routes)?.[0];
    expect(route, "GET /api/apps/config is not mounted").toBeTruthy();
    expect(route).toContain('searchParams.get("serverId")');
    expect(route).toContain("appsConfigForServer(");
    const config = readFileSync(path.join(serverSrc, "apps/config.ts"), "utf8");
    expect(config).toMatch(/isEnabled\("apps",\s*\{\s*serverId\s*\}\)/);
  });

  it("locadora_share is per server, off, and read by appShareAllowed which the config serves as shareAllowed", () => {
    const def = FEATURE_FLAGS.locadora_share;
    expect(def.perServer).toBe(true);
    expect(def.codeDefault).toBe(false);
    const availability = readFileSync(path.join(serverSrc, "apps/availability.ts"), "utf8");
    expect(availability).toMatch(/isEnabled\("locadora_share",\s*\{\s*serverId\s*\}\)/);
    const config = readFileSync(path.join(serverSrc, "apps/config.ts"), "utf8");
    expect(config).toMatch(/shareAllowed:\s*appShareAllowed\(/);
  });

  it("the dashboard has a note for both", () => {
    const dashboard = readFileSync(
      path.resolve(here, "../../../tools/admin-dashboard/site/novo.js"),
      "utf8",
    );
    expect(dashboard).toMatch(/\bapps:\s*"/);
    expect(dashboard).toMatch(/\blocadora_share:\s*"/);
  });
});

/**
 * `locadora_save_sync`: Saves na conta. Per server, off. It amends rule 7 of
 * docs/EMULATOR_ROOM.md ("the server knows nothing but the flag"), so what the
 * amendment allows is pinned here: the routes live in their own file, mounted
 * from the apps routes, every one of them under `/api/apps/pqp-locadora/saves`
 * and gated by `saveContext`, which reads this flag for the session's server;
 * the config serves `saveSync`, which the join sheet reads; and the emulator's
 * own config route is still the one route about the emulator.
 */
describe("locadora_save_sync and the routes rule 7 now allows", () => {
  it("is per server, off, and served as saveSync", () => {
    const def = FEATURE_FLAGS.locadora_save_sync;
    expect(def.perServer).toBe(true);
    expect(def.codeDefault).toBe(false);
    expect(def.clientVia).toBe("GET /api/apps/config?serverId= (saveSync)");
    const config = readFileSync(path.join(serverSrc, "apps/config.ts"), "utf8");
    expect(config).toMatch(/saveSync:\s*manifest\.id === LOCADORA_APP_ID && isEnabled\("locadora_save_sync",\s*\{\s*serverId\s*\}\)/);
  });

  it("every save route is under /api/apps/pqp-locadora/saves and goes through the gate first", () => {
    const routes = readFileSync(path.join(serverSrc, "api/locadora-save-routes.ts"), "utf8");
    expect(readFileSync(path.join(serverSrc, "api/app-routes.ts"), "utf8")).toMatch(/registerLocadoraSaveRoutes\(router\)/);
    expect(routes).toContain('const BASE = "/api/apps/pqp-locadora/saves";');
    const handlers = [...routes.matchAll(/router\.(get|post|delete)\(([^,]+),[\s\S]*?\n {2}\}\);/g)];
    expect(handlers.length).toBe(8);
    for (const [handler, , route] of handlers) {
      expect(route, handler).toMatch(/^`?\$\{BASE\}|^BASE$/);
      expect(handler, route).toContain("saveContext(user.id");
    }
    const service = readFileSync(path.join(serverSrc, "apps/locadora-saves.ts"), "utf8");
    expect(service).toMatch(/isEnabled\("locadora_save_sync",\s*\{\s*serverId\s*\}\)/);
    expect(service).toMatch(/isEnabled\("apps",\s*\{\s*serverId\s*\}\)/);
    expect(service).toMatch(/isEnabled\("emulator_room",\s*\{\s*serverId\s*\}\)/);
  });

  it("the emulator's own config is still its one route", () => {
    const api = readFileSync(path.join(serverSrc, "api/index.ts"), "utf8");
    expect(api.match(/"\/api\/emulator\/[^"]*"/g)).toEqual(['"/api/emulator/config"']);
  });

  it("the dashboard has a note for it", () => {
    const dashboard = readFileSync(path.resolve(here, "../../../tools/admin-dashboard/site/novo.js"), "utf8");
    expect(dashboard).toMatch(/\blocadora_save_sync:\s*"/);
  });
});

/**
 * `apps_landing`, the public pqp Apps pages. A global client flag on its own
 * unauthenticated route (`GET /api/public/apps/config`), read by the page's
 * gate and by the Pages middleware. Pinned from both sides, and the route is
 * checked to sit BEFORE the authenticated router, because a signed-out visitor
 * is who the pages are for: a route behind the Bearer resolution would answer
 * them 401 and the pages would be dark for exactly the people they exist for.
 */
describe("apps_landing against the public apps config the pages read", () => {
  it("is global, off by default, and named under the route that serves it", () => {
    const def = FEATURE_FLAGS.apps_landing;
    expect(def.perServer).toBe(false);
    expect(def.codeDefault).toBe(false);
    expect(def.clientVia).toBe("GET /api/public/apps/config (enabled)");
  });

  it("the route is matched before the authenticated router and answers from the flag alone", () => {
    const api = readFileSync(path.join(serverSrc, "api/index.ts"), "utf8");
    const fn = /function servePublicAppsConfig[\s\S]*?\n\}\n/.exec(api)?.[0];
    expect(fn, "servePublicAppsConfig not found").toBeTruthy();
    expect(fn).toContain("JSON.stringify(await publicAppsConfig())");
    expect(fn).not.toMatch(/authorization|resolveAuth/i);
    const body = readFileSync(path.join(serverSrc, "apps/public-config.ts"), "utf8");
    expect(body).toContain('isEnabled("apps_landing")');
    expect(body).toContain('isEnabled("locadora_guest")');
    expect(body).toContain('isEnabled("locadora_saves_announced")');
    // no credential is read, and every flag is read globally (no `{ serverId }`)
    expect(body).not.toMatch(/resolveAuth|headers\.authorization|isEnabled\("[a-z_]+",\s*\{/);
    const matched = api.indexOf("servePublicAppsConfig(req, res);");
    const router = api.indexOf("router.match(method, pathname)", matched);
    expect(matched, "route is not matched in handleApi").toBeGreaterThan(0);
    expect(router, "router.match not found after it").toBeGreaterThan(matched);
  });

  it("the client asks that route with no credential and the edge asks it too", () => {
    const lib = readFileSync(path.join(clientSrc, "lib/apps-landing.ts"), "utf8");
    expect(lib).toContain("/api/public/apps/config");
    expect(lib).toMatch(/publicAppsConfigSchema\.safeParse/);
    expect(lib).not.toMatch(/authorization/i);
    const middleware = readFileSync(
      path.resolve(here, "../../../client/functions/_middleware.ts"),
      "utf8",
    );
    expect(middleware).toContain("/api/public/apps/config");
  });

  it("the dashboard has a note for it", () => {
    const dashboard = readFileSync(
      path.resolve(here, "../../../tools/admin-dashboard/site/novo.js"),
      "utf8",
    );
    expect(dashboard).toMatch(/\bapps_landing:\s*"/);
  });
});

/**
 * `locadora_guest` (guest play) and `locadora_saves_announced` (the public
 * cloud-saves sentence): two global flags on the same public route, read by the
 * guest player, the Locadora page and the edge. Guest play needs the landing
 * flag too, which the server decides, so the client never has to combine them.
 */
describe("locadora_guest and locadora_saves_announced against the public apps config", () => {
  it("are global, off by default, and named under the route that serves them", () => {
    expect(FEATURE_FLAGS.locadora_guest.perServer).toBe(false);
    expect(FEATURE_FLAGS.locadora_guest.codeDefault).toBe(false);
    expect(FEATURE_FLAGS.locadora_guest.clientVia).toBe("GET /api/public/apps/config (guest)");
    expect(FEATURE_FLAGS.locadora_saves_announced.perServer).toBe(false);
    expect(FEATURE_FLAGS.locadora_saves_announced.codeDefault).toBe(false);
    expect(FEATURE_FLAGS.locadora_saves_announced.clientVia).toBe("GET /api/public/apps/config (cloudSaves)");
  });

  it("guest play is only ever offered with the landing flag on", () => {
    const body = readFileSync(path.join(serverSrc, "apps/public-config.ts"), "utf8");
    expect(body).toMatch(/if \(!enabled \|\| !isEnabled\("locadora_guest"\) \|\| !origin\)/);
  });

  it("the client reads both fields through the shared schema and the edge reads guest", () => {
    const lib = readFileSync(path.join(clientSrc, "lib/apps-landing.ts"), "utf8");
    expect(lib).toContain("publicAppsConfigSchema");
    const middleware = readFileSync(path.resolve(here, "../../../client/functions/_middleware.ts"), "utf8");
    expect(middleware).toMatch(/body\.guest/);
  });

  it("the dashboard has a note for each", () => {
    const dashboard = readFileSync(path.resolve(here, "../../../tools/admin-dashboard/site/novo.js"), "utf8");
    expect(dashboard).toMatch(/\blocadora_guest:\s*"/);
    expect(dashboard).toMatch(/\blocadora_saves_announced:\s*"/);
  });
});

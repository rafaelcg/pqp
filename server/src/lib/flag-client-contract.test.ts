import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { FEATURE_FLAGS } from "./flags.js";
import { shareConfigForServer } from "./share-config.js";
import { voiceConfigForServer } from "./voice-config.js";

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

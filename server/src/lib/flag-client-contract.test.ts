import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { FEATURE_FLAGS } from "./flags.js";
import { shareConfigForServer } from "./share-config.js";

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

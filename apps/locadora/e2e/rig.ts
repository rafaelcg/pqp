import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { BrowserContext } from "@playwright/test";
import type { AppManifest } from "@pqp/shared";
import { buildAll } from "../../../tools/apps-build/src/build.mts";
import { startDevServer } from "../../../tools/apps-build/src/dev-server.mts";

const here = dirname(fileURLToPath(import.meta.url));

export interface CanaryHit {
  kind: "http" | "tcp";
  url?: string;
  method?: string;
}

export interface Rig {
  hostOrigin: string;
  appsOrigin: string;
  frameUrl: string;
  manifest: AppManifest;
  canaryPort: number;
  /** Everything that reached the canary. Any entry is a leak. */
  canaryHits: CanaryHit[];
  /** The apps origin sends `frame-ancestors` for the real pqp origins; allow this test host too, nothing else changes. */
  allowHostAsAncestor(context: BrowserContext): Promise<void>;
  /** Saves na conta's stand-in account, shared by every host page of the rig (`?sync=computer|phone`). */
  account: Account;
  close(): Promise<void>;
}

/** What `host.js` asks the stand-in account; bytes travel as base64. */
type SyncCall =
  | { op: "status" }
  | { op: "list"; game: string; deviceId: string }
  | { op: "get"; save: string }
  | {
      op: "put";
      game: string;
      kind: string;
      slot: number;
      baseRev: number;
      bytes: string;
      thumb: string | null;
      platform: string;
      core: string;
      coreVersion: string;
      deviceKind: string;
      deviceId: string;
    }
  | { op: "delete"; save: string }
  | { op: "clear"; game?: string };

interface AccountRow {
  id: string;
  game: string;
  kind: string;
  slot: number;
  rev: number;
  bytes: Buffer;
  thumb: Buffer | null;
  savedAt: number;
  deviceKind: string;
  deviceId: string;
  platform: string;
  core: string;
  coreVersion: string;
}

export interface Account {
  rows: Map<string, AccountRow>;
  /** Every save that was sent up: its size and the hash of its bytes, so a test can tell it is not the game. */
  puts: Array<{ kind: string; slot: number; size: number; sha256: string }>;
  handle(call: SyncCall): unknown;
}

/**
 * A stand-in for the server half of Saves na conta (server/src/apps/locadora-saves.ts), with its one rule that
 * matters to the app: a write names the rev it replaces, and an older one is refused (`stale-rev`). The game the
 * host names is already a key here, as on the real server; this account never sees the game file.
 */
function createAccount(): Account {
  const rows = new Map<string, AccountRow>();
  const puts: Account["puts"] = [];
  let next = 1;
  const usage = () => {
    let used = 0;
    for (const row of rows.values()) used += row.bytes.length + (row.thumb?.length ?? 0);
    return { used, cap: 8 * 1024 * 1024 };
  };
  const sha = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
  const byId = (id: string) => [...rows.entries()].find(([, row]) => row.id === id);
  return {
    rows,
    puts,
    handle(call) {
      switch (call.op) {
        case "status":
          return { ok: true, result: { mode: "on", ...usage() } };
        case "list":
          return {
            ok: true,
            result: [...rows.values()]
              .filter((row) => row.game === call.game)
              .map((row) => ({
                id: row.id,
                kind: row.kind,
                slot: row.slot,
                rev: row.rev,
                size: row.bytes.length,
                hash: sha(row.bytes),
                savedAt: row.savedAt,
                device: row.deviceKind,
                thisDevice: row.deviceId === call.deviceId,
                thumb: row.thumb !== null,
                platform: row.platform,
                core: row.core,
                coreVersion: row.coreVersion,
                history: 0,
              })),
          };
        case "get": {
          const row = byId(call.save)?.[1];
          if (!row) return { ok: false, error: "not-allowed" };
          return { ok: true, result: { rev: row.rev, bytes: row.bytes.toString("base64"), thumb: row.thumb?.toString("base64") ?? null } };
        }
        case "put": {
          const key = `${call.game}:${call.kind}:${call.slot}`;
          const current = rows.get(key);
          if ((current?.rev ?? 0) !== call.baseRev) return { ok: false, error: "stale-rev" };
          const bytes = Buffer.from(call.bytes, "base64");
          puts.push({ kind: call.kind, slot: call.slot, size: bytes.length, sha256: sha(bytes) });
          const row: AccountRow = {
            id: current?.id ?? `5b7b9f4e-8c0d-4f0a-9d6e-${String(next++).padStart(12, "0")}`,
            game: call.game,
            kind: call.kind,
            slot: call.slot,
            rev: (current?.rev ?? 0) + 1,
            bytes,
            thumb: call.thumb ? Buffer.from(call.thumb, "base64") : null,
            savedAt: Date.now(),
            deviceKind: call.deviceKind,
            deviceId: call.deviceId,
            platform: call.platform,
            core: call.core,
            coreVersion: call.coreVersion,
          };
          rows.set(key, row);
          return { ok: true, result: { id: row.id, rev: row.rev, ...usage() } };
        }
        case "delete": {
          const found = byId(call.save);
          if (found) rows.delete(found[0]);
          return { ok: true, result: usage() };
        }
        case "clear": {
          let deleted = 0;
          for (const [key, row] of [...rows.entries()]) {
            if (!call.game || row.game === call.game) {
              rows.delete(key);
              deleted += 1;
            }
          }
          return { ok: true, result: { deleted, ...usage() } };
        }
      }
    },
  };
}

function listen(server: http.Server): Promise<number> {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve((server.address() as AddressInfo).port));
  });
}

/**
 * Three local servers and a real build:
 *  - the apps origin: Locadora built by the real packager into a temp folder and served with its real
 *    `_headers` (the CSP the frame runs under);
 *  - a page that plays the pqp host (`host/host.js`);
 *  - a CANARY on another port that records every HTTP request and every raw TCP connection. If the sandbox
 *    leaks anything, it shows up there.
 */
export async function startRig(): Promise<Rig> {
  const dist = mkdtempSync(join(tmpdir(), "pqp-locadora-e2e-"));
  const built = await buildAll({ outDir: dist, only: ["locadora"] });
  const app = built.apps[0];
  if (!app) throw new Error("Locadora did not build");

  const appsServer = await startDevServer(dist, 0);
  const appsPort = (appsServer.address() as AddressInfo).port;
  const appsOrigin = `http://localhost:${appsPort}`;
  const base = `${appsOrigin}/${app.manifest.id}/${app.manifest.version}`;
  const frameUrl = `${base}/index.html`;

  const canaryHits: CanaryHit[] = [];
  const canary = http.createServer((req, res) => {
    canaryHits.push({ kind: "http", url: req.url, method: req.method });
    res.writeHead(200, { "content-type": "text/plain", "access-control-allow-origin": "*" });
    res.end("hi");
  });
  canary.on("connection", () => canaryHits.push({ kind: "tcp" }));
  const canaryPort = await listen(canary);

  const localFiles = app.manifest.capabilities.localFiles;
  const deviceStore = app.manifest.capabilities.deviceStore;
  const spec = {
    frame: frameUrl,
    base,
    version: app.manifest.version,
    assets: app.manifest.assets ?? [],
    accept: localFiles.allowed ? localFiles.accept : [],
    maxBytes: localFiles.allowed ? localFiles.maxBytes : 0,
    storeCap: deviceStore?.allowed ? deviceStore.maxBytes : 0,
    self: { seatId: "seat-test-aaaaaaaaaaaaaaaa", role: "player", isHost: true },
  };
  const account = createAccount();
  const host = http.createServer((req, res) => {
    const path = (req.url ?? "/").split("?")[0];
    if (path === "/sync" && req.method === "POST") {
      const chunks: Buffer[] = [];
      req.on("data", (chunk: Buffer) => chunks.push(chunk));
      req.on("end", () => {
        const answer = account.handle(JSON.parse(Buffer.concat(chunks).toString("utf8")) as SyncCall);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(answer));
      });
      return;
    }
    if (path === "/spec.json") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(spec));
    } else if (path === "/" || path === "/host.html") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(readFileSync(join(here, "host/host.html")));
    } else if (path === "/host.js") {
      res.writeHead(200, { "content-type": "text/javascript; charset=utf-8" });
      res.end(readFileSync(join(here, "host/host.js")));
    } else {
      res.writeHead(404).end();
    }
  });
  const hostPort = await listen(host);
  const hostOrigin = `http://localhost:${hostPort}`;

  return {
    hostOrigin,
    appsOrigin,
    frameUrl,
    manifest: app.manifest,
    canaryPort,
    canaryHits,
    account,
    async allowHostAsAncestor(context) {
      await context.route(`${appsOrigin}/**`, async (route) => {
        try {
          const response = await route.fetch();
          const headers = { ...response.headers() };
          for (const name of Object.keys(headers)) {
            if (name.toLowerCase() === "content-security-policy") {
              headers[name] = headers[name]!.replace("frame-ancestors", `frame-ancestors ${hostOrigin}`);
            }
          }
          await route.fulfill({ response, headers });
        } catch (error) {
          // a test that closes its context while the frame still loads a picture (the shelf's TV, a cartridge) leaves
          // this request with nowhere to go: that is the test being done, not a failure of the frame
          if (!/disposed|closed|Test ended/i.test(String(error))) throw error;
        }
      });
    },
    async close() {
      await Promise.all([appsServer, canary, host].map((server) => new Promise<void>((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      })));
      rmSync(dist, { recursive: true, force: true });
    },
  };
}

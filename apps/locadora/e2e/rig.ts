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
  close(): Promise<void>;
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
  const spec = {
    frame: frameUrl,
    base,
    version: app.manifest.version,
    assets: app.manifest.assets ?? [],
    accept: localFiles.allowed ? localFiles.accept : [],
    maxBytes: localFiles.allowed ? localFiles.maxBytes : 0,
    self: { seatId: "seat-test-aaaaaaaaaaaaaaaa", role: "player", isHost: true },
  };
  const host = http.createServer((req, res) => {
    const path = (req.url ?? "/").split("?")[0];
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
    async allowHostAsAncestor(context) {
      await context.route(`${appsOrigin}/**`, async (route) => {
        const response = await route.fetch();
        const headers = { ...response.headers() };
        for (const name of Object.keys(headers)) {
          if (name.toLowerCase() === "content-security-policy") {
            headers[name] = headers[name]!.replace("frame-ancestors", `frame-ancestors ${hostOrigin}`);
          }
        }
        await route.fulfill({ response, headers });
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

/**
 * Starts a desktop app binary and attaches to it over the Chrome DevTools
 * Protocol, so a test can drive the app EXACTLY as it ships.
 *
 * WHY CDP AND NOT PLAYWRIGHT'S `_electron.launch`. The release binary is built
 * with the Node CLI inspect fuse off (`enableNodeCliInspectArguments: false`
 * in electron/package.json), and `_electron.launch` attaches through
 * `--inspect`, so it cannot open the artifact users download. It could open a
 * differently fused copy, which would be a test of a binary nobody runs.
 * `--remote-debugging-port` is a Chromium switch, not a Node one: no fuse
 * gates it, and it reaches every renderer (the app window and the share
 * picker) while the main process stays exactly as shipped. What it cannot
 * reach is the main process itself, which is why everything this test checks
 * is observed from a renderer or from the process's own log.
 *
 * Nothing here is test-only code inside the app: the binary is started with
 * two documented switches (`PQP_ALLOW_APP_URL_OVERRIDE=1` with `PQP_APP_URL`,
 * see electron/lib/app-url.js; `PQP_DISABLE_AUTO_UPDATE=1`) and two Chromium
 * ones (`--remote-debugging-port`, `--user-data-dir`, which keeps the test out
 * of a developer's real profile and single-instance lock).
 */
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { createWriteStream, existsSync, mkdtempSync, readFileSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { createServer as createNetServer } from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";

const here = path.dirname(fileURLToPath(import.meta.url));
export const ELECTRON_DIR = path.resolve(here, "..", "..");
export const PAGE_DIR = process.env.PQP_SHARE_SMOKE_PAGE_DIR
  ? path.resolve(process.env.PQP_SHARE_SMOKE_PAGE_DIR)
  : path.join(here, ".page");

/**
 * What to run. `PQP_SHARE_SMOKE_APP` names the packaged app: the executable,
 * or on macOS the `.app` bundle. Unset runs the repo's own unpackaged shell
 * with the repo's Electron, which is the developer loop and NOT the gate:
 * that binary is unfused and unsigned.
 */
export function resolveApp(target = process.env.PQP_SHARE_SMOKE_APP) {
  if (!target && process.env.PQP_SHARE_SMOKE_REQUIRE_PACKAGED === "1") {
    // A gate that quietly fell back to the repo's Electron would be testing a
    // binary nobody downloads, and passing.
    throw new Error("PQP_SHARE_SMOKE_REQUIRE_PACKAGED is set and PQP_SHARE_SMOKE_APP is not");
  }
  if (!target) {
    // `electron`'s package main is the path to its binary.
    const require = createRequire(import.meta.url);
    return {
      kind: "unpackaged",
      command: require("electron"),
      args: [ELECTRON_DIR],
    };
  }
  let command = path.resolve(target);
  if (command.endsWith(".app") && existsSync(command) && statSync(command).isDirectory()) {
    const plist = readFileSync(path.join(command, "Contents", "Info.plist"), "utf8");
    const name = /<key>CFBundleExecutable<\/key>\s*<string>([^<]+)<\/string>/.exec(plist)?.[1];
    if (!name) {
      throw new Error(`no CFBundleExecutable in ${command}`);
    }
    command = path.join(command, "Contents", "MacOS", name);
  }
  if (!existsSync(command)) {
    throw new Error(`PQP_SHARE_SMOKE_APP does not exist: ${command}`);
  }
  return { kind: "packaged", command, args: [] };
}

async function freePort() {
  const server = createNetServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
};

/** Serves the built page at `/app`, the path the shell always opens. */
export async function startPageServer(pageDir = PAGE_DIR) {
  const index = path.join(pageDir, "index.html");
  if (!existsSync(index)) {
    throw new Error(
      `the share smoke page is not built (${index}). Run: node client/e2e/desktop-share/build.mjs`,
    );
  }
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    let rel = url.pathname.replace(/^\/app(\/|$)/, "/");
    if (rel === "/" || rel === "") {
      rel = "/index.html";
    }
    const file = path.normalize(path.join(pageDir, rel));
    if (!file.startsWith(pageDir) || !existsSync(file) || statSync(file).isDirectory()) {
      res.writeHead(404, { "content-type": "text/plain" });
      res.end("not found");
      return;
    }
    res.writeHead(200, {
      "content-type": TYPES[path.extname(file)] ?? "application/octet-stream",
      "cache-control": "no-store",
    });
    res.end(readFileSync(file));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  return {
    url: `http://127.0.0.1:${port}/app`,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

/**
 * Starts the app pointed at `appUrl` and returns a CDP-connected browser.
 * The process's stdout and stderr go to `logFile`: the shell's own `[pqp]`
 * lines are the only window into the main process this test has.
 */
export async function launchApp({ app, appUrl, logFile, extraEnv = {} }) {
  const port = await freePort();
  const userDataDir = mkdtempSync(path.join(os.tmpdir(), "pqp-share-smoke-"));
  const log = createWriteStream(logFile, { flags: "a" });
  const env = {
    ...process.env,
    PQP_APP_URL: appUrl,
    PQP_ALLOW_APP_URL_OVERRIDE: "1",
    PQP_DISABLE_AUTO_UPDATE: "1",
    ...extraEnv,
  };
  // A developer's shell may export these for their own Electron work. The
  // shipped binary ignores them (fuses), the unpackaged one would not.
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.NODE_OPTIONS;
  const args = [
    ...app.args,
    `--remote-debugging-port=${port}`,
    "--remote-allow-origins=*",
    `--user-data-dir=${userDataDir}`,
  ];
  log.write(`$ ${app.command} ${args.join(" ")}\n`);
  const child = spawn(app.command, args, { env, stdio: ["ignore", "pipe", "pipe"] });
  const lines = [];
  const collect = (chunk) => {
    const text = chunk.toString();
    log.write(text);
    lines.push(...text.split(/\r?\n/).filter(Boolean));
  };
  child.stdout.on("data", collect);
  child.stderr.on("data", collect);
  let exited = null;
  child.on("exit", (code, signal) => {
    exited = { code, signal };
    log.write(`\n[share-smoke] app exited code=${code} signal=${signal}\n`);
  });

  const endpoint = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 60_000;
  let version = null;
  while (Date.now() < deadline) {
    if (exited) {
      throw new Error(
        `the app exited before DevTools answered (${JSON.stringify(exited)}). Last output:\n${lines.slice(-30).join("\n")}`,
      );
    }
    try {
      const res = await fetch(`${endpoint}/json/version`);
      if (res.ok) {
        version = await res.json();
        break;
      }
    } catch {
      // Not listening yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  if (!version) {
    child.kill();
    throw new Error(
      `no DevTools endpoint on ${endpoint} after 60 s. Last output:\n${lines.slice(-30).join("\n")}`,
    );
  }
  const browser = await chromium.connectOverCDP(endpoint);
  return {
    browser,
    version,
    lines,
    child,
    userDataDir,
    exited: () => exited,
    async close() {
      try {
        await browser.close();
      } catch {
        // Already gone with the process.
      }
      if (!exited) {
        child.kill();
        await new Promise((resolve) => {
          const timer = setTimeout(resolve, 5000);
          child.once("exit", () => {
            clearTimeout(timer);
            resolve();
          });
        });
      }
      log.end();
    },
  };
}

/** Every page target the app has open right now, the picker included. */
export function allPages(browser) {
  return browser.contexts().flatMap((context) => context.pages());
}

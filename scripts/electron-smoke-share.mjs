#!/usr/bin/env node
/**
 * Run the desktop share smoke test against the app you just built.
 *
 *   pnpm --filter @pqp/electron pack          # electron-builder --dir, a few minutes
 *   pnpm electron:smoke-share                 # finds what pack produced
 *   pnpm electron:smoke-share path/to/pqp.app # or any packaged app / pqp.exe / pqp
 *   pnpm electron:smoke-share --unpackaged    # the repo's own Electron (not the gate)
 *
 * Builds the test page from the client source first, so a change to the
 * share code is what gets tested. Results and the app's log land in
 * electron/test-results/share-smoke/. Same test CI and the release gate run
 * (electron/test/share-smoke/share.smoke.mjs); `PQP_SHARE_SMOKE_BREAK=width-zero`
 * makes it fail on purpose.
 *
 * macOS: a capture needs Screen Recording for whatever started the process
 * (your terminal, usually), not only for pqp. Without it the shell lists only
 * windows with no previews and the capture delivers no frames; this script
 * then checks everything short of frames and says so.
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const release = path.join(root, "electron", "release");
const arg = process.argv[2];

function built() {
  const candidates = {
    darwin: [
      path.join(release, `mac-${process.arch}`, "pqp.app"),
      path.join(release, "mac", "pqp.app"),
      path.join(release, "mac-universal", "pqp.app"),
    ],
    win32: [path.join(release, "win-unpacked", "pqp.exe")],
    linux: [path.join(release, "linux-unpacked", "pqp")],
  }[process.platform] ?? [];
  return candidates.find((c) => existsSync(c)) ?? null;
}

let app = null;
if (arg === "--unpackaged") {
  app = null;
} else if (arg) {
  app = path.resolve(arg);
} else {
  app = built();
  if (!app) {
    console.error(
      `No packaged app in ${release}. Build one with \`pnpm --filter @pqp/client build && pnpm --filter @pqp/electron pack\`, ` +
        "pass a path, or use --unpackaged for the repo's own Electron.",
    );
    process.exit(2);
  }
}

const run = (command, args, env = process.env) => {
  const result = spawnSync(command, args, { cwd: root, stdio: "inherit", env, shell: process.platform === "win32" });
  return result.status ?? 1;
};

if (run("pnpm", ["--filter", "@pqp/shared", "build"]) !== 0) process.exit(1);
if (run("node", ["client/e2e/desktop-share/build.mjs"]) !== 0) process.exit(1);

const env = { ...process.env };
if (app) env.PQP_SHARE_SMOKE_APP = app;
else delete env.PQP_SHARE_SMOKE_APP;
if (process.platform === "darwin") env.PQP_SHARE_SMOKE_MAC_WITHOUT_GRANT ??= "accept";
console.log(`share smoke against ${app ?? "the unpackaged shell (repo Electron)"}`);
const status = run("pnpm", ["--filter", "@pqp/electron", "smoke:share"], env);
run("node", ["electron/test/share-smoke/summary.mjs", "electron/test-results/share-smoke"]);
process.exit(status);

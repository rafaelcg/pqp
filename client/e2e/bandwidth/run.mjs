#!/usr/bin/env node
// Real accounts, a real 3-person mesh call, and one real Chromium process
// whose actual upload is capped by the Linux kernel — not a fake stats
// object. See README.md for the setup and how to read the output.
//
// This file runs in two modes, chosen by whether PQP_HARNESS_ROLE is set:
//
//  - Unset (`node run.mjs` on the host): the ORCHESTRATOR. Seeds the API
//    over the app's published port, waits for the three agent containers to
//    reach their milestones, shapes the sharer's egress with `tc`, and
//    prints/verifies the result.
//  - Set to "sharer" / "viewer1" / "viewer2" (how docker-compose.yml starts
//    the browser containers): the AGENT. Launches its own local Chromium —
//    there is no cross-container CDP here; an earlier version tried that and
//    Chrome's remote-debugging socket only ever accepts connections on its
//    own loopback, unreachable from another container or a published port —
//    and drives it through the join/share/sample flow, coordinating with the
//    other two agents purely through files in the bind-mounted /run/coord.
//
// Requires `docker compose -f docker-compose.yml up -d --build` already
// running the app and postgres (the orchestrator does not manage the compose
// lifecycle).

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFileSync, writeFileSync, appendFileSync, existsSync, mkdirSync } from "node:fs";

const run = promisify(execFile);
const SHARE_RATE = process.env.SHARE_RATE ?? "3mbit";

const ROLE = process.env.PQP_HARNESS_ROLE ?? null;
// Long enough to show an unshaped baseline, then the controller's reaction
// once the link is shaped mid-share — the scenario the PR actually describes,
// not a link that was already constrained before the share began.
const BASELINE_MS = 9_000;
const TOTAL_SAMPLE_MS = 45_000;

// ---------------------------------------------------------------------------
// Orchestrator (runs on the host)
// ---------------------------------------------------------------------------

const APP_URL = "http://localhost:13001";
const DEV_TOKEN = "dev-local-token";
const COORD_DIR = new URL("run/", import.meta.url).pathname;
const COMPOSE = [
  "compose",
  "-f",
  new URL("docker-compose.yml", import.meta.url).pathname,
];

function headersFor(suffix) {
  return {
    "Content-Type": "application/json",
    Authorization: `Bearer ${DEV_TOKEN}:${suffix}`,
  };
}

async function waitForHealth(timeoutMs = 60_000) {
  const started = Date.now();
  for (;;) {
    try {
      const res = await fetch(`${APP_URL}/health`);
      if (res.ok) return;
    } catch {
      // Not up yet.
    }
    if (Date.now() - started > timeoutMs) {
      throw new Error(`${APP_URL}/health never came up`);
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
}

async function materialiseAccount(suffix) {
  const headers = headersFor(suffix);
  const me = await fetch(`${APP_URL}/api/me`, { headers });
  if (!me.ok) throw new Error(`GET /api/me (${suffix}) -> ${me.status}`);
  const body = await me.json();
  if (body.ageGate && body.ageGate !== "passed") {
    await fetch(`${APP_URL}/api/me/age-check`, {
      method: "POST",
      headers,
      body: JSON.stringify({ dateOfBirth: "1990-01-01" }),
    });
  }
  await fetch(`${APP_URL}/api/me/preferences`, {
    method: "PATCH",
    headers,
    body: JSON.stringify({
      onboardedAt: new Date().toISOString(),
      firstRunDismissedAt: new Date().toISOString(),
    }),
  });
  return body;
}

async function seedRoom() {
  const sharer = await materialiseAccount("sharer");
  await materialiseAccount("viewer1");
  await materialiseAccount("viewer2");

  const created = await fetch(`${APP_URL}/api/servers`, {
    method: "POST",
    headers: headersFor("sharer"),
    body: JSON.stringify({ name: "Bandwidth" }),
  });
  const { server } = await created.json();

  await fetch(`${APP_URL}/api/servers/${server.id}/channels`, {
    method: "POST",
    headers: headersFor("sharer"),
    body: JSON.stringify({ name: "stage", type: "voice" }),
  });

  for (const guest of ["viewer1", "viewer2"]) {
    const invited = await fetch(`${APP_URL}/api/servers/${server.id}/invites`, {
      method: "POST",
      headers: headersFor("sharer"),
      body: JSON.stringify({}),
    });
    const { invite } = await invited.json();
    const joined = await fetch(`${APP_URL}/api/invites/${invite.code}/join`, {
      method: "POST",
      headers: headersFor(guest),
      body: "{}",
    });
    if (!joined.ok) {
      throw new Error(`${guest} failed to join invite -> ${joined.status}`);
    }
  }

  return { serverId: server.id, sharerName: sharer.displayName };
}

async function shapeSharerEgress() {
  // `eth0` inside a compose-network container is the only interface it has,
  // so this caps everything the container sends, which is exactly the
  // sharer's whole upload. NET_ADMIN on this one service in docker-compose.yml
  // is what makes `tc` permitted at all.
  await run("docker", [
    ...COMPOSE,
    "exec",
    "-T",
    "sharer",
    "tc",
    "qdisc",
    "add",
    "dev",
    "eth0",
    "root",
    "netem",
    "rate",
    SHARE_RATE,
  ]);
  const { stdout } = await run("docker", [
    ...COMPOSE,
    "exec",
    "-T",
    "sharer",
    "tc",
    "-s",
    "qdisc",
    "show",
    "dev",
    "eth0",
  ]);
  return stdout;
}

function waitForFile(path, timeoutMs) {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const tick = () => {
      if (existsSync(path)) return resolve();
      if (Date.now() - started > timeoutMs) {
        return reject(new Error(`Timed out waiting for ${path}`));
      }
      setTimeout(tick, 500);
    };
    tick();
  });
}

function readLines(path) {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function fmtSender(s) {
  if (!s) return "no sender";
  return `${s.kbps ?? "?"} kbps actual, ${s.targetKbps ?? "?"} target, ceiling ${s.ceilingKbps ?? "?"}, limited by ${s.limitedBy ?? "?"}`;
}

function fmtReceiver(r) {
  if (!r) return "no receiver";
  return `${r.width}x${r.height} @ ${Math.round(r.fps ?? 0)}fps, ${r.kbps ?? "?"} kbps`;
}

async function orchestratorMain() {
  mkdirSync(COORD_DIR, { recursive: true });
  // Clean slate: a marker left over from a previous run would let every wait
  // below return instantly on stale state instead of real progress.
  const { rmSync } = await import("node:fs");
  for (const f of [
    "room.json",
    "shaped",
    "sharing",
    "sharer-joined",
    "viewer1-joined",
    "viewer2-joined",
    "sharer-stats.jsonl",
    "viewer1-stats.jsonl",
    "viewer2-stats.jsonl",
  ]) {
    rmSync(`${COORD_DIR}${f}`, { force: true });
  }

  console.log("Waiting for the app...");
  await waitForHealth();

  console.log("Seeding three accounts and a voice channel...");
  const { serverId, sharerName } = await seedRoom();
  writeFileSync(`${COORD_DIR}room.json`, JSON.stringify({ serverId, sharerName }));

  console.log("Waiting for all three agents to join voice...");
  await Promise.all(
    ["sharer", "viewer1", "viewer2"].map((r) =>
      waitForFile(`${COORD_DIR}${r}-joined`, 120_000),
    ),
  );

  console.log("Waiting for the share to start (unshaped, on the full link)...");
  await waitForFile(`${COORD_DIR}sharing`, 60_000);

  console.log(
    "\nSampling ~9s of baseline before touching the link. Starting ceiling " +
      "should be ~2500 kbps (5000/2 viewers) once the encoder ramps up.\n",
  );
  await new Promise((r) => setTimeout(r, BASELINE_MS));

  console.log(`\nShaping the sharer's container egress to ${SHARE_RATE}...`);
  const tcOutput = await shapeSharerEgress();
  console.log(tcOutput.trim());
  if (!tcOutput.includes("netem")) {
    throw new Error("tc did not report a netem qdisc — shaping did not apply");
  }
  writeFileSync(`${COORD_DIR}shaped`, "");
  const shapedAtSample = Math.round(BASELINE_MS / 3000);

  console.log(
    `\nShaped at sample #${shapedAtSample}. Waiting for the rest of the ` +
      `agents' run so the reaction shows up.\n`,
  );
  await new Promise((r) => setTimeout(r, TOTAL_SAMPLE_MS - BASELINE_MS + 3000));

  const senderRows = readLines(`${COORD_DIR}sharer-stats.jsonl`);
  const v1Rows = readLines(`${COORD_DIR}viewer1-stats.jsonl`);
  const v2Rows = readLines(`${COORD_DIR}viewer2-stats.jsonl`);

  const n = Math.max(senderRows.length, v1Rows.length, v2Rows.length);
  for (let i = 0; i < n; i += 1) {
    const s = senderRows[i]?.sample;
    const r1 = v1Rows[i]?.sample;
    const r2 = v2Rows[i]?.sample;
    const mark = i + 1 === shapedAtSample ? "  <-- shaped here" : "";
    console.log(
      `t=${String((i + 1) * 3).padStart(2)}s  sender: ${fmtSender(s)}` +
        `  |  viewer1: ${fmtReceiver(r1)}  |  viewer2: ${fmtReceiver(r2)}${mark}`,
    );
  }

  const startCeiling = senderRows[0]?.sample?.ceilingKbps ?? null;
  const endCeiling = senderRows.at(-1)?.sample?.ceilingKbps ?? null;

  console.log("\n--- Verdict ---");
  console.log(`Ceiling started at ${startCeiling} kbps, ended at ${endCeiling} kbps.`);

  let ok = true;
  if (startCeiling === null || endCeiling === null) {
    console.log("FAIL: could not read the sender's ceiling at all.");
    ok = false;
  } else if (endCeiling >= 2250) {
    // 2250 = CUT_BELOW (0.9) * the un-shaped 2500 kbps default. A real
    // 3 Mbps link split two ways cannot sustain 2500 kbps a copy, so the
    // controller should have cut well below its own no-op threshold.
    console.log(
      "FAIL: ceiling never dropped below the un-shaped default's wobble " +
        "line (2250 kbps). The budget controller did not react to the shape.",
    );
    ok = false;
  } else {
    console.log("PASS: the ceiling measurably dropped under a shaped link.");
  }

  process.exitCode = ok ? 0 : 1;
}

// ---------------------------------------------------------------------------
// Agent (runs inside a browser container)
// ---------------------------------------------------------------------------

async function agentMain(role) {
  const { chromium } = await import("playwright-core");
  const dns = await import("node:dns/promises");
  // Chromium applies some hostname heuristic (HTTPS-First Mode and its kin)
  // to a bare Docker DNS name like "app" that it does not apply to an IP
  // literal: every http:// navigation to "app" came back
  // net::ERR_SSL_PROTOCOL_ERROR, and the identical request to the same
  // container's own IP loaded normally. `--disable-features=HttpsUpgrades`
  // did not change this, so rather than keep guessing at Chromium's internal
  // feature names, resolve the one hostname this harness ever navigates to
  // and use the address instead.
  const { address: appIp } = await dns.lookup("app");
  const appOrigin = `http://${appIp}:3001`;
  const coord = "/run/coord/";
  const waitFile = (name, timeoutMs = 120_000) => {
    const started = Date.now();
    return new Promise((resolve, reject) => {
      const tick = () => {
        if (existsSync(`${coord}${name}`)) return resolve();
        if (Date.now() - started > timeoutMs) {
          return reject(new Error(`agent ${role}: timed out waiting for ${name}`));
        }
        setTimeout(tick, 500);
      };
      tick();
    });
  };

  console.log(`[${role}] waiting for the room...`);
  await waitFile("room.json");
  const { serverId, sharerName } = JSON.parse(
    readFileSync(`${coord}room.json`, "utf8"),
  );

  console.log(`[${role}] launching chromium...`);
  const browser = await chromium.launch({
    headless: true,
    executablePath: "/ms-playwright/chromium-1234/chrome-linux/chrome",
    args: [
      "--no-sandbox",
      "--disable-dev-shm-usage",
      // `getDisplayMedia` requires a secure context, and Chromium only ever
      // treats "localhost"/127.0.0.1 as secure by default — a container's
      // own IP is not on that list, so without this flag the share button
      // renders as "Share your screen (unavailable on this device)".
      `--unsafely-treat-insecure-origin-as-secure=${appOrigin}`,
      "--use-fake-device-for-media-stream",
      "--use-fake-ui-for-media-stream",
      "--auto-select-desktop-capture-source=Entire screen",
      "--auto-accept-this-tab-capture",
      "--use-fake-ui-for-screen-capture",
    ],
  });
  const context = await browser.newContext({
    viewport: { width: 1280, height: 800 },
    colorScheme: "dark",
  });
  await context.addInitScript((suffix) => {
    localStorage.setItem("pqp:dev-user-suffix", suffix);
  }, role);
  const page = await context.newPage();

  try {
    console.log(`[${role}] booting the app...`);
    await page.goto(`${appOrigin}/app/servers/${serverId}?lang=en`);
    await page.getByText("Dev auth bypass").waitFor({ timeout: 20_000 });
    await page.getByRole("button", { name: "Send" }).waitFor({ timeout: 20_000 });

    console.log(`[${role}] joining voice...`);
    await page.getByRole("button", { name: /stage/ }).first().click();
    await page.getByTestId("call-stage-collapsed").waitFor({ timeout: 20_000 });
    await page.getByText("Voice connected").waitFor({ timeout: 20_000 });
    writeFileSync(`${coord}${role}-joined`, "");

    if (role === "sharer") {
      console.log(`[${role}] waiting for both viewers to join...`);
      await Promise.all([waitFile("viewer1-joined"), waitFile("viewer2-joined")]);
      // Shared unshaped, on purpose: the orchestrator shapes the link a few
      // seconds into the share, not before it, so the run shows an actual
      // baseline and then the controller's reaction to it changing — the
      // scenario the PR describes — rather than a link already constrained
      // before the first frame went out.
      console.log(`[${role}] starting the screen share...`);
      await page
        .getByRole("button", { name: "Share your screen", exact: true })
        .click({ timeout: 10_000 });
      // Incompressible motion, so the encoder is actually under pressure —
      // same reasoning as `paintNoise` in screen-quality-received.spec.ts.
      await page.evaluate(() => {
        const canvas = document.createElement("canvas");
        canvas.width = 320;
        canvas.height = 180;
        Object.assign(canvas.style, {
          position: "fixed",
          inset: "0",
          width: "100vw",
          height: "100vh",
          zIndex: "2147483647",
          pointerEvents: "none",
        });
        document.body.appendChild(canvas);
        const ctx = canvas.getContext("2d");
        const image = ctx.createImageData(canvas.width, canvas.height);
        setInterval(() => {
          const { data } = image;
          for (let i = 0; i < data.length; i += 4) {
            data[i] = Math.random() * 255;
            data[i + 1] = Math.random() * 255;
            data[i + 2] = Math.random() * 255;
            data[i + 3] = 255;
          }
          ctx.putImageData(image, 0, 0);
        }, 66);
      });
      writeFileSync(`${coord}sharing`, "");
    } else {
      console.log(`[${role}] waiting for the share to start...`);
      await waitFile("sharing");
      await page.getByText(`${sharerName} is presenting`).waitFor({ timeout: 30_000 });
    }

    console.log(`[${role}] sampling for ~45s...`);
    for (let i = 0; i < 15; i += 1) {
      await new Promise((r) => setTimeout(r, 3000));
      const snap = await page.evaluate(() => window.pqpVoiceStats.report());
      const sample =
        role === "sharer"
          ? snap.senders.find((s) => s.role === "screen") ?? null
          : snap.receivers.find((r) => r.role === "screen") ?? null;
      appendFileSync(`${coord}${role}-stats.jsonl`, `${JSON.stringify({ sample })}\n`);
    }
    console.log(`[${role}] done.`);
  } finally {
    await browser.close().catch(() => {});
  }
}

// ---------------------------------------------------------------------------

if (ROLE) {
  await agentMain(ROLE);
} else {
  await orchestratorMain();
}

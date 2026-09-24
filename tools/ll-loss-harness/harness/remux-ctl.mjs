#!/usr/bin/env node
// Signed control-API client for the harness's own pqp-remuxd container.
// Same HMAC scheme as packages/shared/src/hls-remux-control.ts, adapted
// from the production `remux-ctl.mjs` (which reads /etc/pqp-remux.env on
// the real egress box) to read .data/harness.env instead and to talk to
// the loopback-published control port docker-compose.yaml exposes.
//
// Usage:
//   node remux-ctl.mjs start [sessionId]   POST /sessions, prints SESSION <id>
//   node remux-ctl.mjs stop <sessionId>    DELETE /sessions/:id
//   node remux-ctl.mjs list                GET /sessions
//   node remux-ctl.mjs rebind <sessionId> <identity>
//                                           POST /sessions/:id/rebind
import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { loadHarnessEnv, assertLocalUrl } from "./env.mjs";

const CONTROL_URL = process.env.LL_HARNESS_CONTROL_URL || "http://127.0.0.1:8090";
assertLocalUrl(CONTROL_URL, "LL_HARNESS_CONTROL_URL");

const env = loadHarnessEnv();
const secret = env.REMUX_CONTROL_SECRET;

async function call(method, path, body) {
  const raw = body === undefined ? "" : JSON.stringify(body);
  const ts = String(Date.now());
  const nonce = randomBytes(16).toString("hex");
  const sig = createHmac("sha256", secret)
    .update(`${method}\n${path}\n${ts}\n${nonce}\n${raw}`, "utf8")
    .digest("hex");
  const r = await fetch(`${CONTROL_URL}${path}`, {
    method,
    headers: {
      "content-type": "application/json",
      "x-pqp-remux-timestamp": ts,
      "x-pqp-remux-nonce": nonce,
      "x-pqp-remux-signature": sig,
    },
    body: body === undefined ? undefined : raw,
  });
  const text = await r.text();
  return { status: r.status, text };
}

export async function startSession({
  sessionId = randomUUID(),
  room,
  channelId = randomUUID(),
  keyframePolicy = "natural",
  presenterIdentity = process.env.PRESENTER || "ramp-presenter",
} = {}) {
  const { status, text } = await call("POST", "/sessions", {
    // The publisher's identity, as pqp-api names the presenter's peer id.
    presenterIdentity,
    sessionId,
    room,
    channelId,
    partMs: 500,
    segmentMs: 4000,
    ringSegments: 6,
    keyframePolicy,
    pliPaceMs: 500,
    pliGateFactor: 1,
  });
  if (status !== 201 && status !== 409) throw new Error(`start session: ${status} ${text}`);
  return { sessionId, status, body: JSON.parse(text) };
}

export async function stopSession(sessionId) {
  const { status, text } = await call("DELETE", `/sessions/${sessionId}`);
  if (status !== 204 && status !== 404) throw new Error(`stop session: ${status} ${text}`);
  return { status };
}

export async function rebindSession(sessionId, presenterIdentity) {
  const { status, text } = await call("POST", `/sessions/${sessionId}/rebind`, { presenterIdentity });
  if (status !== 200) throw new Error(`rebind session: ${status} ${text}`);
  return JSON.parse(text);
}

export async function listSessions() {
  const { status, text } = await call("GET", "/sessions");
  if (status !== 200) throw new Error(`list sessions: ${status} ${text}`);
  return JSON.parse(text).sessions;
}

async function main() {
  const [cmd, arg] = process.argv.slice(2);
  if (cmd === "start") {
    const room = process.env.ROOM || "ll-loss-harness";
    const out = await startSession({ sessionId: arg, room });
    console.log("SESSION", out.sessionId, JSON.stringify(out.body));
  } else if (cmd === "stop") {
    if (!arg) throw new Error("usage: remux-ctl.mjs stop <sessionId>");
    const out = await stopSession(arg);
    console.log("STOPPED", out.status);
  } else if (cmd === "rebind") {
    const identity = process.argv[4];
    if (!arg || !identity) throw new Error("usage: remux-ctl.mjs rebind <sessionId> <identity>");
    console.log("REBOUND", JSON.stringify(await rebindSession(arg, identity)));
  } else if (cmd === "list") {
    console.log(JSON.stringify(await listSessions(), null, 2));
  } else {
    console.error("usage: remux-ctl.mjs start|stop|list|rebind [arg]");
    process.exit(2);
  }
}

// Only run as a CLI when invoked directly (`node remux-ctl.mjs ...`), not
// when imported by run.sh's orchestration or by tests.
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => {
    console.error("remux-ctl:", e.message || e);
    process.exit(1);
  });
}

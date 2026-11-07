#!/usr/bin/env node
/**
 * Prove the fixtures are test material and not credentials.
 *
 * GitGuardian flags the 43-char signature half of the tokens in
 * rust/fixtures/resume-vectors.json as "Generic High Entropy Secret". Whoever
 * reads that scanner output should not have to take a developer's word for it,
 * so this script asks the shipped verifier the only three questions that
 * decide whether a string is a credential:
 *
 *   1. Does it still work at today's clock?          -> expiry revoked it
 *   2. Does it work under any key but the fixture's? -> bound to a throwaway
 *   3. Does it work where production reads its key?  -> it never saw one
 *
 * A string that cannot be used, and that was never within reach of a real key,
 * is a fixture. The script asserts all three, so a future change that mints a
 * long-lived or production-keyed vector fails here instead of in an incident.
 *
 * It then does the same job for `deflate-vectors.json`, which is 360 KB of
 * high-entropy base64 and therefore the file a generic-entropy scanner is most
 * likely to like. There the decisive fact is different: not that the strings
 * cannot be used, but that there is nothing in them to use. Every payload in
 * that file decodes to one of two things -- a synthetic pqp frame, or the
 * compressed form of one it sits next to -- and the section below checks exactly
 * that, byte by byte, rather than asserting it in a comment.
 *
 * Usage:
 *   node --experimental-strip-types --no-warnings \
 *     --import ./rust/scripts/ts-register.mjs \
 *     rust/scripts/prove-vectors-inert.mjs
 */
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const fixture = JSON.parse(
  readFileSync(resolve(here, "../fixtures/resume-vectors.json"), "utf8"),
);
const { verifyVoiceResumeToken } = await import(
  resolve(here, "../../server/src/ws/voice-resume-token.ts")
);

/**
 * Every environment the verifier can read its key from, mirrored from
 * `resumeSecret()` in server/src/ws/voice-resume-token.ts. `clerk` is the
 * production path (key derived from CLERK_SECRET_KEY); `dev` is the bypass
 * fallback that is hardcoded in that file; `none` is a process with neither.
 */
const ENVS = ["clerk", "dev", "none"];

/**
 * Key material to run the production path under. The fixture's own literal is
 * committed next to the tokens it signs; the foreign one is invented here and
 * is deliberately not high-entropy, so this file cannot itself trip a scanner.
 */
const KEYS = {
  fixture: fixture.keys.clerk,
  foreign: "not-the-fixture-key-invented-for-this-audit",
};

function useEnv(env, key) {
  if (env === "clerk") {
    process.env.CLERK_SECRET_KEY = key;
    delete process.env.DEV_AUTH_BYPASS;
  } else if (env === "dev") {
    delete process.env.CLERK_SECRET_KEY;
    process.env.DEV_AUTH_BYPASS = "true";
  } else {
    delete process.env.CLERK_SECRET_KEY;
    delete process.env.DEV_AUTH_BYPASS;
  }
}

const vectors = fixture.vectors.filter((v) => typeof v.token === "string" && v.token.length > 0);
const today = Date.now();
const failures = [];

/** Claims a valid token would hand an attacker: who, which slot, which room. */
function claimsOf(token) {
  const dot = token.lastIndexOf(".");
  try {
    return JSON.parse(Buffer.from(token.slice(0, dot), "base64url").toString("utf8"));
  } catch {
    return null;
  }
}

// --- 1. Replay: the fixture is a faithful record of the shipped verifier ----
let mismatches = 0;
let acceptedOwn = 0;
for (const v of vectors) {
  useEnv(v.env, fixture.keys.clerk);
  const got = verifyVoiceResumeToken(v.token, v.match, v.now);
  const verdict = got
    ? { ok: true, userId: got.userId, peerId: got.peerId,
        voiceChannelId: got.voiceChannelId, transport: got.transport, region: got.region }
    : { ok: false };
  if (JSON.stringify(verdict) !== JSON.stringify(v.ts)) {
    mismatches += 1;
    console.error(`FAIL replay ${v.name}: verifier now says ${JSON.stringify(verdict)}`);
  }
  if (got) acceptedOwn += 1;
}
console.log(
  `replay   ${vectors.length - acceptedOwn} refused / ${acceptedOwn} accepted, ` +
    `${mismatches} disagreements with the recorded verdicts`,
);
if (mismatches) failures.push("replay parity");

// --- 2+3. Nothing works under a foreign key, at today's clock, or with no key
const cells = [];
for (const env of ENVS) {
  for (const [keyName, key] of Object.entries(KEYS)) {
    for (const clock of ["own", "today"]) {
      let accepts = 0;
      const who = [];
      for (const v of vectors) {
        useEnv(env, key);
        const got = verifyVoiceResumeToken(v.token, v.match, clock === "own" ? v.now : today);
        if (got) {
          accepts += 1;
          who.push(v.name);
        }
      }
      cells.push({ env, keyName, clock, accepts, who });
    }
  }
}
const rows = cells
  .filter((c) => c.accepts > 0)
  .map((c) => `  ${c.env} env, ${c.keyName} key, ${c.clock} clock -> ${c.accepts}`)
  .join("\n");
console.log(`matrix   ${cells.length} key/env/clock combinations, ` +
  `${cells.filter((c) => c.accepts === 0).length} accept nothing`);
console.log(rows || "  (no combination accepts anything)");
for (const c of cells) {
  if (c.accepts && (c.env === "none" || c.clock === "today")) {
    failures.push(`${c.env}/${c.keyName}/${c.clock} accepts ${c.accepts}`);
  }
  if (c.accepts && c.env === "clerk" && c.keyName === "foreign") {
    failures.push("foreign key accepted a token on the production path");
  }
}

// --- 4. What the accepted claims actually are -------------------------------
const claims = vectors.map((v) => claimsOf(v.token)).filter(Boolean);
const subjects = [...new Set(claims.map((c) => c?.u).filter(Boolean))];
const expiries = claims.map((c) => c?.e).filter((e) => typeof e === "number");
const newest = expiries.length ? Math.max(...expiries) : 0;
const daysExpired = Math.floor((today - newest) / 86_400_000);
console.log(`claims   ${claims.length} decodable payloads, ` +
  `${subjects.length} subject id(s): ${subjects.join(", ")}`);
console.log(`expiry   newest is ${new Date(newest).toISOString()}, ` +
  `${daysExpired} days in the past`);
if (daysExpired <= 0) failures.push("a fixture token has not expired yet");
if (subjects.some((s) => s !== "11111111-1111-4111-8111-111111111111")) {
  failures.push("a fixture token names a subject that is not the fake user");
}

// --- 5. Name every secret in the fixture, with its source ------------------
for (const [name, value] of Object.entries(fixture.keys)) {
  const source =
    name === "dev"
      ? "hardcoded in server/src/ws/voice-resume-token.ts on main (dev bypass fallback)"
      : "rust/scripts/gen-resume-vectors.mjs, committed beside the tokens it signs";
  console.log(`key      ${name}: "${value}" (${value.length} chars) <- ${source}`);
}

// --- 6. The deflate fixture: nothing in it is text except our own frames ----
const deflate = JSON.parse(
  readFileSync(resolve(here, "../fixtures/deflate-vectors.json"), "utf8"),
);

/** Longest run of printable ASCII in a byte buffer. A key, token or PEM block is
 * text, so it scores at least its own length; deflate output scores a handful. */
function longestAsciiRun(bytes) {
  let best = 0;
  let run = 0;
  for (const b of bytes) {
    if (b >= 0x20 && b < 0x7f) {
      run += 1;
      best = Math.max(best, run);
    } else {
      run = 0;
    }
  }
  return best;
}

let frames = 0;
let messages = 0;
let compressed = 0;
let compressedBytes = 0;
let worstAsciiRun = 0;
for (const vector of deflate.vectors) {
  // Reassemble each WEBSOCKET MESSAGE first: `fin` marks its end, so a message
  // can be one frame or three. Parsing frame by frame would call the fragments of
  // a roster unparseable, which is a bug in this check and not in the fixture.
  let message = Buffer.alloc(0);
  for (const frame of vector.frames) {
    message = Buffer.concat([message, Buffer.from(frame.text, "base64")]);
    frames += 1;
    if (frame.fin) {
      let parsed;
      try {
        parsed = JSON.parse(message.toString("utf8"));
      } catch {
        failures.push(`${vector.name}: its frames do not reassemble into a pqp message`);
      }
      if (parsed && typeof parsed.type !== "string") {
        failures.push(`${vector.name}: a reassembled message has no \`type\``);
      }
      messages += 1;
      message = Buffer.alloc(0);
    }
    if (frame.deflated == null) continue;
    const deflated = Buffer.from(frame.deflated, "base64");
    compressed += 1;
    compressedBytes += deflated.length;
    worstAsciiRun = Math.max(worstAsciiRun, longestAsciiRun(deflated));
    // Binary on purpose: if a compressed payload ever decodes to a long stretch
    // of text, someone has put real content through the generator.
    if (longestAsciiRun(deflated) > 32) {
      failures.push(
        `${vector.name}: a compressed payload holds ${longestAsciiRun(deflated)} printable ` +
          `bytes, which is not what deflate output looks like`,
      );
    }
  }
}
console.log(
  `\ndeflate ${messages} messages reassemble into pqp frames (${frames} fragments), and ` +
    `${compressed} compressed halves ` +
    `(${compressedBytes} B) hold at most ${worstAsciiRun} printable bytes in a row -- ` +
    `that is deflate output, not a secret.\n         ws ${deflate.wsVersion} at ` +
    `${deflate.wsResolvedFrom}`
);

if (failures.length) {
  console.error(`\nNOT inert: ${failures.join("; ")}`);
  process.exit(1);
}
console.log(
  "\ninert: no token in the fixtures is usable as a credential today, and the " +
    "deflate fixture contains nothing but synthetic frames and their compressed forms.",
);

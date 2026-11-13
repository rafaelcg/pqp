#!/usr/bin/env node
/**
 * Generate the cross-language regression vectors for voice resume tokens.
 *
 * The oracle is the shipped TypeScript (`server/src/ws/voice-resume-token.ts`),
 * run directly: Node strips its types and its only `@pqp/shared` import is a
 * type. Nothing here decides what a valid token is — every vector is run
 * through the real `verifyVoiceResumeToken` and that verdict is recorded. The
 * Rust test must reproduce the verdict and the claims exactly, so Rust that
 * agrees with this file agrees with the server.
 *
 * Run: node rust/scripts/gen-resume-vectors.mjs
 */
import { createHmac } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const out = resolve(here, "../crates/pqp-core/fixtures/resume-vectors.json");
const mod = await import(resolve(here, "../../server/src/ws/voice-resume-token.ts"));
const { mintVoiceResumeToken, verifyVoiceResumeToken } = mod;

const CLERK_KEY = "ci-secret-key-for-vectors";
const DEV_BYPASS_KEY = "pqp-dev-voice-resume";
const NOW = 1_700_000_000_000;
const TTL = 8 * 60 * 60 * 1000;

/** Mirror of `resumeSecret()`, used only to forge payloads the module would
 *  never mint. Every forgery is then handed to the real verifier, and the
 *  `selfCheck` assertion below proves the mirror signs exactly like the module. */
function derive(raw) {
  if (!raw) return null;
  return createHmac("sha256", raw).update("pqp-voice-resume").digest("base64url");
}
function forge(claims, raw) {
  const key = derive(raw);
  if (!key) return null;
  const payload = Buffer.from(JSON.stringify(claims), "utf8").toString("base64url");
  return `${payload}.${createHmac("sha256", key).update(payload).digest("base64url")}`;
}
function signedPayload(claims) {
  return forge(claims, CLERK_KEY);
}
function envFor(kind) {
  if (kind === "clerk") {
    process.env.CLERK_SECRET_KEY = CLERK_KEY;
    delete process.env.DEV_AUTH_BYPASS;
  } else if (kind === "dev") {
    delete process.env.CLERK_SECRET_KEY;
    process.env.DEV_AUTH_BYPASS = "true";
  } else {
    delete process.env.CLERK_SECRET_KEY;
    delete process.env.DEV_AUTH_BYPASS;
  }
}

const A = {
  userId: "11111111-1111-4111-8111-111111111111",
  peerId: "peer-a",
  voiceChannelId: "chan-a",
};
const MINT = { ...A, transport: "mesh" };
const vectors = [];

/** `match`/`at` are the verifier's inputs; the recorded `ts` verdict is what
 *  Rust has to reproduce. `selfCheck` forges a token whose honest twin would
 *  verify, and requires both paths to reach the same accept/reject. */
function push(name, env, build, match, at, selfCheck) {
  envFor(env);
  const token = build();
  const got = verifyVoiceResumeToken(token, match, at ?? NOW);
  const verdict = got
    ? { ok: true, userId: got.userId, peerId: got.peerId,
        voiceChannelId: got.voiceChannelId, transport: got.transport, region: got.region }
    : { ok: false };
  if (selfCheck) {
    const viaModule = verifyVoiceResumeToken(
      mintVoiceResumeToken({ ...selfCheck, now: NOW }), match, at ?? NOW,
    );
    if (!!viaModule !== !!got) {
      throw new Error(`${name}: forgery helper disagrees with the module verifier`);
    }
  }
  vectors.push({ name, env, token, now: at ?? NOW, match, ts: verdict });
}

push("mesh-no-region", "clerk", () => mintVoiceResumeToken({ ...MINT, now: NOW }), A, NOW);
push("livekit-with-region", "clerk",
  () => mintVoiceResumeToken({ ...MINT, transport: "livekit", region: "gru", now: NOW }), A, NOW);
push("empty-region-is-absent", "clerk",
  () => mintVoiceResumeToken({ ...MINT, region: "", now: NOW }), A, NOW);
push("dev-bypass-key", "dev", () => mintVoiceResumeToken({ ...MINT, now: NOW }), A, NOW);
push("no-signing-key", "none", () => mintVoiceResumeToken({ ...MINT, now: NOW }), A, NOW);

envFor("clerk");
const live = mintVoiceResumeToken({ ...MINT, now: NOW });
push("expired-by-one-ms", "clerk", () => live, A, NOW + TTL + 1);
push("valid-at-expiry-instant", "clerk", () => live, A, NOW + TTL);

const flipped = live.slice(0, -1) + (live.endsWith("A") ? "B" : "A");
push("tampered-mac", "clerk", () => flipped, A, NOW);
push("wrong-user", "clerk", () => live,
  { ...A, userId: "22222222-2222-4222-8222-222222222222" }, NOW);
push("wrong-peer", "clerk", () => live, { ...A, peerId: "peer-b" }, NOW);
push("wrong-channel", "clerk", () => live, { ...A, voiceChannelId: "chan-b" }, NOW);
push("empty-token", "clerk", () => "", A, NOW);
push("no-dot", "clerk", () => "abcdef", A, NOW);
push("leading-dot", "clerk", () => ".abcdef", A, NOW);
push("bad-base64-payload", "clerk", () => "!!!.abcdef", A, NOW);
push("empty-mac", "clerk", () => live.split(".")[0] + ".", A, NOW);

const honest = { v: 1, u: A.userId, p: A.peerId, c: A.voiceChannelId, t: "mesh", e: NOW + 1000 };
push("region-as-number-verifies", "clerk",
  () => signedPayload({ ...honest, r: 7 }), A, NOW, MINT);
push("region-empty-string-verifies", "clerk",
  () => signedPayload({ ...honest, r: "" }), A, NOW, MINT);
push("unknown-claim-verifies", "clerk",
  () => signedPayload({ ...honest, z: "future" }), A, NOW, MINT);
push("version-2-refused", "clerk",
  () => signedPayload({ ...honest, v: 2 }), A, NOW);
push("unknown-transport-refused", "clerk",
  () => signedPayload({ ...honest, t: "sfu" }), A, NOW);
push("livekit-transport-verifies", "clerk",
  () => signedPayload({ v: 1, u: A.userId, p: A.peerId, c: A.voiceChannelId, t: "livekit", e: NOW + 1000, r: "gru" }),
  A, NOW, MINT);
push("missing-peer-refused", "clerk",
  () => signedPayload({ v: 1, u: A.userId, c: A.voiceChannelId, t: "mesh", e: NOW + 1000 }), A, NOW);
push("peer-as-number-refused", "clerk",
  () => signedPayload({ ...honest, p: 42 }), A, NOW);
push("non-object-payload-refused", "clerk", () => {
  const payload = Buffer.from("[1,2,3]", "utf8").toString("base64url");
  return `${payload}.${createHmac("sha256", derive(CLERK_KEY)).update(payload).digest("base64url")}`;
}, A, NOW);

// Rust mints this one and feeds it back here for the TS side to verify.
envFor("clerk");
const rustRoundTrip = mintVoiceResumeToken({ ...MINT, transport: "livekit", region: "gru", now: NOW + 5 });

mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, JSON.stringify({
  _generatedBy: "rust/scripts/gen-resume-vectors.mjs",
  note: "Verdicts come from the shipped TypeScript verifier. Do not edit by hand. "
    + "The `token` values and `keys` here are test material, not credentials: they are "
    + "HMAC signatures over fixed fake claims, signed with the throwaway `keys.clerk` "
    + "string in this same file. A real CLERK_SECRET_KEY never reaches this generator "
    + "(envFor() sets or deletes it on every branch), and none of these tokens verify "
    + "against production, which derives its key from the real secret. Secret scanners "
    + "flag the 43-char signature half as a high-entropy credential; it is a false positive.",
  ttlMs: TTL,
  keys: { clerk: CLERK_KEY, dev: DEV_BYPASS_KEY },
  vectors,
  rustRoundTrip: { token: rustRoundTrip, now: NOW + 5, match: A },
}, null, 2) + "\n");
const ok = vectors.filter((v) => v.ts.ok).length;
console.log(`wrote ${vectors.length} vectors (${ok} verify) to ${out}`);

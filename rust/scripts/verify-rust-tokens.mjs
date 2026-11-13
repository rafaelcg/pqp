#!/usr/bin/env node
/**
 * Reverse leg of the resume-token parity gate: tokens minted by Rust are
 * checked by the shipped TypeScript verifier.
 *
 * The forward leg (gen-resume-vectors.mjs + cargo test) proves Rust accepts
 * what TypeScript accepts. This proves the other direction, which is the half
 * that matters during a rolling deploy: a Pod running Rust mints a token, the
 * Pod still running Node has to honor it, or a reconnect becomes a hangup.
 *
 * Usage: node rust/scripts/verify-rust-tokens.mjs <json produced by cargo test>
 */
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const mod = await import(resolve(here, "../../server/src/ws/voice-resume-token.ts"));
const fixture = JSON.parse(readFileSync(resolve(here, "../crates/pqp-core/fixtures/resume-vectors.json"), "utf8"));

const path = process.argv[2];
if (!path) {
  console.error("usage: verify-rust-tokens.mjs <minted.json>");
  process.exit(2);
}
process.env.CLERK_SECRET_KEY = fixture.keys.clerk;
delete process.env.DEV_AUTH_BYPASS;

const minted = JSON.parse(readFileSync(path, "utf8"));
let failed = 0;
for (const m of minted) {
  const got = mod.verifyVoiceResumeToken(m.token, m.expected.match ?? {
    userId: "11111111-1111-4111-8111-111111111111",
    peerId: "peer-a",
    voiceChannelId: "chan-a",
  }, m.now);
  const wantTransport = m.expected.transport;
  const ok =
    !!got &&
    got.transport === wantTransport &&
    (got.region ?? null) === (m.expected.region ?? null);
  if (!ok) {
    failed += 1;
    console.error(
      `FAIL ${m.name}: TypeScript ${got ? "accepted" : "refused"} a Rust-minted token` +
        (got ? ` (transport=${got.transport}, region=${got.region})` : ""),
    );
  } else {
    console.log(`ok   ${m.name}: TypeScript accepted the Rust-minted token`);
  }
}
// An expired Rust token must be refused, not honored.
const expired = minted.find((m) => m.name === "mesh");
if (expired) {
  const got = mod.verifyVoiceResumeToken(expired.token, {
    userId: "11111111-1111-4111-8111-111111111111", peerId: "peer-a", voiceChannelId: "chan-a",
  }, expired.now + fixture.ttlMs + 1);
  if (got) { failed += 1; console.error("FAIL expired: TypeScript honored an expired Rust token"); }
  else console.log("ok   expired: TypeScript refused the expired Rust token");
}
process.exit(failed ? 1 : 0);

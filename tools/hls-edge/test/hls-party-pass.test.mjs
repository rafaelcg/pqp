import { strict as assert } from "node:assert";
import { createHmac } from "node:crypto";
import test from "node:test";
import {
  HLS_PARTY_PASS_PARAM,
  describeHlsPartyPass,
  verifyHlsPartyPass,
} from "../src/hls-party-pass.js";

/**
 * Same fidelity-check reasoning as `hls-viewer-token.test.mjs`'s own
 * `mintToken`: sign with Node's `crypto`, verify with the module under
 * test's Web Crypto implementation, so a computation bug fails every "valid
 * pass" case here instead of hiding behind a self-consistent pair of bugs.
 */
function sign(payload, secret) {
  return createHmac("sha256", secret).update(payload).digest("base64url");
}

function mintPass(claims, secret) {
  const payload = Buffer.from(JSON.stringify(claims), "utf8").toString("base64url");
  return `${payload}.${sign(payload, secret)}`;
}

const SECRET = "test-derived-party-pass-secret";
const CHANNEL = "channel-1";
const STARTED_AT = 1_726_000_000_000;
const NOW = 1_726_000_100_000;
const SIX_HOURS_MS = 6 * 60 * 60 * 1000;

function baseClaims(overrides = {}) {
  return {
    v: 1,
    u: "user-1",
    c: CHANNEL,
    s: STARTED_AT,
    e: NOW + SIX_HOURS_MS,
    i: NOW - 1_000,
    ...overrides,
  };
}

const EXPECTED = { channelId: CHANNEL, startedAt: STARTED_AT };

test("HLS_PARTY_PASS_PARAM is the same query name the origin uses", () => {
  assert.equal(HLS_PARTY_PASS_PARAM, "pp");
});

test("verifies a pass minted with a different HMAC backend, and returns the right claims", async () => {
  const pass = mintPass(baseClaims(), SECRET);
  const result = await verifyHlsPartyPass(pass, EXPECTED, SECRET, NOW);
  assert.deepEqual(result, { userId: "user-1", issuedAt: NOW - 1_000 });
  assert.equal(await describeHlsPartyPass(pass, EXPECTED, SECRET, NOW), null);
});

test("verifies at a distance a viewer token's TTL could never reach", async () => {
  // The whole point of the party pass: still good most of a day after
  // issuance, unlike the hour-long viewer token.
  const pass = mintPass(baseClaims(), SECRET);
  const almostSixHoursLater = NOW + SIX_HOURS_MS - 1_000;
  assert.ok(await verifyHlsPartyPass(pass, EXPECTED, SECRET, almostSixHoursLater));
});

test("missing pass", async () => {
  assert.equal(await verifyHlsPartyPass(null, EXPECTED, SECRET, NOW), null);
  assert.equal(await describeHlsPartyPass(null, EXPECTED, SECRET, NOW), "missing");
  assert.equal(await describeHlsPartyPass(undefined, EXPECTED, SECRET, NOW), "missing");
  assert.equal(await describeHlsPartyPass("", EXPECTED, SECRET, NOW), "missing");
});

test("unconfigured secret fails closed", async () => {
  const pass = mintPass(baseClaims(), SECRET);
  assert.equal(await verifyHlsPartyPass(pass, EXPECTED, null, NOW), null);
  assert.equal(await describeHlsPartyPass(pass, EXPECTED, null, NOW), "unconfigured");
  assert.equal(await describeHlsPartyPass(pass, EXPECTED, undefined, NOW), "unconfigured");
});

test("malformed: no separator at all", async () => {
  assert.equal(await describeHlsPartyPass("not-a-pass", EXPECTED, SECRET, NOW), "malformed");
  assert.equal(await describeHlsPartyPass(".mac-only", EXPECTED, SECRET, NOW), "malformed");
  assert.equal(await verifyHlsPartyPass("not-a-pass", EXPECTED, SECRET, NOW), null);
});

test("a garbled, non-base64 mac reads as bad-signature, not malformed", async () => {
  assert.equal(
    await describeHlsPartyPass("not base64!!.not base64 either!!", EXPECTED, SECRET, NOW),
    "bad-signature",
  );
});

test("bad signature: tampered mac", async () => {
  const pass = mintPass(baseClaims(), SECRET);
  const [payload] = pass.split(".");
  const tampered = `${payload}.${"a".repeat(43)}`;
  assert.equal(await describeHlsPartyPass(tampered, EXPECTED, SECRET, NOW), "bad-signature");
  assert.equal(await verifyHlsPartyPass(tampered, EXPECTED, SECRET, NOW), null);
});

test("bad signature: a viewer-token secret does not verify a party pass, and vice versa", async () => {
  // THE PROPERTY THE WHOLE DESIGN RESTS ON: the two credentials use
  // DIFFERENT derived secrets (`viewerSecret()` vs `partySecret()` on the
  // origin), so a pass signed for one can never verify against the other's
  // key, regardless of any claim on the token. This is what makes "the API
  // keeps the short TTL for its own proxy" true by construction rather than
  // by a purpose check someone could forget to add.
  const pass = mintPass(baseClaims(), "a-viewer-token-secret-by-mistake");
  assert.equal(await describeHlsPartyPass(pass, EXPECTED, SECRET, NOW), "bad-signature");
  assert.equal(await verifyHlsPartyPass(pass, EXPECTED, SECRET, NOW), null);
});

test("wrong channel", async () => {
  const pass = mintPass(baseClaims({ c: "some-other-channel" }), SECRET);
  assert.equal(await describeHlsPartyPass(pass, EXPECTED, SECRET, NOW), "wrong-channel");
  assert.equal(await verifyHlsPartyPass(pass, EXPECTED, SECRET, NOW), null);
});

test("wrong session: same channel, different startedAt (an egress restart)", async () => {
  const pass = mintPass(baseClaims({ s: STARTED_AT + 1 }), SECRET);
  assert.equal(await describeHlsPartyPass(pass, EXPECTED, SECRET, NOW), "wrong-session");
  assert.equal(await verifyHlsPartyPass(pass, EXPECTED, SECRET, NOW), null);
});

test("expired", async () => {
  const pass = mintPass(baseClaims({ e: NOW - 1 }), SECRET);
  assert.equal(await describeHlsPartyPass(pass, EXPECTED, SECRET, NOW), "expired");
  assert.equal(await verifyHlsPartyPass(pass, EXPECTED, SECRET, NOW), null);
});

test("channel and session are checked before expiry, matching the viewer token port's own order", async () => {
  const pass = mintPass(baseClaims({ c: "other-channel", e: NOW - 1 }), SECRET);
  assert.equal(await describeHlsPartyPass(pass, EXPECTED, SECRET, NOW), "wrong-channel");
});

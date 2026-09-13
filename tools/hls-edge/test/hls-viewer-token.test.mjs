import { strict as assert } from "node:assert";
import { createHmac } from "node:crypto";
import test from "node:test";
import {
  HLS_VIEWER_TOKEN_PARAM,
  HLS_VIEWER_TOKEN_TTL_MS,
  describeHlsViewerToken,
  verifyHlsViewerToken,
} from "../src/hls-viewer-token.js";

/**
 * A token minted the same way `mintHlsViewerToken` in
 * `server/src/voice/hls-viewer-token.ts` does, but with Node's `crypto`
 * (`createHmac`) rather than the Web Crypto (`crypto.subtle`) the module
 * under test uses to verify. That mismatch is deliberate: the two
 * implementations have to agree on the SAME bytes for the SAME key, so a
 * token minted with one crypto backend and verified with the other is a
 * stronger fidelity check than testing the port against itself would be — an
 * HMAC computation bug in the port would show up as every "valid" token here
 * failing verification, not as a self-consistent pair of bugs that cancel out.
 */
function sign(payload, secret) {
  return createHmac("sha256", secret).update(payload).digest("base64url");
}

function mintToken(claims, secret) {
  const payload = Buffer.from(JSON.stringify(claims), "utf8").toString("base64url");
  return `${payload}.${sign(payload, secret)}`;
}

const SECRET = "test-derived-secret";
const CHANNEL = "channel-1";
const STARTED_AT = 1_726_000_000_000;
const NOW = 1_726_000_100_000;

function baseClaims(overrides = {}) {
  return {
    v: 1,
    u: "user-1",
    c: CHANNEL,
    s: STARTED_AT,
    e: NOW + 60_000,
    i: NOW - 1_000,
    ...overrides,
  };
}

const EXPECTED = { channelId: CHANNEL, startedAt: STARTED_AT };

test("HLS_VIEWER_TOKEN_PARAM is the same query name the origin uses", () => {
  assert.equal(HLS_VIEWER_TOKEN_PARAM, "t");
});

test("verifies a token minted with a different HMAC backend, and returns the right claims", async () => {
  const token = mintToken(baseClaims(), SECRET);
  const result = await verifyHlsViewerToken(token, EXPECTED, SECRET, NOW);
  assert.deepEqual(result, { userId: "user-1", issuedAt: NOW - 1_000 });
  assert.equal(await describeHlsViewerToken(token, EXPECTED, SECRET, NOW), null);
});

test("falls back to e - TTL for issuedAt on a token with no `i` claim", async () => {
  const claims = baseClaims();
  delete claims.i;
  const token = mintToken(claims, SECRET);
  const result = await verifyHlsViewerToken(token, EXPECTED, SECRET, NOW);
  assert.equal(result?.issuedAt, claims.e - HLS_VIEWER_TOKEN_TTL_MS);
});

test("missing token", async () => {
  assert.equal(await verifyHlsViewerToken(null, EXPECTED, SECRET, NOW), null);
  assert.equal(await describeHlsViewerToken(null, EXPECTED, SECRET, NOW), "missing");
  assert.equal(await describeHlsViewerToken(undefined, EXPECTED, SECRET, NOW), "missing");
  assert.equal(await describeHlsViewerToken("", EXPECTED, SECRET, NOW), "missing");
});

test("unconfigured secret fails closed", async () => {
  const token = mintToken(baseClaims(), SECRET);
  assert.equal(await verifyHlsViewerToken(token, EXPECTED, null, NOW), null);
  assert.equal(await describeHlsViewerToken(token, EXPECTED, null, NOW), "unconfigured");
  assert.equal(await describeHlsViewerToken(token, EXPECTED, undefined, NOW), "unconfigured");
});

test("malformed: no separator at all", async () => {
  assert.equal(await describeHlsViewerToken("not-a-token", EXPECTED, SECRET, NOW), "malformed");
  assert.equal(await describeHlsViewerToken(".mac-only", EXPECTED, SECRET, NOW), "malformed");
  assert.equal(await verifyHlsViewerToken("not-a-token", EXPECTED, SECRET, NOW), null);
});

test("a garbled, non-base64 mac reads as bad-signature, not malformed", async () => {
  // The mac is never base64-decoded before comparison -- it is compared as a
  // STRING against the correct signature's own base64url text, the same way
  // `equal()` in hls-viewer-token.ts does. So a mac that is not even valid
  // base64 simply fails that comparison rather than earning a special case.
  assert.equal(
    await describeHlsViewerToken("not base64!!.not base64 either!!", EXPECTED, SECRET, NOW),
    "bad-signature",
  );
});

test("malformed: valid signature over payload that is not the expected claim shape", async () => {
  const payload = Buffer.from(JSON.stringify({ not: "claims" }), "utf8").toString("base64url");
  const token = `${payload}.${sign(payload, SECRET)}`;
  assert.equal(await describeHlsViewerToken(token, EXPECTED, SECRET, NOW), "malformed");
});

test("bad signature: tampered mac", async () => {
  const token = mintToken(baseClaims(), SECRET);
  const [payload] = token.split(".");
  const tampered = `${payload}.${"a".repeat(43)}`;
  assert.equal(await describeHlsViewerToken(tampered, EXPECTED, SECRET, NOW), "bad-signature");
  assert.equal(await verifyHlsViewerToken(tampered, EXPECTED, SECRET, NOW), null);
});

test("bad signature: signed with the wrong secret", async () => {
  const token = mintToken(baseClaims(), "a-different-secret");
  assert.equal(await describeHlsViewerToken(token, EXPECTED, SECRET, NOW), "bad-signature");
});

test("wrong channel", async () => {
  const token = mintToken(baseClaims({ c: "some-other-channel" }), SECRET);
  assert.equal(await describeHlsViewerToken(token, EXPECTED, SECRET, NOW), "wrong-channel");
  assert.equal(await verifyHlsViewerToken(token, EXPECTED, SECRET, NOW), null);
});

test("wrong session: same channel, different startedAt (an egress restart)", async () => {
  const token = mintToken(baseClaims({ s: STARTED_AT + 1 }), SECRET);
  assert.equal(await describeHlsViewerToken(token, EXPECTED, SECRET, NOW), "wrong-session");
  assert.equal(await verifyHlsViewerToken(token, EXPECTED, SECRET, NOW), null);
});

test("expired", async () => {
  const token = mintToken(baseClaims({ e: NOW - 1 }), SECRET);
  assert.equal(await describeHlsViewerToken(token, EXPECTED, SECRET, NOW), "expired");
  assert.equal(await verifyHlsViewerToken(token, EXPECTED, SECRET, NOW), null);
});

test("channel and session are checked before expiry, matching the origin's own order", async () => {
  // An expired token for the WRONG channel should read as "wrong-channel",
  // not "expired" -- the origin's `describeHlsViewerToken` checks binding
  // before expiry, and a caller debugging a stall needs to know which one.
  const token = mintToken(baseClaims({ c: "other-channel", e: NOW - 1 }), SECRET);
  assert.equal(await describeHlsViewerToken(token, EXPECTED, SECRET, NOW), "wrong-channel");
});

test("purpose: omitted `expected.purpose` accepts a token of any purpose (the live route's own rule)", async () => {
  const liveToken = mintToken(baseClaims({ p: "live" }), SECRET);
  const replayToken = mintToken(baseClaims({ p: "replay" }), SECRET);
  const noPurposeToken = mintToken(baseClaims(), SECRET);
  assert.ok(await verifyHlsViewerToken(liveToken, EXPECTED, SECRET, NOW));
  assert.ok(await verifyHlsViewerToken(replayToken, EXPECTED, SECRET, NOW));
  assert.ok(await verifyHlsViewerToken(noPurposeToken, EXPECTED, SECRET, NOW));
});

test("purpose: a caller that DOES pass expected.purpose enforces it", async () => {
  const liveToken = mintToken(baseClaims({ p: "live" }), SECRET);
  const noPurposeToken = mintToken(baseClaims(), SECRET); // defaults to "live"
  const replayExpected = { ...EXPECTED, purpose: "replay" };
  const liveExpected = { ...EXPECTED, purpose: "live" };
  assert.equal(await verifyHlsViewerToken(liveToken, replayExpected, SECRET, NOW), null);
  assert.ok(await verifyHlsViewerToken(liveToken, liveExpected, SECRET, NOW));
  // A token with no `p` claim at all defaults to "live", same as the origin.
  assert.ok(await verifyHlsViewerToken(noPurposeToken, liveExpected, SECRET, NOW));
  assert.equal(await verifyHlsViewerToken(noPurposeToken, replayExpected, SECRET, NOW), null);
});

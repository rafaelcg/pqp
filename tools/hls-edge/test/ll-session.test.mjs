import { strict as assert } from "node:assert";
import { createHash } from "node:crypto";
import test from "node:test";

import { deriveLlSessionId } from "../src/ll-session.js";

/**
 * The reference implementation, `node:crypto`-based, byte-for-byte the same
 * construction as `deriveLlSessionId` in `server/src/voice/hls-remux.ts`.
 * Computed independently of `../src/ll-session.js`'s Web Crypto version so
 * this test is the same two-backends-one-answer fidelity check
 * `hls-viewer-token.test.mjs` already uses for the token port: a drift
 * between the two shows up as every case failing, not just an edge case
 * both implementations happen to agree on.
 */
function referenceDeriveLlSessionId(channelId, startedAtMs) {
  const hash = createHash("sha256").update(`${channelId}:${startedAtMs}`).digest("hex");
  const variantNibble = "89ab"[Number.parseInt(hash[16], 16) % 4];
  return [
    hash.slice(0, 8),
    hash.slice(8, 12),
    `5${hash.slice(13, 16)}`,
    `${variantNibble}${hash.slice(17, 20)}`,
    hash.slice(20, 32),
  ].join("-");
}

test("matches the node:crypto reference for a handful of (channelId, startedAtMs) pairs", async () => {
  const cases = [
    ["chan_abc123", 1757865600000],
    ["chan_xyz789", 0],
    ["", 1],
    ["a-very-long-channel-id-with-dashes-and-numbers-123456789", 9999999999999],
  ];
  for (const [channelId, startedAtMs] of cases) {
    const actual = await deriveLlSessionId(channelId, startedAtMs);
    const expected = referenceDeriveLlSessionId(channelId, startedAtMs);
    assert.equal(actual, expected, `mismatch for (${channelId}, ${startedAtMs})`);
  }
});

test("is pure and deterministic: same input, same output, called twice", async () => {
  const first = await deriveLlSessionId("chan_1", 100);
  const second = await deriveLlSessionId("chan_1", 100);
  assert.equal(first, second);
});

test("is shaped like a UUID (matches remuxSessionInfoSchema.sessionId's z.string().uuid())", async () => {
  const id = await deriveLlSessionId("chan_1", 100);
  assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
});

test("different inputs produce different ids", async () => {
  const a = await deriveLlSessionId("chan_1", 100);
  const b = await deriveLlSessionId("chan_2", 100);
  const c = await deriveLlSessionId("chan_1", 200);
  assert.notEqual(a, b);
  assert.notEqual(a, c);
  assert.notEqual(b, c);
});

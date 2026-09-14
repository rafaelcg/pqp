import { strict as assert } from "node:assert";
import test from "node:test";
import {
  PARTY_PASS_REVOCATION_CACHE_TTL_MS,
  PartyPassRevocationGate,
  partyPassRequiresKvInProduction,
} from "../src/party-pass-revocation.js";

/** A minimal `KVNamespace`-shaped fake: only `get` is ever called. */
function fakeKv(entries = {}) {
  return {
    async get(key) {
      return Object.prototype.hasOwnProperty.call(entries, key) ? entries[key] : null;
    },
  };
}

function throwingKv(error = new Error("kv unavailable")) {
  return {
    async get() {
      throw error;
    },
  };
}

const ISSUED_AT = 1_000_000;

test("no KV bound: fails open, not revoked, no error", async () => {
  const gate = new PartyPassRevocationGate();
  const result = await gate.check(undefined, "user-1", "chan-1", ISSUED_AT);
  assert.deepEqual(result, { revoked: false, kvError: false });
});

test("KV bound, neither key present: not revoked", async () => {
  const gate = new PartyPassRevocationGate();
  const kv = fakeKv();
  const result = await gate.check(kv, "user-1", "chan-1", ISSUED_AT);
  assert.deepEqual(result, { revoked: false, kvError: false });
});

test("KV bound, per-viewer key revoked AFTER issuedAt: revoked", async () => {
  const gate = new PartyPassRevocationGate();
  const kv = fakeKv({ "user-1:chan-1": String(ISSUED_AT + 1) });
  const result = await gate.check(kv, "user-1", "chan-1", ISSUED_AT);
  assert.deepEqual(result, { revoked: true, kvError: false });
});

test("KV bound, per-viewer key revoked BEFORE issuedAt: NOT revoked -- a fresh credential outruns an old ban record", async () => {
  const gate = new PartyPassRevocationGate();
  const kv = fakeKv({ "user-1:chan-1": String(ISSUED_AT - 1) });
  const result = await gate.check(kv, "user-1", "chan-1", ISSUED_AT);
  assert.deepEqual(result, { revoked: false, kvError: false });
});

test("a revocation exactly AT issuedAt does not revoke -- ties go to the fresh grant, same rule as hls-revocation.ts", async () => {
  const gate = new PartyPassRevocationGate();
  const kv = fakeKv({ "user-1:chan-1": String(ISSUED_AT) });
  const result = await gate.check(kv, "user-1", "chan-1", ISSUED_AT);
  assert.equal(result.revoked, false);
});

test("channel-wide key revoked after issuedAt also revokes, even with no per-viewer record", async () => {
  const gate = new PartyPassRevocationGate();
  const kv = fakeKv({ "channel:chan-1": String(ISSUED_AT + 1) });
  const result = await gate.check(kv, "user-1", "chan-1", ISSUED_AT);
  assert.deepEqual(result, { revoked: true, kvError: false });
});

test("takes the max of the two keys when both are present", async () => {
  const gate = new PartyPassRevocationGate();
  const kv = fakeKv({
    "user-1:chan-1": String(ISSUED_AT - 100),
    "channel:chan-1": String(ISSUED_AT + 1),
  });
  const result = await gate.check(kv, "user-1", "chan-1", ISSUED_AT);
  assert.equal(result.revoked, true);
});

test("keyed by userId:channelId -- a per-viewer revocation on one channel does not leak to another", async () => {
  const gate = new PartyPassRevocationGate();
  const kv = fakeKv({ "user-1:chan-1": String(ISSUED_AT + 1) });
  assert.equal((await gate.check(kv, "user-1", "chan-2", ISSUED_AT)).revoked, false);
  assert.equal((await gate.check(kv, "user-2", "chan-1", ISSUED_AT)).revoked, false);
});

test("KV bound but throws on either key: fails CLOSED (revoked: true), and reports the error", async () => {
  const gate = new PartyPassRevocationGate();
  const kv = throwingKv();
  const result = await gate.check(kv, "user-1", "chan-1", ISSUED_AT);
  assert.deepEqual(result, { revoked: true, kvError: true });
});

test("a KV error is not cached -- the next call re-reads once the namespace recovers", async () => {
  const gate = new PartyPassRevocationGate();
  let shouldThrow = true;
  const kv = {
    async get() {
      if (shouldThrow) {
        throw new Error("still down");
      }
      return null;
    },
  };
  const now = 1_000_000;
  const first = await gate.check(kv, "user-1", "chan-1", ISSUED_AT, now);
  assert.deepEqual(first, { revoked: true, kvError: true });
  shouldThrow = false;
  // Immediately after -- a cached fail-closed result would still say
  // revoked here even though the namespace has recovered.
  const second = await gate.check(kv, "user-1", "chan-1", ISSUED_AT, now + 1);
  assert.deepEqual(second, { revoked: false, kvError: false });
});

test("caches the revocation timestamp for PARTY_PASS_REVOCATION_CACHE_TTL_MS, reused correctly across two different issuedAt values", async () => {
  const gate = new PartyPassRevocationGate();
  let reads = 0;
  const kv = {
    async get(key) {
      reads += 1;
      return key === "user-1:chan-1" ? String(ISSUED_AT + 500) : null;
    },
  };
  const now = 1_000_000;
  // A credential issued before the recorded revocation: revoked.
  assert.equal((await gate.check(kv, "user-1", "chan-1", ISSUED_AT, now)).revoked, true);
  // A DIFFERENT credential (later issuedAt) checked inside the same cache
  // window: the cached TIMESTAMP is compared fresh against ITS issuedAt,
  // not a stale cached boolean -- so this one reads correctly as NOT
  // revoked without a second KV read.
  assert.equal(
    (await gate.check(kv, "user-1", "chan-1", ISSUED_AT + 1_000, now + 1)).revoked,
    false,
  );
  assert.equal(reads, 2); // one per distinct key (user, channel), not per call
  // Still within the window: no new reads.
  await gate.check(kv, "user-1", "chan-1", ISSUED_AT, now + PARTY_PASS_REVOCATION_CACHE_TTL_MS - 1);
  assert.equal(reads, 2);
  // Past the window: re-reads both keys.
  await gate.check(kv, "user-1", "chan-1", ISSUED_AT, now + PARTY_PASS_REVOCATION_CACHE_TTL_MS + 1);
  assert.equal(reads, 4);
});

test("evicts the oldest entry once the cache is full, rather than growing without bound", async () => {
  const gate = new PartyPassRevocationGate();
  const kv = fakeKv();
  const now = 1_000_000;
  // Fill past the cap (10,000) with distinct per-viewer keys (one KV key
  // each, since the channel key is shared and only adds one more entry).
  const CAP = 10_000;
  for (let i = 0; i < CAP; i++) {
    await gate.check(kv, `user-${i}`, "chan-1", ISSUED_AT, now);
  }
  await gate.check(kv, "user-overflow", "chan-1", ISSUED_AT, now);
  assert.ok(gate._cache.size <= CAP);
});

test("partyPassRequiresKvInProduction: false when KV is bound, regardless of ENVIRONMENT", () => {
  assert.equal(
    partyPassRequiresKvInProduction({ ENVIRONMENT: "production", HLS_REVOKED_USERS: fakeKv() }),
    false,
  );
});

test("partyPassRequiresKvInProduction: false outside production, even with no KV bound", () => {
  assert.equal(partyPassRequiresKvInProduction({}), false);
  assert.equal(partyPassRequiresKvInProduction({ ENVIRONMENT: "development" }), false);
  assert.equal(partyPassRequiresKvInProduction({ ENVIRONMENT: "staging" }), false);
});

test("partyPassRequiresKvInProduction: true in production with no KV bound -- the case that used to fail open", () => {
  assert.equal(partyPassRequiresKvInProduction({ ENVIRONMENT: "production" }), true);
});

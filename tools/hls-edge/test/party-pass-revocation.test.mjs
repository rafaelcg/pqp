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

test("no KV bound: fails open, not revoked, no error", async () => {
  const gate = new PartyPassRevocationGate();
  const result = await gate.check(undefined, "user-1", "chan-1");
  assert.deepEqual(result, { revoked: false, kvError: false });
});

test("KV bound, key absent: not revoked", async () => {
  const gate = new PartyPassRevocationGate();
  const kv = fakeKv();
  const result = await gate.check(kv, "user-1", "chan-1");
  assert.deepEqual(result, { revoked: false, kvError: false });
});

test("KV bound, key present: revoked", async () => {
  const gate = new PartyPassRevocationGate();
  const kv = fakeKv({ "user-1:chan-1": "1726000000000" });
  const result = await gate.check(kv, "user-1", "chan-1");
  assert.deepEqual(result, { revoked: true, kvError: false });
});

test("keyed by userId:channelId -- a revocation on one channel does not leak to another", async () => {
  const gate = new PartyPassRevocationGate();
  const kv = fakeKv({ "user-1:chan-1": "1726000000000" });
  assert.equal((await gate.check(kv, "user-1", "chan-2")).revoked, false);
  assert.equal((await gate.check(kv, "user-2", "chan-1")).revoked, false);
});

test("KV bound but throws: fails CLOSED (revoked: true), and reports the error", async () => {
  const gate = new PartyPassRevocationGate();
  const kv = throwingKv();
  const result = await gate.check(kv, "user-1", "chan-1");
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
  const first = await gate.check(kv, "user-1", "chan-1", now);
  assert.deepEqual(first, { revoked: true, kvError: true });
  shouldThrow = false;
  // Immediately after -- a cached fail-closed result would still say
  // revoked here even though the namespace has recovered.
  const second = await gate.check(kv, "user-1", "chan-1", now + 1);
  assert.deepEqual(second, { revoked: false, kvError: false });
});

test("caches a result for PARTY_PASS_REVOCATION_CACHE_TTL_MS, both revoked and not", async () => {
  const gate = new PartyPassRevocationGate();
  let reads = 0;
  const kv = {
    async get(key) {
      reads += 1;
      return key === "user-1:chan-1" ? "revoked-at" : null;
    },
  };
  const now = 1_000_000;
  assert.equal((await gate.check(kv, "user-1", "chan-1", now)).revoked, true);
  assert.equal((await gate.check(kv, "user-2", "chan-1", now)).revoked, false);
  assert.equal(reads, 2);
  // Same window, both keys: no new reads.
  assert.equal(
    (await gate.check(kv, "user-1", "chan-1", now + PARTY_PASS_REVOCATION_CACHE_TTL_MS - 1)).revoked,
    true,
  );
  assert.equal(
    (await gate.check(kv, "user-2", "chan-1", now + PARTY_PASS_REVOCATION_CACHE_TTL_MS - 1)).revoked,
    false,
  );
  assert.equal(reads, 2);
  // Past the window: re-reads.
  await gate.check(kv, "user-1", "chan-1", now + PARTY_PASS_REVOCATION_CACHE_TTL_MS + 1);
  assert.equal(reads, 3);
});

test("evicts the oldest entry once the cache is full, rather than growing without bound", async () => {
  const gate = new PartyPassRevocationGate();
  const kv = fakeKv();
  const now = 1_000_000;
  // Fill past the cap (10,000) with one extra distinct key.
  const CAP = 10_000;
  for (let i = 0; i < CAP; i++) {
    await gate.check(kv, `user-${i}`, "chan-1", now);
  }
  assert.equal(gate._cache.size, CAP);
  await gate.check(kv, "user-overflow", "chan-1", now);
  assert.equal(gate._cache.size, CAP);
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

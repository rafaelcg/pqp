import { strict as assert } from "node:assert";
import test from "node:test";
import {
  PARTY_PASS_REVOCATION_CACHE_TTL_MS,
  PartyPassRevocationGate,
  partyPassRequiresKvInProduction,
} from "../src/party-pass-revocation.js";

/**
 * A minimal `KVNamespace`-shaped fake backed by a plain object, matching
 * the append-only key shape `hls-edge-revocation.ts` writes:
 * `<userId>:<channelId>:<revokedAtMs>` or `channel:<channelId>:<revokedAtMs>`.
 * Only `list` is ever called by the gate now -- `get` is not part of the
 * read path any more (see the module doc comment for why).
 */
function fakeKv(keyNames = []) {
  return {
    async list({ prefix }) {
      return { keys: keyNames.filter((name) => name.startsWith(prefix)).map((name) => ({ name })) };
    },
  };
}

function throwingKv(error = new Error("kv unavailable")) {
  return {
    async list() {
      throw error;
    },
  };
}

/**
 * A KV fake that paginates: `pageSize` key names per call, following
 * `cursor`, matching the real Cloudflare `list_complete`/`cursor` shape.
 * Used to prove `_readMaxForPrefix` actually follows the cursor instead of
 * only ever reading the first page.
 */
function pagedFakeKv(keyNames, pageSize) {
  return {
    async list({ prefix, cursor }) {
      const matching = keyNames.filter((name) => name.startsWith(prefix));
      const start = cursor ? Number(cursor) : 0;
      const page = matching.slice(start, start + pageSize);
      const nextStart = start + pageSize;
      const complete = nextStart >= matching.length;
      return {
        keys: page.map((name) => ({ name })),
        list_complete: complete,
        cursor: complete ? undefined : String(nextStart),
      };
    },
  };
}

const ISSUED_AT = 1_000_000;

test("no KV bound: fails open, not revoked, no error", async () => {
  const gate = new PartyPassRevocationGate();
  const result = await gate.check(undefined, "user-1", "chan-1", ISSUED_AT);
  assert.deepEqual(result, { revoked: false, kvError: false });
});

test("KV bound, no keys under either prefix: not revoked", async () => {
  const gate = new PartyPassRevocationGate();
  const kv = fakeKv([]);
  const result = await gate.check(kv, "user-1", "chan-1", ISSUED_AT);
  assert.deepEqual(result, { revoked: false, kvError: false });
});

test("KV bound, a per-viewer key AFTER issuedAt: revoked", async () => {
  const gate = new PartyPassRevocationGate();
  const kv = fakeKv([`user-1:chan-1:${ISSUED_AT + 1}`]);
  const result = await gate.check(kv, "user-1", "chan-1", ISSUED_AT);
  assert.deepEqual(result, { revoked: true, kvError: false });
});

test("KV bound, a per-viewer key BEFORE issuedAt: NOT revoked -- a fresh credential outruns an old ban record", async () => {
  const gate = new PartyPassRevocationGate();
  const kv = fakeKv([`user-1:chan-1:${ISSUED_AT - 1}`]);
  const result = await gate.check(kv, "user-1", "chan-1", ISSUED_AT);
  assert.deepEqual(result, { revoked: false, kvError: false });
});

test("a revocation exactly AT issuedAt does not revoke -- ties go to the fresh grant, same rule as hls-revocation.ts", async () => {
  const gate = new PartyPassRevocationGate();
  const kv = fakeKv([`user-1:chan-1:${ISSUED_AT}`]);
  const result = await gate.check(kv, "user-1", "chan-1", ISSUED_AT);
  assert.equal(result.revoked, false);
});

test("channel-wide key revoked after issuedAt also revokes, even with no per-viewer key", async () => {
  const gate = new PartyPassRevocationGate();
  const kv = fakeKv([`channel:chan-1:${ISSUED_AT + 1}`]);
  const result = await gate.check(kv, "user-1", "chan-1", ISSUED_AT);
  assert.deepEqual(result, { revoked: true, kvError: false });
});

test("takes the MAX across multiple append-only keys under the same prefix, not just the first listed", async () => {
  const gate = new PartyPassRevocationGate();
  // Three separate evictions for the same viewer, in an arbitrary listed
  // order -- append-only means all three keys persist.
  const kv = fakeKv([
    `user-1:chan-1:${ISSUED_AT - 5_000}`,
    `user-1:chan-1:${ISSUED_AT + 2_000}`,
    `user-1:chan-1:${ISSUED_AT - 1_000}`,
  ]);
  const result = await gate.check(kv, "user-1", "chan-1", ISSUED_AT);
  assert.equal(result.revoked, true); // the +2000 key wins
});

test("takes the max of the per-viewer prefix and the channel-wide prefix together", async () => {
  const gate = new PartyPassRevocationGate();
  const kv = fakeKv([
    `user-1:chan-1:${ISSUED_AT - 100}`,
    `channel:chan-1:${ISSUED_AT + 1}`,
  ]);
  const result = await gate.check(kv, "user-1", "chan-1", ISSUED_AT);
  assert.equal(result.revoked, true);
});

test("keyed by userId:channelId -- a per-viewer revocation on one channel does not leak to another", async () => {
  const gate = new PartyPassRevocationGate();
  const kv = fakeKv([`user-1:chan-1:${ISSUED_AT + 1}`]);
  assert.equal((await gate.check(kv, "user-1", "chan-2", ISSUED_AT)).revoked, false);
  assert.equal((await gate.check(kv, "user-2", "chan-1", ISSUED_AT)).revoked, false);
});

test("a channelId that is a PREFIX of another channelId does not collide (the trailing colon protects it)", async () => {
  const gate = new PartyPassRevocationGate();
  const kv = fakeKv([`user-1:chan-12:${ISSUED_AT + 1}`]); // a DIFFERENT channel, "chan-12"
  const result = await gate.check(kv, "user-1", "chan-1", ISSUED_AT);
  assert.equal(result.revoked, false);
});

test("concurrent writers that land in either order still both show up in the same list -- nothing to race on the read side", async () => {
  const gate = new PartyPassRevocationGate();
  // Simulates two evictions (older, newer) whose PUTs reached the store in
  // reverse chronological order -- append-only means the list still
  // contains both regardless, and the gate still finds the newer one.
  const kv = fakeKv([`user-1:chan-1:${ISSUED_AT + 500}`, `user-1:chan-1:${ISSUED_AT - 500}`]);
  const result = await gate.check(kv, "user-1", "chan-1", ISSUED_AT);
  assert.equal(result.revoked, true);
});

test("KV bound but throws on list: fails CLOSED (revoked: true), and reports the error", async () => {
  const gate = new PartyPassRevocationGate();
  const kv = throwingKv();
  const result = await gate.check(kv, "user-1", "chan-1", ISSUED_AT);
  assert.deepEqual(result, { revoked: true, kvError: true });
});

test("a KV error is not cached -- the next call re-lists once the namespace recovers", async () => {
  const gate = new PartyPassRevocationGate();
  let shouldThrow = true;
  const kv = {
    async list() {
      if (shouldThrow) {
        throw new Error("still down");
      }
      return { keys: [] };
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

test("caches the max timestamp for PARTY_PASS_REVOCATION_CACHE_TTL_MS, reused correctly across two different issuedAt values", async () => {
  const gate = new PartyPassRevocationGate();
  let listCalls = 0;
  const kv = {
    async list({ prefix }) {
      listCalls += 1;
      return prefix === "user-1:chan-1:" ? { keys: [{ name: `user-1:chan-1:${ISSUED_AT + 500}` }] } : { keys: [] };
    },
  };
  const now = 1_000_000;
  assert.equal((await gate.check(kv, "user-1", "chan-1", ISSUED_AT, now)).revoked, true);
  assert.equal(
    (await gate.check(kv, "user-1", "chan-1", ISSUED_AT + 1_000, now + 1)).revoked,
    false,
  );
  assert.equal(listCalls, 2); // one per distinct prefix, not per call
  // Still within the window: no new list calls.
  await gate.check(kv, "user-1", "chan-1", ISSUED_AT, now + PARTY_PASS_REVOCATION_CACHE_TTL_MS - 1);
  assert.equal(listCalls, 2);
  // Past the window: re-lists both prefixes.
  await gate.check(kv, "user-1", "chan-1", ISSUED_AT, now + PARTY_PASS_REVOCATION_CACHE_TTL_MS + 1);
  assert.equal(listCalls, 4);
});

test("evicts the oldest entry once the cache is full, rather than growing without bound", async () => {
  const gate = new PartyPassRevocationGate();
  const kv = fakeKv([]);
  const now = 1_000_000;
  const CAP = 10_000;
  for (let i = 0; i < CAP; i++) {
    await gate.check(kv, `user-${i}`, "chan-1", ISSUED_AT, now);
  }
  await gate.check(kv, "user-overflow", "chan-1", ISSUED_AT, now);
  assert.ok(gate._cache.size <= CAP);
});

test("follows the cursor: the newest revocation on a LATER page is still found, not just the first page", async () => {
  const gate = new PartyPassRevocationGate();
  // Six keys under the prefix, two per page, oldest first -- the newest
  // (which must win) lands on the LAST page.
  const keys = [
    `user-1:chan-1:${ISSUED_AT - 5_000}`,
    `user-1:chan-1:${ISSUED_AT - 4_000}`,
    `user-1:chan-1:${ISSUED_AT - 3_000}`,
    `user-1:chan-1:${ISSUED_AT - 2_000}`,
    `user-1:chan-1:${ISSUED_AT - 1_000}`,
    `user-1:chan-1:${ISSUED_AT + 1}`, // newest, on the 3rd page
  ];
  const kv = pagedFakeKv(keys, 2);
  const result = await gate.check(kv, "user-1", "chan-1", ISSUED_AT);
  assert.deepEqual(result, { revoked: true, kvError: false });
});

test("a single-page prefix (the common case) does not even need a cursor", async () => {
  const gate = new PartyPassRevocationGate();
  const kv = pagedFakeKv([`user-1:chan-1:${ISSUED_AT + 1}`], 1_000);
  const result = await gate.check(kv, "user-1", "chan-1", ISSUED_AT);
  assert.deepEqual(result, { revoked: true, kvError: false });
});

test("running out of pages (MAX_LIST_PAGES) with more still unread fails CLOSED, never a truncated answer", async () => {
  const gate = new PartyPassRevocationGate();
  // 11 pages' worth at 1 key per page -- one more page than the gate will
  // read (MAX_LIST_PAGES = 10) -- so the list is never actually exhausted.
  const keys = Array.from({ length: 11 }, (_, i) => `user-1:chan-1:${ISSUED_AT - 10_000 + i}`);
  const kv = pagedFakeKv(keys, 1);
  const result = await gate.check(kv, "user-1", "chan-1", ISSUED_AT);
  assert.deepEqual(result, { revoked: true, kvError: true });
});

test("partyPassRequiresKvInProduction: false when KV is bound, regardless of ENVIRONMENT", () => {
  assert.equal(
    partyPassRequiresKvInProduction({ ENVIRONMENT: "production", HLS_REVOKED_USERS: fakeKv([]) }),
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

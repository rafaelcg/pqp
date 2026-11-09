import { strict as assert } from "node:assert";
import test from "node:test";
import {
  PARTY_PASS_REVOCATION_CACHE_TTL_MS,
  PARTY_PASS_REVOCATION_LISTING_JOIN_MAX_MS,
  PARTY_PASS_REVOCATION_MAX_LIST_PAGES,
  PartyPassRevocationGate,
} from "../src/party-pass-revocation.js";

/**
 * The namespace listing: one `kv.list` sweep per isolate per window, shared by
 * every viewer and every concurrent caller. What it must keep from the
 * per-prefix gate it replaced (decisions, the 30 s bound, fail-closed rules)
 * is pinned against a copy of the old gate in
 * `party-pass-revocation-differential.test.mjs`; this file pins the new
 * behaviour: the list COUNT, the single shared in-flight listing, the failure
 * and overflow handling, and the staleness bound.
 */

const T0 = 1_700_000_000_000;
const ISSUED_AT = T0;
const TTL = PARTY_PASS_REVOCATION_CACHE_TTL_MS;

/** A paged, counting KV fake. `keyNames` may be mutated between calls. */
function countingKv(keyNames, pageSize = 1000) {
  const state = { calls: 0, prefixed: 0, keyNames };
  state.kv = {
    async list({ prefix, cursor } = {}) {
      state.calls += 1;
      if (prefix) {
        state.prefixed += 1;
      }
      const matching = state.keyNames.filter((name) => name.startsWith(prefix ?? ""));
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
  return state;
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function recordingLog() {
  const lines = [];
  return { lines, log: (event, fields) => lines.push({ event, ...fields }) };
}

test("the window is the signed-off 30 seconds, and has not been raised", () => {
  assert.equal(PARTY_PASS_REVOCATION_CACHE_TTL_MS, 30_000);
});

test("200 distinct viewers across 3 channels in one window cost ONE list, with no prefix", async () => {
  const state = countingKv([`user_0007:channel-1:${T0 + 1}`]);
  const gate = new PartyPassRevocationGate();
  const results = new Map();
  for (let i = 0; i < 200; i++) {
    const userId = `user_${String(i).padStart(4, "0")}`;
    results.set(userId, await gate.check(state.kv, userId, `channel-${i % 3}`, ISSUED_AT, T0));
  }
  assert.equal(state.calls, 1);
  assert.equal(state.prefixed, 0);
  assert.equal(gate.stats.listCalls, 1);
  // ...and the one revoked viewer is the one it was.
  for (const [userId, result] of results) {
    assert.deepEqual(result, { revoked: userId === "user_0007", kvError: false }, userId);
  }
});

test("a thundering herd on a cold isolate shares ONE in-flight listing", async () => {
  const gate = new PartyPassRevocationGate();
  const release = deferred();
  const state = countingKv([`user_0003:channel-0:${T0 + 5}`, `channel:channel-2:${T0 + 5}`]);
  const inner = state.kv.list;
  let started = 0;
  state.kv.list = async (opts) => {
    started += 1;
    await release.promise;
    return inner(opts);
  };

  const pending = [];
  for (let i = 0; i < 200; i++) {
    pending.push(gate.check(state.kv, `user_${String(i).padStart(4, "0")}`, `channel-${i % 3}`, ISSUED_AT, T0));
  }
  // Every caller is parked on the same listing; none started its own.
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(started, 1);
  release.resolve();
  const results = await Promise.all(pending);
  assert.equal(started, 1);
  assert.equal(state.calls, 1);
  results.forEach((result, i) => {
    // user_0003 on channel-0 (3 % 3 == 0), and the whole of channel-2.
    assert.deepEqual(result, { revoked: i === 3 || i % 3 === 2, kvError: false }, `viewer ${i}`);
  });
});

test("a paged namespace is followed to the end in one listing, shared by a herd", async () => {
  const gate = new PartyPassRevocationGate();
  const keys = Array.from({ length: 7 }, (_, i) => `u${i}:c1:${T0 - 1_000 + i}`);
  keys.push(`late:c1:${T0 + 1}`); // newest, on the last page
  const state = countingKv(keys, 3);
  const results = await Promise.all([
    gate.check(state.kv, "late", "c1", ISSUED_AT, T0),
    gate.check(state.kv, "u1", "c1", ISSUED_AT, T0),
    gate.check(state.kv, "nobody", "c1", ISSUED_AT, T0),
  ]);
  assert.equal(state.calls, 3); // 8 keys at 3 per page
  assert.deepEqual(
    results.map((r) => r.revoked),
    [true, false, false],
  );
});

test("the window: no relisting inside 30 s, one listing at the boundary, and a revocation lands within it", async () => {
  const gate = new PartyPassRevocationGate();
  const state = countingKv([]);
  assert.equal((await gate.check(state.kv, "u1", "c1", ISSUED_AT, T0)).revoked, false);
  assert.equal(state.calls, 1);

  // A moderator kicks u1 one millisecond after the snapshot.
  state.keyNames.push(`u1:c1:${ISSUED_AT + 1}`);

  // 29,999 ms in: still the old snapshot. This is the signed-off bound, the
  // same one the per-prefix cache had: a revocation reaches a gate within 30 s.
  assert.equal((await gate.check(state.kv, "u1", "c1", ISSUED_AT, T0 + TTL - 1)).revoked, false);
  assert.equal(state.calls, 1);

  // At exactly 30,000 ms the window is over (`now - at < TTL` is the rule).
  assert.equal((await gate.check(state.kv, "u1", "c1", ISSUED_AT, T0 + TTL)).revoked, true);
  assert.equal(state.calls, 2);
});

test("a viewer checked late in the window is NOT fresher than one checked early: the bound is per listing", async () => {
  const gate = new PartyPassRevocationGate();
  const state = countingKv([]);
  await gate.check(state.kv, "early", "c1", ISSUED_AT, T0);
  state.keyNames.push(`late:c1:${ISSUED_AT + 1}`);
  // A viewer the gate has never seen, 20 s in: the old per-viewer cache would
  // have listed for them (fresh); the shared one answers from the snapshot, and
  // that is still inside the same 30 s bound.
  assert.equal((await gate.check(state.kv, "late", "c1", ISSUED_AT, T0 + 20_000)).revoked, false);
  assert.equal((await gate.check(state.kv, "late", "c1", ISSUED_AT, T0 + TTL)).revoked, true);
});

test("a KV outage fails every waiting caller CLOSED with one list, and is never cached", async () => {
  const gate = new PartyPassRevocationGate();
  const release = deferred();
  const state = countingKv([`u1:c1:${ISSUED_AT + 1}`]);
  let failing = true;
  const inner = state.kv.list;
  state.kv.list = async (opts) => {
    await release.promise;
    if (failing) {
      state.calls += 1;
      throw new Error("kv unavailable");
    }
    return inner(opts);
  };

  const herd = Array.from({ length: 50 }, (_, i) => gate.check(state.kv, `u${i}`, "c1", ISSUED_AT, T0));
  release.resolve();
  for (const result of await Promise.all(herd)) {
    assert.deepEqual(result, { revoked: true, kvError: true });
  }
  assert.equal(state.calls, 1);
  assert.equal(gate.stats.listingFailures, 1);

  // KV recovers. The very next call lists again, and gets the TRUE answers:
  // the failure left neither an empty index ("nothing is revoked") nor a
  // cached "revoked" behind.
  failing = false;
  assert.deepEqual(await gate.check(state.kv, "u1", "c1", ISSUED_AT, T0 + 1), { revoked: true, kvError: false });
  assert.deepEqual(await gate.check(state.kv, "u2", "c1", ISSUED_AT, T0 + 1), { revoked: false, kvError: false });
});

test("a listing that fails on a LATER page installs nothing: the revoked key on that page is still found next time", async () => {
  const gate = new PartyPassRevocationGate();
  const keys = ["a:c1:1", "b:c1:2", `victim:c1:${ISSUED_AT + 1}`];
  const state = countingKv(keys, 1);
  const inner = state.kv.list;
  let failOnSecond = true;
  state.kv.list = async (opts) => {
    if (failOnSecond && opts?.cursor) {
      state.calls += 1;
      throw new Error("kv unavailable mid-listing");
    }
    return inner(opts);
  };
  assert.deepEqual(await gate.check(state.kv, "victim", "c1", ISSUED_AT, T0), { revoked: true, kvError: true });
  failOnSecond = false;
  // Had the first page alone been kept as an index, `victim` would read as
  // not revoked here.
  assert.deepEqual(await gate.check(state.kv, "victim", "c1", ISSUED_AT, T0 + 1), { revoked: true, kvError: false });
});

test("an expired snapshot is never served in place of a failed refresh", async () => {
  const gate = new PartyPassRevocationGate();
  const state = countingKv([`u1:c1:${ISSUED_AT + 1}`]);
  await gate.check(state.kv, "u2", "c1", ISSUED_AT, T0);
  assert.equal(state.calls, 1);

  const inner = state.kv.list;
  state.kv.list = async () => {
    state.calls += 1;
    throw new Error("kv unavailable");
  };
  // Inside the window the snapshot still answers and KV is not touched.
  assert.deepEqual(await gate.check(state.kv, "u2", "c1", ISSUED_AT, T0 + TTL - 1), { revoked: false, kvError: false });
  assert.equal(state.calls, 1);
  // Past it, with KV down: closed, not "the snapshot said fine".
  assert.deepEqual(await gate.check(state.kv, "u2", "c1", ISSUED_AT, T0 + TTL), { revoked: true, kvError: true });
  state.kv.list = inner;
});

test("a hung listing does not pin later callers to it, and finishing late does not clobber a newer snapshot", async () => {
  const gate = new PartyPassRevocationGate();
  const hung = deferred();
  const state = countingKv([`u1:c1:${ISSUED_AT + 1}`]);
  const inner = state.kv.list;
  let first = true;
  state.kv.list = async (opts) => {
    if (first) {
      first = false;
      state.calls += 1;
      await hung.promise;
      // What the namespace looked like when the stuck call was issued.
      return { keys: [], list_complete: true };
    }
    return inner(opts);
  };

  const stuck = gate.check(state.kv, "u1", "c1", ISSUED_AT, T0);
  await new Promise((resolve) => setImmediate(resolve));
  // Inside the join window a second caller shares the stuck listing.
  const joined = gate.check(state.kv, "u1", "c1", ISSUED_AT, T0 + PARTY_PASS_REVOCATION_LISTING_JOIN_MAX_MS - 1);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(state.calls, 1);
  // Past it, a caller starts its own and is answered.
  const fresh = await gate.check(state.kv, "u1", "c1", ISSUED_AT, T0 + PARTY_PASS_REVOCATION_LISTING_JOIN_MAX_MS);
  assert.deepEqual(fresh, { revoked: true, kvError: false });
  assert.equal(state.calls, 2);

  // The stuck call finally returns its (older, empty) view. It answers its own
  // waiters, but must not replace the newer snapshot.
  hung.resolve();
  assert.deepEqual(await stuck, { revoked: false, kvError: false });
  assert.deepEqual(await joined, { revoked: false, kvError: false });
  assert.deepEqual(
    await gate.check(state.kv, "u1", "c1", ISSUED_AT, T0 + PARTY_PASS_REVOCATION_LISTING_JOIN_MAX_MS + 1),
    { revoked: true, kvError: false },
  );
  assert.equal(state.calls, 2);
});

test("a snapshot answers only for the namespace it was read from", async () => {
  const gate = new PartyPassRevocationGate();
  const revoking = countingKv([`u1:c1:${ISSUED_AT + 1}`]);
  const empty = countingKv([]);
  assert.equal((await gate.check(empty.kv, "u1", "c1", ISSUED_AT, T0)).revoked, false);
  // Same gate, same instant, a different binding: it is listed, not answered
  // from the first one's index.
  assert.equal((await gate.check(revoking.kv, "u1", "c1", ISSUED_AT, T0)).revoked, true);
  assert.equal(revoking.calls, 1);
});

test("no KV bound lists nothing and fails open", async () => {
  const gate = new PartyPassRevocationGate();
  assert.deepEqual(await gate.check(undefined, "u1", "c1", ISSUED_AT, T0), { revoked: false, kvError: false });
  assert.equal(gate.stats.listCalls, 0);
});

// ---------------------------------------------------------------------------
// The page cap.
// ---------------------------------------------------------------------------

test("a namespace of exactly the page cap is listed in full and trusted", async () => {
  const keys = Array.from({ length: PARTY_PASS_REVOCATION_MAX_LIST_PAGES }, (_, i) => `u${i}:c1:${ISSUED_AT + 1 + i}`);
  const state = countingKv(keys, 1);
  const { lines, log } = recordingLog();
  const gate = new PartyPassRevocationGate({ log });
  // The last page is the newest key.
  assert.deepEqual(await gate.check(state.kv, "u9", "c1", ISSUED_AT, T0), { revoked: true, kvError: false });
  assert.equal(state.calls, PARTY_PASS_REVOCATION_MAX_LIST_PAGES);
  assert.equal(state.prefixed, 0);
  assert.deepEqual(lines.map((l) => l.event), ["hlsEdge.revocationListed"]);
});

test("past the page cap the incomplete listing is NOT trusted: unaffected viewers are served, revoked ones still refused, and it is logged", async () => {
  const { lines, log } = recordingLog();
  const gate = new PartyPassRevocationGate({ log });
  // 15 keys at one per page: the namespace needs 15 pages, the cap is 10.
  // `late` is on a page the namespace listing never reaches.
  const keys = Array.from({ length: 14 }, (_, i) => `filler${i}:c9:${ISSUED_AT - 1_000}`);
  keys.push(`late:c1:${ISSUED_AT + 1}`);
  const state = countingKv(keys, 1);

  // Fell back to the per-prefix read, which sees `late`'s key: refused. A
  // truncated index would have said "not revoked".
  assert.deepEqual(await gate.check(state.kv, "late", "c1", ISSUED_AT, T0), { revoked: true, kvError: false });
  // An unrelated viewer is NOT collateral damage of the overflow.
  assert.deepEqual(await gate.check(state.kv, "bystander", "c1", ISSUED_AT, T0), { revoked: false, kvError: false });

  const overflow = lines.filter((l) => l.event === "hlsEdge.revocationNamespaceOverflow");
  assert.equal(overflow.length, 1);
  assert.equal(overflow[0].maxPages, PARTY_PASS_REVOCATION_MAX_LIST_PAGES);
  assert.equal(gate.stats.listingOverflows, 1);
  // The namespace was attempted once for the window (10 pages); everything
  // after that is the old per-prefix read, not a second namespace attempt.
  assert.equal(state.calls - state.prefixed, PARTY_PASS_REVOCATION_MAX_LIST_PAGES);
});

test("past the page cap, a single prefix that is itself past the cap still fails CLOSED, as before", async () => {
  const gate = new PartyPassRevocationGate();
  const keys = Array.from({ length: 12 }, (_, i) => `u1:c1:${ISSUED_AT - 1_000 + i}`);
  const state = countingKv(keys, 1);
  assert.deepEqual(await gate.check(state.kv, "u1", "c1", ISSUED_AT, T0), { revoked: true, kvError: true });
  assert.deepEqual(await gate.check(state.kv, "other", "c1", ISSUED_AT, T0), { revoked: false, kvError: false });
});

test("an overflow is remembered for the window, then the namespace is tried again", async () => {
  const gate = new PartyPassRevocationGate();
  const keys = Array.from({ length: 12 }, (_, i) => `filler${i}:c9:${ISSUED_AT - 1_000}`);
  const state = countingKv(keys, 1);
  await gate.check(state.kv, "a", "c1", ISSUED_AT, T0);
  const afterFirst = state.calls - state.prefixed;
  assert.equal(afterFirst, PARTY_PASS_REVOCATION_MAX_LIST_PAGES);
  await gate.check(state.kv, "b", "c1", ISSUED_AT, T0 + TTL - 1);
  assert.equal(state.calls - state.prefixed, afterFirst); // no second namespace attempt
  // The namespace shrinks (keys expire): next window it is a normal index.
  state.keyNames.length = 3;
  const before = state.calls;
  await gate.check(state.kv, "c", "c1", ISSUED_AT, T0 + TTL);
  assert.equal(state.calls - before, 3);
  // The only prefixed lists were the first window's: three distinct prefixes
  // across its two checks (`a:c1:`, `b:c1:`, and the shared `channel:c1:`).
  assert.equal(state.prefixed, 3);
});

test("the overflow fallback's per-prefix cache is scoped to its binding too", async () => {
  const gate = new PartyPassRevocationGate();
  const filler = Array.from({ length: 12 }, (_, i) => `filler${i}:c9:${ISSUED_AT - 1_000}`);
  const clean = countingKv(filler, 1);
  const revoking = countingKv([...filler, `u1:c1:${ISSUED_AT + 1}`], 1);
  // Both namespaces overflow, so both answer through the per-prefix read.
  assert.equal((await gate.check(clean.kv, "u1", "c1", ISSUED_AT, T0)).revoked, false);
  assert.equal((await gate.check(revoking.kv, "u1", "c1", ISSUED_AT, T0)).revoked, true);
});

// ---------------------------------------------------------------------------
// Visibility of the list rate.
// ---------------------------------------------------------------------------

test("one log line per listing, none per check, and one for a failure", async () => {
  const { lines, log } = recordingLog();
  const gate = new PartyPassRevocationGate({ log });
  const state = countingKv(["a:c1:1", "b:c1:2", "channel:c1:3"], 2);
  for (let i = 0; i < 50; i++) {
    await gate.check(state.kv, `u${i}`, "c1", ISSUED_AT, T0 + i);
  }
  assert.equal(lines.length, 1);
  assert.equal(lines[0].event, "hlsEdge.revocationListed");
  assert.equal(lines[0].keys, 3);
  assert.equal(lines[0].pages, 2);

  const failing = new PartyPassRevocationGate({ log });
  await failing.check({ list: async () => { throw new Error("down"); } }, "u", "c1", ISSUED_AT, T0);
  assert.equal(lines.at(-1).event, "hlsEdge.revocationListFailed");
  assert.equal(gate.stats.listings, 1);
});

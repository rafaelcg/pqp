import { strict as assert } from "node:assert";
import test from "node:test";
import { PartyPassRevocationGate } from "../src/party-pass-revocation.js";

/**
 * DIFFERENTIAL TEST for the namespace-wide revocation listing.
 *
 * `LegacyPartyPassRevocationGate` below is a verbatim copy (renamed, nothing
 * else touched) of the gate as it was on `main` before the change that made
 * the list rate scale with isolates instead of viewers: two PREFIXED
 * `kv.list` calls per viewer-channel pair, each cached per prefix for 30 s.
 * It is test-only and never shipped. The new gate must give the SAME
 * `{ revoked, kvError }` for every input the old one handled, over generated
 * namespaces full of hostile key names, and must do it in a small fraction of
 * the `kv.list` calls. If you change the decision rules on purpose, change
 * the copy on purpose too and say why in the PR.
 */

// ---------------------------------------------------------------------------
// The OLD implementation, copied from origin/main. Do not "fix" it.
// ---------------------------------------------------------------------------

const LEGACY_CACHE_TTL_MS = 30_000;
const LEGACY_CACHE_MAX_ENTRIES = 10_000;

/**
 * One instance per Worker isolate (`index.ts` creates it at module scope,
 * same lifetime as the isolate) -- a class rather than module-level `let`s
 * so a test can hold its own instance instead of racing shared state across
 * `node --test`'s parallel test files.
 */

/**
 * The `revokedAtMs` suffix of an append-only key, given the prefix it was
 * listed under (`<userId>:<channelId>:` or `channel:<channelId>:`) -- 0 for
 * anything that fails to parse as a positive number, so a malformed or
 * unexpected key name can only ever be ignored, never read as a
 * revocation.
 * @param {string} keyName
 * @param {string} prefix
 * @returns {number}
 */
function suffixTimestamp(keyName, prefix) {
  const parsed = Number(keyName.slice(prefix.length));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

class LegacyPartyPassRevocationGate {
  constructor() {
    /** @type {Map<string, { revokedAt: number; at: number }>} */
    this._cache = new Map();
  }

  /**
   * @param {string} cacheKey
   * @returns {{ revokedAt: number; at: number } | undefined}
   */
  _cached(cacheKey, now) {
    const entry = this._cache.get(cacheKey);
    if (entry && now - entry.at < LEGACY_CACHE_TTL_MS) {
      return entry;
    }
    return undefined;
  }

  _remember(cacheKey, revokedAt, now) {
    if (this._cache.size >= LEGACY_CACHE_MAX_ENTRIES) {
      // The cache key space is bounded by real distinct (viewer, channel)
      // pairs and channels, not an attacker-controlled path segment --
      // still, evicting the oldest entry on overflow costs nothing and
      // keeps this from growing without bound across a very long-running
      // isolate.
      const oldestKey = this._cache.keys().next().value;
      if (oldestKey !== undefined) {
        this._cache.delete(oldestKey);
      }
    }
    this._cache.set(cacheKey, { revokedAt, at: now });
  }

  /**
   * The newest revocation timestamp among every key listed under `prefix`,
   * or 0 if there are none -- 0 rather than `null` because every
   * comparison against it is `revokedAt > issuedAt`, and a real `issuedAt`
   * is always a positive epoch millisecond value, so 0 can never itself
   * read as "revoked".
   *
   * FOLLOWS THE CURSOR UNTIL `list_complete`. A single `kv.list` response
   * is one PAGE, not the whole prefix -- Cloudflare's own default page
   * size is 1,000 keys, and stopping at the first page silently drops
   * anything past it. Missing a later page here is not a performance
   * shortfall, it is a security bug: the newest revocation could be on
   * that missing page, and a party pass issued after the (wrongly) visible
   * maximum but before the real one would read as not-revoked (Farol,
   * 2026-09-14). `MAX_LIST_PAGES` bounds total work per check (a real
   * eviction burst for ONE (userId, channelId) pair large enough to need
   * more than a handful of pages inside one 6 h TTL window is not a shape
   * this design expects to see) -- hitting it fails CLOSED via `kvError`,
   * the same direction every other "could not find out for sure" case in
   * this file already fails, rather than silently truncating the answer.
   * @param {{ list(opts: { prefix: string, cursor?: string }): Promise<{ keys: { name: string }[], list_complete?: boolean, cursor?: string }> }} kv
   * @param {string} prefix
   * @param {number} now
   * @returns {Promise<{ revokedAt: number; kvError: boolean }>}
   */
  async _readMaxForPrefix(kv, prefix, now) {
    const cached = this._cached(prefix, now);
    if (cached) {
      return { revokedAt: cached.revokedAt, kvError: false };
    }
    const MAX_LIST_PAGES = 10;
    let revokedAt = 0;
    let cursor;
    try {
      for (let page = 0; page < MAX_LIST_PAGES; page++) {
        const listed = await kv.list(cursor ? { prefix, cursor } : { prefix });
        for (const key of listed?.keys ?? []) {
          const ts = suffixTimestamp(key.name, prefix);
          if (ts > revokedAt) {
            revokedAt = ts;
          }
        }
        if (listed?.list_complete || !listed?.cursor) {
          break;
        }
        if (page === MAX_LIST_PAGES - 1) {
          // Ran out of pages to scan with more still unread -- an
          // incomplete answer is exactly the shape that must never be
          // cached or trusted as "not revoked". Fail CLOSED.
          return { revokedAt: Number.POSITIVE_INFINITY, kvError: true };
        }
        cursor = listed.cursor;
      }
    } catch {
      // Bound but unreachable: fail CLOSED (see the module doc comment).
      // Not cached -- a real outage should not pin every request to
      // "revoked" for the next 30 s once the namespace recovers.
      return { revokedAt: Number.POSITIVE_INFINITY, kvError: true };
    }
    this._remember(prefix, revokedAt, now);
    return { revokedAt, kvError: false };
  }

  /**
   * @param {{ list(opts: { prefix: string }): Promise<{ keys: { name: string }[] }> } | null | undefined} kv
   * @param {string} userId
   * @param {string} channelId
   * @param {number} issuedAt The credential's own `issuedAt` claim.
   * @param {number} [now]
   * @returns {Promise<{ revoked: boolean; kvError: boolean }>}
   */
  async check(kv, userId, channelId, issuedAt, now = Date.now()) {
    if (!kv) {
      return { revoked: false, kvError: false };
    }
    const [user, channel] = await Promise.all([
      this._readMaxForPrefix(kv, `${userId}:${channelId}:`, now),
      this._readMaxForPrefix(kv, `channel:${channelId}:`, now),
    ]);
    if (user.kvError || channel.kvError) {
      return { revoked: true, kvError: true };
    }
    const revokedAt = Math.max(user.revokedAt, channel.revokedAt);
    return { revoked: revokedAt > issuedAt, kvError: false };
  }
}


// ---------------------------------------------------------------------------
// Fakes. `list` takes an OPTIONAL prefix (the new gate lists the whole
// namespace) and follows the real Cloudflare `list_complete` / `cursor` shape.
// ---------------------------------------------------------------------------

/**
 * @param {string[]} keyNames
 * @param {{ pageSize?: number, failOnCall?: number, failAlways?: boolean }} [opts]
 */
function countingKv(keyNames, opts = {}) {
  const pageSize = opts.pageSize ?? 1000;
  const state = { calls: 0, prefixed: 0, unprefixed: 0, keyNames };
  state.kv = {
    async list({ prefix, cursor } = {}) {
      state.calls += 1;
      if (prefix) {
        state.prefixed += 1;
      } else {
        state.unprefixed += 1;
      }
      if (opts.failAlways || (opts.failOnCall && state.calls === opts.failOnCall)) {
        throw new Error("kv unavailable");
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

/** mulberry32, so a failing generated case reproduces from its seed. */
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const BASE = 1_700_000_000_000;

// Ids chosen to be hostile to prefix matching: one a prefix of another, ids
// that contain the separator themselves, the literal word `channel`, empty.
const USERS = ["u1", "u2", "user_abc", "channel", "a", "a:b", "", "u1:x"];
const CHANNELS = ["c1", "c12", "c1:x", "c", "", "chan:2", "b", "b:c"];

// Suffixes the old parser sees: good numbers around BASE, and everything
// `Number()` is lenient or strange about.
const BAD_SUFFIXES = [
  "",
  "abc",
  "-5",
  "0",
  "1e3",
  "1e15",
  "0x10",
  " 12",
  "12 ",
  "12.5",
  "Infinity",
  "-Infinity",
  "NaN",
  "12:34",
  "1_000",
  "++1",
  "0b11",
  "   ",
  "9".repeat(400),
];

function randomKey(rand) {
  const pick = (list) => list[Math.floor(rand() * list.length)];
  const suffix =
    rand() < 0.75
      ? String(BASE + Math.floor((rand() - 0.5) * 4000))
      : pick(BAD_SUFFIXES);
  const shape = rand();
  if (shape < 0.5) {
    return `${pick(USERS)}:${pick(CHANNELS)}:${suffix}`;
  }
  if (shape < 0.8) {
    return `channel:${pick(CHANNELS)}:${suffix}`;
  }
  // Unrelated and malformed names: no colon, one colon, only colons, a
  // prefix with no suffix at all, trailing junk after a valid-looking suffix.
  return pick([
    "foo",
    "channel",
    ":",
    "::",
    ":::",
    "x:",
    `${pick(USERS)}:${pick(CHANNELS)}`,
    `${pick(USERS)}:${pick(CHANNELS)}:${suffix}:extra`,
    `${pick(USERS)}:${pick(CHANNELS)}:${suffix}x`,
    `prefix-${suffix}`,
  ]);
}

const ISSUED_AT_VALUES = [0, BASE - 5000, BASE - 1000, BASE - 1, BASE, BASE + 1, BASE + 1000, BASE + 5000, Number.NaN];

/**
 * Every (user, channel, issuedAt) a query can take, answered by a FRESH old
 * gate and a FRESH new gate over equal copies of the namespace.
 */
async function assertSameDecisions(keyNames, pageSize, label) {
  const legacy = new LegacyPartyPassRevocationGate();
  const next = new PartyPassRevocationGate();
  const legacyKv = countingKv(keyNames, { pageSize }).kv;
  const nextKv = countingKv(keyNames, { pageSize }).kv;
  for (const userId of USERS) {
    for (const channelId of CHANNELS) {
      for (const issuedAt of ISSUED_AT_VALUES) {
        const expected = await legacy.check(legacyKv, userId, channelId, issuedAt, BASE);
        const actual = await next.check(nextKv, userId, channelId, issuedAt, BASE);
        assert.deepEqual(
          actual,
          expected,
          `${label}: user=${JSON.stringify(userId)} channel=${JSON.stringify(channelId)} issuedAt=${issuedAt}\nkeys=${JSON.stringify(keyNames)}`,
        );
      }
    }
  }
}

test("differential: identical decisions to the old per-prefix gate over 400 generated namespaces (unpaged)", async () => {
  for (let seed = 1; seed <= 400; seed++) {
    const rand = rng(seed);
    const count = Math.floor(rand() * 40);
    const keys = Array.from({ length: count }, () => randomKey(rand));
    await assertSameDecisions(keys, 1000, `seed ${seed}`);
  }
});

test("differential: identical decisions when the listing is paged (page sizes 1 to 7), including namespaces past the page cap", async () => {
  for (let seed = 1000; seed < 1150; seed++) {
    const rand = rng(seed);
    // Up to 60 keys at page size 1 is up to 60 pages: well past the cap of
    // 10, so both the namespace listing and some prefixes overflow.
    const count = Math.floor(rand() * 60);
    const keys = Array.from({ length: count }, () => randomKey(rand));
    const pageSize = 1 + Math.floor(rand() * 7);
    await assertSameDecisions(keys, pageSize, `seed ${seed} pageSize ${pageSize}`);
  }
});

test("differential: a hand-written set of the nastiest names", async () => {
  const keys = [
    // userId "a:b" + channel "c" and userId "a" + channel "b:c" share the
    // prefix "a:b:c:" -- the old startsWith treats them as one.
    `a:b:c:${BASE + 10}`,
    `a:b:c:${BASE - 10}`,
    // "channel" as a user id collides with the channel-wide prefix.
    `channel:c1:${BASE + 20}`,
    // prefix-of-a-prefix ids
    `u1:c12:${BASE + 30}`,
    // no suffix, junk suffix, a suffix with a trailing colon
    `u2:c1:`,
    `u2:c1:abc`,
    `u2:c1:${BASE + 40}:`,
    // keys that are not revocations at all
    "foo",
    "channel",
    "",
    ":",
  ];
  await assertSameDecisions(keys, 1000, "nasty");
  await assertSameDecisions(keys, 2, "nasty paged");
});

test("differential: the same failures. Unbound, always throwing, throwing on a later page", async () => {
  const keys = Array.from({ length: 6 }, (_, i) => `u1:c1:${BASE + i}`);
  for (const issuedAt of [BASE - 1, BASE + 100]) {
    // Unbound.
    for (const kv of [undefined, null]) {
      assert.deepEqual(
        await new PartyPassRevocationGate().check(kv, "u1", "c1", issuedAt, BASE),
        await new LegacyPartyPassRevocationGate().check(kv, "u1", "c1", issuedAt, BASE),
      );
    }
    // Always throws.
    assert.deepEqual(
      await new PartyPassRevocationGate().check(countingKv(keys, { failAlways: true }).kv, "u1", "c1", issuedAt, BASE),
      await new LegacyPartyPassRevocationGate().check(countingKv(keys, { failAlways: true }).kv, "u1", "c1", issuedAt, BASE),
    );
    // Throws on the second page of the listing.
    assert.deepEqual(
      await new PartyPassRevocationGate().check(
        countingKv(keys, { pageSize: 2, failOnCall: 2 }).kv,
        "u1",
        "c1",
        issuedAt,
        BASE,
      ),
      { revoked: true, kvError: true },
    );
    // A `list` that returns nothing usable.
    const weird = { async list() { return undefined; } };
    assert.deepEqual(
      await new PartyPassRevocationGate().check(weird, "u1", "c1", issuedAt, BASE),
      await new LegacyPartyPassRevocationGate().check(weird, "u1", "c1", issuedAt, BASE),
    );
  }
});

// ---------------------------------------------------------------------------
// Cost: the whole reason for the change. Counted on a fake KV, old vs new.
// ---------------------------------------------------------------------------

function viewerPopulation(viewers, channels) {
  return Array.from({ length: viewers }, (_, i) => ({
    userId: `user_${String(i).padStart(4, "0")}`,
    channelId: `channel-${i % channels}`,
  }));
}

async function runWindow(gate, kv, population, now) {
  for (const { userId, channelId } of population) {
    await gate.check(kv, userId, channelId, BASE, now);
  }
}

test("cost: 200 distinct viewers across 3 channels in one 30 s window, old vs new", async () => {
  const keys = [`user_0007:channel-1:${BASE + 1}`, `channel:channel-2:${BASE - 9}`];
  const population = viewerPopulation(200, 3);

  const legacyKv = countingKv(keys);
  await runWindow(new LegacyPartyPassRevocationGate(), legacyKv.kv, population, BASE);
  const nextKv = countingKv(keys);
  await runWindow(new PartyPassRevocationGate(), nextKv.kv, population, BASE + 29_999);

  // Old: one user-prefix list per viewer (200) plus one channel-prefix list
  // per channel (3).
  assert.equal(legacyKv.calls, 203);
  // New: one namespace listing, whatever the audience.
  assert.equal(nextKv.calls, 1);
  assert.equal(nextKv.prefixed, 0);
  console.log(`# list calls, 200 viewers x 3 channels, one window: old ${legacyKv.calls}, new ${nextKv.calls}`);
});

test("cost: 200 viewers each polling all 3 channels (600 viewer-channel pairs), old vs new", async () => {
  const population = viewerPopulation(200, 3).flatMap(({ userId }) =>
    ["channel-0", "channel-1", "channel-2"].map((channelId) => ({ userId, channelId })),
  );
  const legacyKv = countingKv([]);
  await runWindow(new LegacyPartyPassRevocationGate(), legacyKv.kv, population, BASE);
  const nextKv = countingKv([]);
  await runWindow(new PartyPassRevocationGate(), nextKv.kv, population, BASE);
  assert.equal(legacyKv.calls, 603);
  assert.equal(nextKv.calls, 1);
  console.log(`# list calls, 600 viewer-channel pairs, one window: old ${legacyKv.calls}, new ${nextKv.calls}`);
});

test("cost: a 5 minute party (10 windows) with 200 viewers is 10 listings, not 2,030 lists", async () => {
  const population = viewerPopulation(200, 3);
  const legacyKv = countingKv([]);
  const legacy = new LegacyPartyPassRevocationGate();
  const nextKv = countingKv([]);
  const next = new PartyPassRevocationGate();
  for (let window = 0; window < 10; window++) {
    const now = BASE + window * 30_000;
    await runWindow(legacy, legacyKv.kv, population, now);
    await runWindow(next, nextKv.kv, population, now);
  }
  assert.equal(legacyKv.calls, 2030);
  assert.equal(nextKv.calls, 10);
});

test("cost: the same answers while paying for that, per viewer, in the same windows", async () => {
  const keys = [`user_0003:channel-0:${BASE + 5}`, `channel:channel-1:${BASE + 5}`];
  const population = viewerPopulation(60, 3);
  const legacy = new LegacyPartyPassRevocationGate();
  const next = new PartyPassRevocationGate();
  const legacyKv = countingKv(keys).kv;
  const nextKv = countingKv(keys).kv;
  for (const { userId, channelId } of population) {
    assert.deepEqual(
      await next.check(nextKv, userId, channelId, BASE, BASE),
      await legacy.check(legacyKv, userId, channelId, BASE, BASE),
    );
  }
});

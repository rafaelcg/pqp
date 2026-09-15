import { strict as assert } from "node:assert";
import test from "node:test";
import { MAX_JOIN_ATTEMPTS, coalesceFetch } from "../src/coalesced-fetch.js";

/**
 * A timer nothing fires but this test. `setTimer` never touches the real
 * event loop, so a "bound" in these tests elapses exactly when the test says
 * it does and never a millisecond earlier -- which is the only way to pin
 * "one waiter's deadline fired and the OTHER one still got the origin's
 * answer" deterministically.
 */
function makeTimers() {
  /** @type {Set<{ ms: number, cb: () => void }>} */
  const armed = new Set();
  return {
    setTimer: (ms, cb) => {
      const entry = { ms, cb };
      armed.add(entry);
      return () => armed.delete(entry);
    },
    get pending() {
      return armed.size;
    },
    /** Fires every currently-armed timer, oldest first. */
    fireAll() {
      for (const entry of [...armed]) {
        armed.delete(entry);
        entry.cb();
      }
    },
    /** Fires exactly one (the oldest) -- "this caller's deadline, not that one's". */
    fireOne() {
      const [entry] = armed;
      armed.delete(entry);
      entry.cb();
    },
  };
}

/** Lets every already-scheduled microtask and promise callback run. */
async function flush(turns = 8) {
  for (let i = 0; i < turns; i += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

/** A promise plus the handles to settle it later, the shape a "still in flight" origin fetch needs. */
function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  // Never left unhandled: every test that rejects one of these has a
  // consumer, but a detached joiner is exactly the case where nobody is
  // listening any more, which is an unhandled rejection in Node and an
  // isolate-level error in Workers.
  promise.catch(() => {});
  return { promise, resolve, reject };
}

/**
 * `{ v }` / `{ e }` when `promise` has settled within a few event-loop turns,
 * `null` when it is still pending — the assertion "this request answered"
 * without the test hanging forever when it does not.
 */
async function settled(promise) {
  let outcome = null;
  promise.then(
    (v) => {
      outcome = { v };
    },
    (e) => {
      outcome = { e };
    },
  );
  await flush();
  return outcome;
}

test("coalesceFetch: concurrent callers for one key share a single produce(), and every one of them settles", async () => {
  /** @type {Map<string, Promise<string>>} */
  const inFlight = new Map();
  const timers = makeTimers();
  let produced = 0;
  const produce = async () => {
    produced += 1;
    await flush(1);
    return "playlist-body";
  };

  // The shape a synchronized 2 s cache expiry takes: N viewers observe the
  // miss in the same few milliseconds.
  const results = await Promise.all(
    Array.from({ length: 12 }, () => coalesceFetch(inFlight, "rung", produce, { setTimer: timers.setTimer })),
  );

  assert.equal(produced, 1, "twelve concurrent callers must cost exactly one origin fetch");
  assert.equal(results.filter((r) => r.isProducer).length, 1, "exactly one cache writer");
  for (const result of results) {
    assert.equal(result.result, "playlist-body");
  }
  assert.equal(inFlight.size, 0, "the in-flight entry is released once the fetch settles");
  assert.equal(timers.pending, 0, "no join bound is left armed behind a settled request");
});

test("coalesceFetch: a joiner whose bound fires first detaches and fetches for itself -- it never aborts the shared fetch", async () => {
  /** @type {Map<string, Promise<string>>} */
  const inFlight = new Map();
  const timers = makeTimers();
  const slow = deferred();
  let produced = 0;
  const produce = () => {
    produced += 1;
    return produced === 1 ? slow.promise : Promise.resolve("own-fetch");
  };

  const producer = coalesceFetch(inFlight, "rung", produce, { setTimer: timers.setTimer });
  await flush(1);
  const joiner = coalesceFetch(inFlight, "rung", produce, { setTimer: timers.setTimer });
  await flush(1);

  assert.equal(timers.pending, 1, "only the JOINER arms a bound; the producer awaits its own fetch");

  // The joiner's own deadline passes while the shared fetch is still running.
  timers.fireOne();
  await flush();

  assert.deepEqual(await settled(joiner), { v: { result: "own-fetch", isProducer: true } });
  assert.equal(produced, 2, "the detached joiner produced its own fetch rather than inheriting a dead one");

  // THE POINT OF THE TEST: the shared fetch was never cancelled by the
  // joiner giving up, so the caller still attached to it gets the origin's
  // real answer -- no AbortError, no 502.
  //
  // It does NOT get `isProducer`, though: it is no longer the current fetch
  // for this key, and letting it write the cache would overwrite the newer
  // playlist its replacement already stored with an older snapshot, for the
  // rest of the cache TTL (Farol, PR #645).
  slow.resolve("shared-body");
  assert.deepEqual(await settled(producer), { v: { result: "shared-body", isProducer: false } });
});

test("coalesceFetch: a superseded fetch that finishes late is not a cache writer", async () => {
  /** @type {Map<string, Promise<string>>} */
  const inFlight = new Map();
  const timers = makeTimers();
  const slow = deferred();
  let produced = 0;
  const produce = () => {
    produced += 1;
    return produced === 1 ? slow.promise : Promise.resolve("newer-playlist");
  };

  const superseded = coalesceFetch(inFlight, "rung", produce, { setTimer: timers.setTimer });
  await flush(1);
  const joiner = coalesceFetch(inFlight, "rung", produce, { setTimer: timers.setTimer });
  await flush(1);
  timers.fireOne();
  await flush();

  const replacement = await settled(joiner);
  assert.equal(replacement.v.isProducer, true, "the current fetch writes the cache");

  // Only NOW does the older one finish, with an older live edge behind it.
  slow.resolve("older-playlist");
  const late = await settled(superseded);
  assert.equal(late.v.result, "older-playlist", "its own caller still gets an answer");
  assert.equal(late.v.isProducer, false, "but it must not overwrite the newer entry");
});

test("coalesceFetch: joiners that all detach in the same instant elect ONE producer, not one each", async () => {
  // Farol, PR #645: an earlier draft produced unconditionally after the join
  // loop, so a fetch stalled past the bound turned into one retry per waiter
  // -- the exact fan-in this Worker exists to collapse.
  /** @type {Map<string, Promise<string>>} */
  const inFlight = new Map();
  const timers = makeTimers();
  const stalled = deferred();
  let produced = 0;
  const produce = () => {
    produced += 1;
    return produced === 1 ? stalled.promise : Promise.resolve("retry-body");
  };

  const producer = coalesceFetch(inFlight, "rung", produce, { setTimer: timers.setTimer });
  await flush(1);
  const joiners = Array.from({ length: 25 }, () =>
    coalesceFetch(inFlight, "rung", produce, { setTimer: timers.setTimer }),
  );
  await flush(1);
  assert.equal(timers.pending, 25, "every joiner arms its own bound");

  // Every one of their bounds fires at once, which is what a stalled origin
  // and a synchronized poll cadence actually produce.
  timers.fireAll();
  await flush();

  for (const joiner of joiners) {
    assert.equal((await settled(joiner)).v.result, "retry-body");
  }
  assert.equal(produced, 2, "one stalled fetch plus exactly one retry, for twenty-five waiters");

  const producers = [];
  for (const joiner of joiners) {
    producers.push((await settled(joiner)).v.isProducer);
  }
  assert.equal(producers.filter(Boolean).length, 1, "exactly one of the twenty-five writes the cache");

  stalled.resolve("eventually");
  assert.equal((await settled(producer)).v.isProducer, false);
});

test("coalesceFetch: a shared fetch that dies with its owner's request context does not fail the joiner", async () => {
  // The production failure of 2026-09-15, 19:55:44-19:55:54: five blocking
  // reloads answered 502 while every origin request in the window was a 200
  // in about a millisecond. The fetch was not refused -- it was cancelled,
  // with the context of the request that started it.
  /** @type {Map<string, Promise<string>>} */
  const inFlight = new Map();
  const timers = makeTimers();
  const owned = deferred();
  let produced = 0;
  const produce = () => {
    produced += 1;
    return produced === 1 ? owned.promise : Promise.resolve("origin-200");
  };

  const producer = coalesceFetch(inFlight, "rung", produce, { setTimer: timers.setTimer });
  producer.catch(() => {});
  await flush(1);
  const joiner = coalesceFetch(inFlight, "rung", produce, { setTimer: timers.setTimer });
  await flush(1);

  const abortError = new Error("The operation was aborted");
  abortError.name = "AbortError";
  owned.reject(abortError);
  await flush();

  const outcome = await settled(joiner);
  assert.ok(outcome && "v" in outcome, "the joiner must not inherit the owner's abort");
  assert.equal(outcome.v.result, "origin-200");
  assert.equal(produced, 2);
});

test("coalesceFetch: many joiners of a dead fetch collapse onto ONE retry, not one retry each", async () => {
  /** @type {Map<string, Promise<string>>} */
  const inFlight = new Map();
  const timers = makeTimers();
  const owned = deferred();
  let produced = 0;
  const produce = () => {
    produced += 1;
    return produced === 1 ? owned.promise : Promise.resolve("retry-body");
  };

  const producer = coalesceFetch(inFlight, "rung", produce, { setTimer: timers.setTimer });
  producer.catch(() => {});
  await flush(1);
  const joiners = Array.from({ length: 6 }, () =>
    coalesceFetch(inFlight, "rung", produce, { setTimer: timers.setTimer }),
  );
  await flush(1);

  owned.reject(new Error("context gone"));
  await flush();

  for (const joiner of joiners) {
    assert.deepEqual((await settled(joiner)).v.result, "retry-body");
  }
  assert.equal(produced, 2, "one dead fetch plus exactly one retry -- never a herd on a sick origin");
});

test("coalesceFetch: detach reasons are reported, so a dashboard can see this happening at all", async () => {
  /** @type {Map<string, Promise<string>>} */
  const inFlight = new Map();
  const timers = makeTimers();
  const slow = deferred();
  const produce = () => (inFlight.size === 0 ? slow.promise : Promise.resolve("own"));

  const producer = coalesceFetch(inFlight, "rung", () => slow.promise, { setTimer: timers.setTimer });
  await flush(1);
  /** @type {Array<{ reason: string, attempt: number }>} */
  const detaches = [];
  const joiner = coalesceFetch(inFlight, "rung", produce, {
    setTimer: timers.setTimer,
    onDetach: (info) => detaches.push(info),
  });
  await flush(1);
  timers.fireOne();
  await flush();

  assert.deepEqual(detaches, [{ reason: "detached", attempt: 0 }]);
  slow.resolve("shared");
  await settled(producer);
  await settled(joiner);
});

test("coalesceFetch: a caller's total wait is bounded by MAX_JOIN_ATTEMPTS bounds, then it goes to the origin itself", async () => {
  /** @type {Map<string, Promise<string>>} */
  const inFlight = new Map();
  const timers = makeTimers();
  const stalled = deferred();
  let produced = 0;
  const produce = () => {
    produced += 1;
    return produced === 1 ? stalled.promise : Promise.resolve("finally-mine");
  };

  const producer = coalesceFetch(inFlight, "rung", produce, { setTimer: timers.setTimer });
  await flush(1);
  const joiner = coalesceFetch(inFlight, "rung", produce, { setTimer: timers.setTimer });
  await flush(1);

  // Every bound this caller is willing to wait through, one after another.
  for (let i = 0; i < MAX_JOIN_ATTEMPTS; i += 1) {
    if (timers.pending > 0) {
      timers.fireOne();
      await flush();
    }
  }

  assert.deepEqual((await settled(joiner)).v.result, "finally-mine");
  stalled.resolve("eventually");
  await settled(producer);
});

test("coalesceFetch: keepAlive is handed the producer's settled promise, which is what ctx.waitUntil needs", async () => {
  /** @type {Map<string, Promise<string>>} */
  const inFlight = new Map();
  const timers = makeTimers();
  /** @type {Promise<unknown>[]} */
  const kept = [];
  const result = await coalesceFetch(inFlight, "rung", async () => "body", {
    setTimer: timers.setTimer,
    keepAlive: (promise) => kept.push(promise),
  });

  assert.equal(result.result, "body");
  assert.equal(kept.length, 1, "the producing request must be able to extend its own context past its response");
  await kept[0];
  assert.equal(inFlight.size, 0);
});

test("coalesceFetch: a produce() that throws synchronously rejects its caller rather than poisoning the map", async () => {
  /** @type {Map<string, Promise<string>>} */
  const inFlight = new Map();
  await assert.rejects(
    () =>
      coalesceFetch(inFlight, "rung", () => {
        throw new Error("origin unreachable");
      }),
    /origin unreachable/,
  );
  assert.equal(inFlight.size, 0, "a key nobody is fetching must not be left claimed");
});

/**
 * When a scene happens, and who is in it.
 *
 * Every function here is pure: the clock, the randomness and the rate-limit
 * ledger are all arguments. That is what makes "does the server go quiet at
 * 3am" a unit test instead of an overnight observation, and it is the reason
 * this file has no imports.
 */

/** Minutes since local midnight, and which day it is, in a named zone. */
export function localClock(date, timeZone) {
  // Intl rather than a UTC offset: São Paulo has dropped DST, but the runner
  // is meant to survive a community in a zone that has not, and an offset
  // baked in at boot is exactly the bug that shows up twice a year.
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour12: false,
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
  }).formatToParts(date);
  const at = (type) => parts.find((p) => p.type === type)?.value ?? "";
  // "24" is what Intl reports for midnight under hour12:false in some ICU
  // builds. Left unhandled it puts midnight at minute 1440, outside every
  // window, and the server goes silent for exactly one minute a day.
  const hour = Number(at("hour")) % 24;
  const minute = Number(at("minute"));
  const weekday = at("weekday");
  return {
    minutes: hour * 60 + minute,
    weekday,
    weekend: weekday === "Sat" || weekday === "Sun",
  };
}

/** "07:15-08:40" → { start: 435, end: 520 }. Throws on anything else. */
export function parseWindow(spec) {
  const match = /^(\d{2}):(\d{2})-(\d{2}):(\d{2})$/.exec(String(spec).trim());
  if (!match) {
    throw new Error(`Bad activity window: ${spec} (want "HH:MM-HH:MM")`);
  }
  const start = Number(match[1]) * 60 + Number(match[2]);
  const end = Number(match[3]) * 60 + Number(match[4]);
  if (start >= end) {
    // A window that wraps midnight would silently match nothing with the
    // comparison below, so refuse it rather than produce a persona that never
    // speaks. Split it into two windows instead.
    throw new Error(`Activity window must not wrap midnight: ${spec}`);
  }
  return { start, end };
}

/**
 * How present a persona is right now, 0..1.
 *
 * Not a boolean, because a boolean produces a server that switches on at
 * 19:30 sharp and off at 23:15 sharp — five personas all appearing on the same
 * minute is the single most obviously synthetic thing a system like this can
 * do. The ramp gives each window a soft edge, so activity builds and fades.
 */
export function windowIntensity(minutes, windows) {
  let best = 0;
  for (const window of windows) {
    const { start, end } = parseWindow(window);
    if (minutes < start || minutes > end) {
      continue;
    }
    const span = end - start;
    // Triangular: 0 at both edges, 1 in the middle, clamped so a one-minute
    // window is not a division by zero.
    const position = span === 0 ? 1 : (minutes - start) / span;
    best = Math.max(best, 1 - Math.abs(0.5 - position) * 2);
  }
  return best;
}

/** The weight a persona carries when a scene is being cast. Zero means asleep. */
export function personaWeight(persona, now, timeZone) {
  const clock = localClock(now, timeZone);
  const windows = clock.weekend
    ? persona.activity.weekend
    : persona.activity.weekday;
  const intensity = windowIntensity(clock.minutes, windows ?? []);
  return intensity * (persona.chattiness ?? 0.5);
}

/**
 * Jitter a duration by ±`spread`, as a fraction.
 *
 * `rng` is injected so a test can pin it. Every schedule decision in this file
 * runs through here — a fixed cadence is the other most obviously synthetic
 * thing a system like this can do.
 */
export function jitter(baseMs, spread, rng = Math.random) {
  const factor = 1 + (rng() * 2 - 1) * spread;
  return Math.max(0, Math.round(baseMs * factor));
}

/**
 * How long until the next scene should be attempted.
 *
 * Inversely proportional to how awake the room is: a lively evening produces
 * scenes every few minutes, a dead Tuesday morning every hour or so. The
 * scheduler still wakes up on a fixed tick — this only decides whether the
 * tick does anything.
 */
export function nextSceneDelayMs({
  activeWeight,
  baseIntervalMs = 20 * 60_000,
  minIntervalMs = 4 * 60_000,
  maxIntervalMs = 90 * 60_000,
  rng = Math.random,
}) {
  if (activeWeight <= 0) {
    // Nobody is around. Come back in a while rather than spinning.
    return jitter(maxIntervalMs, 0.2, rng);
  }
  const scaled = baseIntervalMs / Math.min(activeWeight, 3);
  const clamped = Math.min(maxIntervalMs, Math.max(minIntervalMs, scaled));
  return jitter(clamped, 0.35, rng);
}

/**
 * A sliding-window counter, keyed by whatever the caller wants to cap.
 *
 * Deliberately not a token bucket: the question this answers is "how many
 * messages has this persona posted in the last hour", which is what a human
 * reading the channel perceives, and a bucket's refill smears that out.
 */
export class RateCap {
  #events = new Map();

  /** How many events are inside the window for `key`, as of `now`. */
  count(key, now, windowMs = 3_600_000) {
    const list = this.#events.get(key);
    if (!list) {
      return 0;
    }
    const cutoff = now - windowMs;
    // Prune while counting; the list is append-ordered so a shift-scan is fine.
    while (list.length > 0 && list[0] <= cutoff) {
      list.shift();
    }
    return list.length;
  }

  allow(key, limit, now, windowMs = 3_600_000) {
    return this.count(key, now, windowMs) < limit;
  }

  record(key, now) {
    const list = this.#events.get(key);
    if (list) {
      list.push(now);
    } else {
      this.#events.set(key, [now]);
    }
  }

  /** Test/observability helper: every key currently holding events. */
  keys() {
    return [...this.#events.keys()];
  }
}

/** Weighted pick without replacement. Pure given `rng`. */
export function weightedSample(candidates, count, rng = Math.random) {
  const pool = candidates.filter((c) => c.weight > 0).map((c) => ({ ...c }));
  const picked = [];
  while (picked.length < count && pool.length > 0) {
    const total = pool.reduce((sum, c) => sum + c.weight, 0);
    let target = rng() * total;
    let index = pool.length - 1;
    for (let i = 0; i < pool.length; i++) {
      target -= pool[i].weight;
      if (target <= 0) {
        index = i;
        break;
      }
    }
    picked.push(pool[index].value);
    pool.splice(index, 1);
  }
  return picked;
}

/**
 * Cast a scene: pick the personas, the topic, and how many lines.
 *
 * Returns null when the scene should not happen at all — outside everyone's
 * windows, over a rate cap, or too few people awake to hold a conversation.
 * A null here is the normal case for most of the day, not an error.
 */
export function planScene({
  config,
  now,
  rateCap,
  recentTopics = [],
  rng = Math.random,
}) {
  const timeZone = config.timezone;
  const serverKey = `server:${config.community.key}`;
  const serverLimit = config.limits.maxMessagesPerHourPerServer;
  const [minLines, maxLines] = config.limits.sceneLines;

  const nowMs = now.getTime();
  if (!rateCap.allow(serverKey, serverLimit, nowMs)) {
    return null;
  }
  // Headroom, not just permission: starting a five-line scene with two
  // messages left in the hour publishes half a conversation.
  const headroom = serverLimit - rateCap.count(serverKey, nowMs);
  if (headroom < minLines) {
    return null;
  }

  const candidates = config.personas
    .map((persona) => ({
      value: persona,
      weight: personaWeight(persona, now, timeZone),
    }))
    .filter(
      (c) =>
        c.weight > 0 &&
        rateCap.allow(
          `persona:${c.value.id}`,
          c.value.maxMessagesPerHour ?? config.defaults.maxMessagesPerHour,
          nowMs,
        ),
    );

  // Two is the floor: one persona talking to an empty room is a broadcast, and
  // a broadcast is what makes a seeded server read as marketing.
  if (candidates.length < 2) {
    return null;
  }

  const wanted = Math.min(candidates.length, 2 + Math.floor(rng() * 3));
  const cast = weightedSample(candidates, wanted, rng);

  const fresh = config.community.topics.filter((t) => !recentTopics.includes(t));
  const topicPool = fresh.length > 0 ? fresh : config.community.topics;
  const topic = topicPool[Math.floor(rng() * topicPool.length)];

  const lines = Math.min(
    headroom,
    minLines + Math.floor(rng() * (maxLines - minLines + 1)),
  );

  return { cast, topic, lines };
}

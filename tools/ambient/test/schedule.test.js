import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  localClock,
  parseWindow,
  windowIntensity,
  personaWeight,
  jitter,
  nextSceneDelayMs,
  RateCap,
  weightedSample,
  planScene,
} from "../src/schedule.js";

const SP = "America/Sao_Paulo";

/** A deterministic rng that walks a fixed list, so every pick is pinned. */
function seq(values) {
  let i = 0;
  return () => values[i++ % values.length];
}

describe("localClock", () => {
  test("resolves wall-clock in the configured zone, not UTC", () => {
    // 2026-08-08T12:00Z is 09:00 in São Paulo (UTC-3, no DST since 2019).
    const clock = localClock(new Date("2026-08-08T12:00:00Z"), SP);
    assert.equal(clock.minutes, 9 * 60);
    assert.equal(clock.weekday, "Sat");
    assert.equal(clock.weekend, true);
  });

  test("a UTC day and a São Paulo day can disagree", () => {
    // 01:30Z Monday is still 22:30 Sunday locally — the difference between a
    // weekday evening schedule and a weekend one.
    const clock = localClock(new Date("2026-08-10T01:30:00Z"), SP);
    assert.equal(clock.weekday, "Sun");
    assert.equal(clock.weekend, true);
    assert.equal(clock.minutes, 22 * 60 + 30);
  });

  test("local midnight is minute 0, not minute 1440", () => {
    // Regression: some ICU builds report hour "24" for midnight under
    // hour12:false, which lands outside every window and silences the server
    // for exactly one minute a day.
    const clock = localClock(new Date("2026-08-08T03:00:00Z"), SP);
    assert.equal(clock.minutes, 0);
  });
});

describe("parseWindow", () => {
  test("parses HH:MM-HH:MM into minutes", () => {
    assert.deepEqual(parseWindow("07:15-08:40"), { start: 435, end: 520 });
  });

  test("refuses a window that wraps midnight instead of matching nothing", () => {
    assert.throws(() => parseWindow("22:00-02:00"), /wrap midnight/);
  });

  test("refuses malformed input", () => {
    assert.throws(() => parseWindow("7:15-8:40"), /Bad activity window/);
    assert.throws(() => parseWindow("evening"), /Bad activity window/);
  });
});

describe("windowIntensity", () => {
  const windows = ["20:00-23:00"];

  test("is zero outside every window", () => {
    assert.equal(windowIntensity(9 * 60, windows), 0);
    assert.equal(windowIntensity(23 * 60 + 30, windows), 0);
  });

  test("peaks at the middle of the window", () => {
    assert.equal(windowIntensity(21 * 60 + 30, windows), 1);
  });

  test("ramps rather than switching on at the edge", () => {
    // The whole point: five personas must not all appear on the same minute.
    const atEdge = windowIntensity(20 * 60, windows);
    const justInside = windowIntensity(20 * 60 + 30, windows);
    const later = windowIntensity(21 * 60, windows);
    assert.equal(atEdge, 0);
    assert.ok(justInside > atEdge);
    assert.ok(later > justInside);
  });

  test("takes the best of overlapping windows", () => {
    const overlapping = ["12:00-13:00", "12:30-14:30"];
    assert.ok(windowIntensity(13 * 60 + 30, overlapping) > 0);
  });
});

describe("personaWeight", () => {
  const persona = {
    id: "cacau",
    chattiness: 0.8,
    activity: {
      weekday: ["19:30-23:00"],
      weekend: ["10:00-13:00"],
    },
  };

  test("is zero when the persona is asleep", () => {
    // 08:00Z Monday = 05:00 in São Paulo.
    assert.equal(personaWeight(persona, new Date("2026-08-10T08:00:00Z"), SP), 0);
  });

  test("scales the window ramp by chattiness", () => {
    // 00:15Z Tuesday = 21:15 Monday local, the middle of the weekday window.
    const weight = personaWeight(persona, new Date("2026-08-11T00:15:00Z"), SP);
    assert.ok(weight > 0.79 && weight <= 0.8, `got ${weight}`);
  });

  test("uses the weekend windows on a weekend", () => {
    // Saturday 14:30Z = 11:30 local: inside the weekend window, and outside
    // the weekday one. Getting this backwards is the bug this pins.
    const weekend = personaWeight(persona, new Date("2026-08-08T14:30:00Z"), SP);
    assert.ok(weekend > 0);
    const weekdaySameTime = personaWeight(
      persona,
      new Date("2026-08-10T14:30:00Z"),
      SP,
    );
    assert.equal(weekdaySameTime, 0);
  });
});

describe("jitter", () => {
  test("is the base value when rng lands in the middle", () => {
    assert.equal(jitter(1000, 0.5, () => 0.5), 1000);
  });

  test("spans the full spread at the extremes", () => {
    assert.equal(jitter(1000, 0.5, () => 0), 500);
    assert.equal(jitter(1000, 0.5, () => 1), 1500);
  });

  test("never goes negative", () => {
    assert.equal(jitter(100, 5, () => 0), 0);
  });
});

describe("nextSceneDelayMs", () => {
  test("waits a long time when nobody is around", () => {
    const delay = nextSceneDelayMs({ activeWeight: 0, rng: () => 0.5 });
    assert.equal(delay, 90 * 60_000);
  });

  test("shortens as the room gets livelier", () => {
    const quiet = nextSceneDelayMs({ activeWeight: 0.3, rng: () => 0.5 });
    const busy = nextSceneDelayMs({ activeWeight: 2.5, rng: () => 0.5 });
    assert.ok(busy < quiet, `${busy} should be under ${quiet}`);
  });

  test("saturates so a very lively room still is not a firehose", () => {
    // The weight divisor is capped at 3, so at the default 20-minute base the
    // fastest the room can ever go is one scene per ~6.7 minutes — no amount
    // of activity turns the channel into a stream.
    const delay = nextSceneDelayMs({ activeWeight: 99, rng: () => 0.5 });
    assert.equal(delay, Math.round((20 * 60_000) / 3));
  });

  test("the floor still applies when a caller configures a short base", () => {
    const delay = nextSceneDelayMs({
      activeWeight: 3,
      baseIntervalMs: 60_000,
      rng: () => 0.5,
    });
    assert.equal(delay, 4 * 60_000);
  });
});

describe("RateCap", () => {
  test("counts only inside the window", () => {
    const cap = new RateCap();
    const t0 = 1_000_000;
    cap.record("a", t0);
    cap.record("a", t0 + 60_000);
    assert.equal(cap.count("a", t0 + 120_000), 2);
    // Two hours later the first two have aged out entirely.
    assert.equal(cap.count("a", t0 + 2 * 3_600_000), 0);
  });

  test("allow() flips exactly at the limit", () => {
    const cap = new RateCap();
    const now = 5_000_000;
    cap.record("p", now);
    cap.record("p", now);
    assert.equal(cap.allow("p", 3, now), true);
    cap.record("p", now);
    assert.equal(cap.allow("p", 3, now), false);
    // And recovers once the window slides past them.
    assert.equal(cap.allow("p", 3, now + 3_600_001), true);
  });

  test("keys are independent", () => {
    const cap = new RateCap();
    cap.record("a", 1);
    assert.equal(cap.count("b", 1), 0);
  });
});

describe("weightedSample", () => {
  test("never picks a zero-weight candidate", () => {
    const picked = weightedSample(
      [
        { value: "asleep", weight: 0 },
        { value: "awake", weight: 1 },
      ],
      2,
      seq([0.5]),
    );
    assert.deepEqual(picked, ["awake"]);
  });

  test("samples without replacement", () => {
    const picked = weightedSample(
      [
        { value: "a", weight: 1 },
        { value: "b", weight: 1 },
        { value: "c", weight: 1 },
      ],
      3,
      seq([0.1, 0.9, 0.5]),
    );
    assert.equal(new Set(picked).size, 3);
  });
});

describe("planScene", () => {
  const config = {
    timezone: SP,
    community: {
      key: "test",
      topics: ["assunto a", "assunto b", "assunto c"],
    },
    defaults: { maxMessagesPerHour: 6 },
    limits: { maxMessagesPerHourPerServer: 12, sceneLines: [3, 5] },
    personas: [
      {
        id: "a",
        chattiness: 1,
        maxMessagesPerHour: 6,
        activity: { weekday: ["19:00-23:00"], weekend: ["10:00-22:00"] },
      },
      {
        id: "b",
        chattiness: 1,
        maxMessagesPerHour: 6,
        activity: { weekday: ["19:00-23:00"], weekend: ["10:00-22:00"] },
      },
      {
        id: "c",
        chattiness: 1,
        maxMessagesPerHour: 1,
        activity: { weekday: ["19:00-23:00"], weekend: ["10:00-22:00"] },
      },
    ],
  };
  // 00:00Z Tuesday = 21:00 Monday local, mid-window for all three.
  const evening = new Date("2026-08-11T00:00:00Z");
  const dawn = new Date("2026-08-11T08:00:00Z"); // 05:00 local

  test("declines when everyone is asleep", () => {
    assert.equal(
      planScene({ config, now: dawn, rateCap: new RateCap(), rng: () => 0.5 }),
      null,
    );
  });

  test("casts at least two personas, never one", () => {
    const plan = planScene({
      config,
      now: evening,
      rateCap: new RateCap(),
      rng: seq([0.5, 0.1, 0.1, 0.1, 0.1]),
    });
    assert.ok(plan);
    assert.ok(plan.cast.length >= 2, `cast was ${plan.cast.length}`);
    assert.equal(new Set(plan.cast.map((p) => p.id)).size, plan.cast.length);
  });

  test("declines when the server's hourly cap is spent", () => {
    const rateCap = new RateCap();
    const now = evening.getTime();
    for (let i = 0; i < 12; i++) {
      rateCap.record("server:test", now);
    }
    assert.equal(planScene({ config, now: evening, rateCap, rng: () => 0.5 }), null);
  });

  test("declines when there is not room for a whole scene", () => {
    // 10 of 12 spent leaves 2, under the 3-line minimum: starting here would
    // publish half a conversation and stop mid-exchange.
    const rateCap = new RateCap();
    const now = evening.getTime();
    for (let i = 0; i < 10; i++) {
      rateCap.record("server:test", now);
    }
    assert.equal(planScene({ config, now: evening, rateCap, rng: () => 0.5 }), null);
  });

  test("drops a persona that has spent its own hourly cap", () => {
    const rateCap = new RateCap();
    rateCap.record("persona:c", evening.getTime());
    const plan = planScene({
      config,
      now: evening,
      rateCap,
      rng: seq([0.99, 0.1, 0.1, 0.1]),
    });
    assert.ok(plan);
    assert.ok(!plan.cast.some((p) => p.id === "c"));
  });

  test("declines when fewer than two personas remain eligible", () => {
    const rateCap = new RateCap();
    rateCap.record("persona:a", evening.getTime());
    rateCap.record("persona:a", evening.getTime());
    rateCap.record("persona:a", evening.getTime());
    rateCap.record("persona:a", evening.getTime());
    rateCap.record("persona:a", evening.getTime());
    rateCap.record("persona:a", evening.getTime());
    rateCap.record("persona:b", evening.getTime());
    for (let i = 0; i < 5; i++) {
      rateCap.record("persona:b", evening.getTime());
    }
    rateCap.record("persona:c", evening.getTime());
    assert.equal(planScene({ config, now: evening, rateCap, rng: () => 0.5 }), null);
  });

  test("avoids a topic that was just used", () => {
    const plan = planScene({
      config,
      now: evening,
      rateCap: new RateCap(),
      recentTopics: ["assunto a", "assunto b"],
      rng: () => 0.5,
    });
    assert.equal(plan.topic, "assunto c");
  });

  test("falls back to the full topic list when everything is recent", () => {
    const plan = planScene({
      config,
      now: evening,
      rateCap: new RateCap(),
      recentTopics: config.community.topics,
      rng: () => 0.5,
    });
    assert.ok(config.community.topics.includes(plan.topic));
  });

  test("never plans more lines than the server has headroom for", () => {
    const rateCap = new RateCap();
    for (let i = 0; i < 8; i++) {
      rateCap.record("server:test", evening.getTime());
    }
    const plan = planScene({ config, now: evening, rateCap, rng: () => 0.99 });
    assert.ok(plan);
    assert.ok(plan.lines <= 4, `planned ${plan.lines} with 4 left`);
  });

  test("stays inside the configured line bounds", () => {
    for (let i = 0; i < 40; i++) {
      const plan = planScene({
        config,
        now: evening,
        rateCap: new RateCap(),
        rng: Math.random,
      });
      assert.ok(plan.lines >= 3 && plan.lines <= 5, `got ${plan.lines}`);
    }
  });
});

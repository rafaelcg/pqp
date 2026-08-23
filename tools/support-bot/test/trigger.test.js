import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { RateCap } from "../../ambient/src/schedule.js";
import { screenTrigger, isAddressed, stripMention, SKIP } from "../src/trigger.js";

const BOT = { botUserId: "bot-1", botUsername: "pqpajuda" };

const LIMITS = {
  maxPerUserPerHour: 3,
  maxPerChannelPerHour: 5,
  cooldownMs: 8000,
};

function message(overrides = {}) {
  return {
    id: `m-${Math.random()}`,
    channelId: "ch-ajuda",
    authorId: "user-1",
    authorName: "Bia",
    body: "@pqpajuda tem como aumentar a qualidade?",
    isWebhook: false,
    replyTo: null,
    ...overrides,
  };
}

function context(overrides = {}) {
  return {
    ...BOT,
    allowedChannelIds: new Set(["ch-ajuda"]),
    ignoreUserIds: new Set(),
    rateCap: new RateCap(),
    seen: new Set(),
    now: 1_000_000,
    limits: LIMITS,
    dailyCallsRemaining: 100,
    lastAnswerAt: 0,
    ...overrides,
  };
}

describe("isAddressed", () => {
  test("a mention of the bot's username counts", () => {
    assert.equal(isAddressed(message(), BOT), "mention");
  });

  test("case does not matter, because autocomplete is not the only way in", () => {
    assert.equal(isAddressed(message({ body: "@PqpAjuda oi" }), BOT), "mention");
  });

  test("a longer username that merely starts the same does NOT count", () => {
    // "@pqpajudante" is somebody else. Matching on a prefix would have the bot
    // answering questions aimed at a different account.
    assert.equal(isAddressed(message({ body: "@pqpajudante oi" }), BOT), null);
  });

  test("a reply to one of the bot's own messages counts", () => {
    // How a follow-up is actually typed. Demanding a second @ for "e no
    // firefox?" would be pedantry with a cost.
    const m = message({ body: "e no firefox?", replyTo: { authorId: "bot-1" } });
    assert.equal(isAddressed(m, BOT), "reply");
  });

  test("a reply to somebody else does not", () => {
    const m = message({ body: "e no firefox?", replyTo: { authorId: "user-9" } });
    assert.equal(isAddressed(m, BOT), null);
  });
});

describe("screenTrigger: the trigger decision", () => {
  test("answers a plain mention in an allowed channel", () => {
    const verdict = screenTrigger(message(), context());
    assert.equal(verdict.answer, true);
    assert.equal(verdict.how, "mention");
    assert.equal(verdict.question, "tem como aumentar a qualidade?");
  });

  test("stays out of a conversation between two humans", () => {
    // THE DECISION, as a test. A question in #ajuda with no mention is not the
    // bot's to answer: two humans helping each other is the better outcome and
    // the room's whole premise.
    const verdict = screenTrigger(
      message({ body: "alguém sabe como aumenta a qualidade?" }),
      context(),
    );
    assert.equal(verdict.answer, false);
    assert.equal(verdict.reason, SKIP.NOT_ADDRESSED);
  });

  test("ignores a channel it was not told to watch", () => {
    const verdict = screenTrigger(message({ channelId: "ch-papo-reto" }), context());
    assert.equal(verdict.reason, SKIP.CHANNEL);
  });
});

describe("screenTrigger: loops", () => {
  test("never answers itself, and checks that before anything else", () => {
    // Even a message that mentions the bot and passes every other gate. This is
    // the check that makes a self-loop impossible rather than unlikely, so it
    // runs first and nothing can be ordered in front of it.
    const verdict = screenTrigger(
      message({ authorId: "bot-1", body: "@pqpajuda e aí" }),
      context(),
    );
    assert.equal(verdict.reason, SKIP.SELF);
  });

  test("never answers another bot", () => {
    // Bot-to-bot is the classic way a channel fills with garbage overnight.
    // Two independent detectors: the ignore list, and the " [bot]" suffix that
    // every disclosed automated account in this product carries by construction.
    assert.equal(
      screenTrigger(message({ authorName: "resenha [bot]" }), context()).reason,
      SKIP.BOT_AUTHOR,
    );
    assert.equal(
      screenTrigger(message({ authorId: "other-bot" }), context({ ignoreUserIds: new Set(["other-bot"]) })).reason,
      SKIP.IGNORED_AUTHOR,
    );
  });

  test("never answers a webhook", () => {
    assert.equal(screenTrigger(message({ isWebhook: true }), context()).reason, SKIP.WEBHOOK);
  });

  test("never answers the same message twice", () => {
    // A reconnect can redeliver a broadcast, and answering twice reads as a bug
    // in the product rather than in the bot.
    const m = message();
    assert.equal(screenTrigger(m, context({ seen: new Set([m.id]) })).reason, SKIP.DUPLICATE);
  });
});

describe("screenTrigger: rate limits", () => {
  test("refuses inside the cooldown", () => {
    const verdict = screenTrigger(message(), context({ lastAnswerAt: 1_000_000 - 500 }));
    assert.equal(verdict.reason, SKIP.COOLDOWN);
  });

  test("caps one person, so a single visitor cannot spend the whole budget", () => {
    const rateCap = new RateCap();
    const now = 1_000_000;
    for (let i = 0; i < LIMITS.maxPerUserPerHour; i++) {
      rateCap.record("user:user-1", now);
    }
    assert.equal(screenTrigger(message(), context({ rateCap, now })).reason, SKIP.USER_CAP);
    // Somebody else is unaffected: the cap is per person, not a global mute.
    assert.equal(
      screenTrigger(message({ authorId: "user-2" }), context({ rateCap, now })).answer,
      true,
    );
  });

  test("caps the channel, so the room does not become a transcript of the bot", () => {
    const rateCap = new RateCap();
    const now = 1_000_000;
    for (let i = 0; i < LIMITS.maxPerChannelPerHour; i++) {
      rateCap.record("channel:ch-ajuda", now);
    }
    assert.equal(
      screenTrigger(message({ authorId: "user-7" }), context({ rateCap, now })).reason,
      SKIP.CHANNEL_CAP,
    );
  });

  test("stops when the day's model budget is gone", () => {
    assert.equal(
      screenTrigger(message(), context({ dailyCallsRemaining: 0 })).reason,
      SKIP.DAILY_CAP,
    );
  });
});

describe("screenTrigger: the question it extracts", () => {
  test("refuses a bare mention with nothing attached", () => {
    assert.equal(screenTrigger(message({ body: "@pqpajuda" }), context()).reason, SKIP.EMPTY);
  });

  test("refuses a paste rather than a question", () => {
    const verdict = screenTrigger(
      message({ body: `@pqpajuda ${"x".repeat(700)}` }),
      context(),
    );
    assert.equal(verdict.reason, SKIP.TOO_LONG);
  });
});

describe("stripMention", () => {
  test("removes the bot's name and tidies the whitespace", () => {
    assert.equal(stripMention("@pqpajuda  tem som?  ", "pqpajuda"), "tem som?");
    assert.equal(stripMention("oi @pqpajuda tem som?", "pqpajuda"), "oi tem som?");
  });

  test("leaves other people's mentions where they are", () => {
    assert.equal(stripMention("@pqpajuda o @rafa some?", "pqpajuda"), "o @rafa some?");
  });
});

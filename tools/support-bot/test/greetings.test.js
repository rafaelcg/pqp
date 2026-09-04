/**
 * Answering a newcomer's hello, with no network.
 *
 * `Greeter.decide` is the whole decision and `Roster` is the whole memory;
 * driving them with a fake clock covers every rule in `greetings.js`. The last
 * block drives `answerHello` from `bot.js` with a fake socket, so the I/O
 * around the decision (the on-demand roster re-read, the reply frame, the kill
 * switch) is exercised too. Nothing connects to anything.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { RateCap } from "../../ambient/src/schedule.js";
import {
  Roster,
  Greeter,
  isGreeting,
  pickLine,
  renderLine,
  greetingsEnabled,
  HELLO_SKIP,
  NEWCOMER_WINDOW_MS,
  CAP_WINDOW_MS,
} from "../src/greetings.js";
import { HELLO_REPLIES } from "../src/greetings-pool.js";
import { answerHello } from "../src/bot.js";

const T0 = 1_700_000_000_000;
const MIN = 60_000;
const GERAL = "ch-geral";
const BOT = "bot-1";

function tmpLedger() {
  return join(mkdtempSync(join(tmpdir(), "pqp-greet-")), "greetings.json");
}

function member(id, overrides = {}) {
  return { id, username: id, displayName: id, isCharacter: false, ...overrides };
}

function message(overrides = {}) {
  return {
    id: `m-${Math.random()}`,
    channelId: GERAL,
    authorId: "nova",
    authorName: "Nova",
    body: "oi gente!",
    isWebhook: false,
    ...overrides,
  };
}

/**
 * A roster that has seen the old crowd at T0 and then saw `nova` appear one
 * minute later. That is the normal shape of "somebody just joined".
 */
function rosterWithNewcomer({ path = null, extra = {} } = {}) {
  const roster = new Roster({ path });
  roster.observe([member(BOT), member("vet")], T0);
  roster.observe([member(BOT), member("vet"), member("nova", extra)], T0 + MIN);
  return roster;
}

function greeter(roster, overrides = {}) {
  return new Greeter({
    roster,
    rateCap: new RateCap(),
    channelId: GERAL,
    botUserId: BOT,
    random: () => 0,
    ...overrides,
  });
}

describe("isGreeting", () => {
  const hits = [
    "oi",
    "Oi!",
    "oii",
    "oiii gente",
    "oie",
    "olá",
    "ola pessoal",
    "olá!! 👋",
    "eae",
    "eaí",
    "e ai galera",
    "salve",
    "salveee",
    "bom dia",
    "Boa tarde a todos",
    "boa noite gente",
    "cheguei",
    "chegando!",
    "opa",
    "opa!",
    "fala galera",
    "fala pessoal",
    "oi gente",
    "oi pessoal",
    "hello",
    "hi",
    "hey",
    "oi, como faço pra entrar na call?",
    "oi como faço pra entrar na call",
    "oi @rafa",
    "👋 oi",
  ];
  for (const body of hits) {
    test(`hit: ${JSON.stringify(body)}`, () => {
      assert.equal(isGreeting(body), true);
    });
  }

  const misses = [
    "",
    "   ",
    "como entro na call?",
    "o áudio tá cortando",
    "oitava vez que cai",
    "fala sério, caiu de novo",
    "opa, deu erro aqui",
    "boa call ontem",
    "olafur é meu nome",
    "hino nacional",
    "alguém aí?",
    "tá on?",
    "@manual_bot tem como aumentar a qualidade?",
    `oi ${"a".repeat(220)}`,
  ];
  for (const body of misses) {
    test(`miss: ${JSON.stringify(body)}`, () => {
      assert.equal(isGreeting(body), false);
    });
  }
});

describe("the pool", () => {
  test("has about twenty lines, each with exactly one {name} slot and no em dash", () => {
    assert.ok(HELLO_REPLIES.length >= 18, `only ${HELLO_REPLIES.length} lines`);
    for (const line of HELLO_REPLIES) {
      assert.equal(line.split("{name}").length - 1, 1, line);
      assert.equal(line.includes("\u2014"), false, line);
      assert.ok(line.length <= 140, `too long: ${line}`);
    }
  });

  test("no gendered welcome and nothing that reads as a product promise", () => {
    for (const line of HELLO_REPLIES) {
      assert.doesNotMatch(line, /bem-vind[oa]/i, line);
      assert.doesNotMatch(line, /nunca cai|sempre funciona|criptograf/i, line);
    }
  });

  test("pickLine never repeats the last line", () => {
    const pool = ["a", "b", "c"];
    let last = -1;
    // A random source that would pick index 0 every time if allowed to.
    for (let i = 0; i < 50; i++) {
      const next = pickLine(pool, last, () => 0);
      assert.notEqual(next, last);
      last = next;
    }
  });

  test("pickLine with one line has nothing else to choose", () => {
    assert.equal(pickLine(["só essa"], 0), 0);
  });

  test("renderLine prefers @username and falls back to the display name", () => {
    assert.equal(renderLine("oi {name}!", { username: "bia", displayName: "Bia" }), "oi @bia!");
    assert.equal(renderLine("oi {name}!", { username: null, displayName: "Bia" }), "oi Bia!");
  });
});

describe("greetingsEnabled", () => {
  test("default on; false/0/off/no turn it off", () => {
    assert.equal(greetingsEnabled({}), true);
    assert.equal(greetingsEnabled({ SUPPORT_BOT_GREETINGS: "true" }), true);
    for (const off of ["false", "0", "off", "no", " FALSE "]) {
      assert.equal(greetingsEnabled({ SUPPORT_BOT_GREETINGS: off }), false, off);
    }
  });
});

describe("Roster", () => {
  test("the first roster ever seen makes nobody new", () => {
    const roster = new Roster();
    const appeared = roster.observe([member("a"), member("b")], T0);
    assert.deepEqual(appeared, []);
    assert.equal(roster.isNew("a", T0 + 1), false);
  });

  test("somebody who appears between two close polls is new for fifteen minutes", () => {
    const roster = rosterWithNewcomer();
    assert.equal(roster.isNew("nova", T0 + 2 * MIN), true);
    assert.equal(roster.isNew("nova", T0 + MIN + NEWCOMER_WINDOW_MS - 1), true);
    assert.equal(roster.isNew("nova", T0 + MIN + NEWCOMER_WINDOW_MS), false);
    assert.equal(roster.isNew("vet", T0 + 2 * MIN), false);
    assert.equal(roster.isNew("nobody", T0 + 2 * MIN), false);
  });

  test("somebody who appears after a long gap is NOT new (fail quiet)", () => {
    // The bot was down for an hour. Whoever joined in that hour looks brand
    // new at boot and must not be greeted as if they walked in just now.
    const roster = new Roster();
    roster.observe([member("vet")], T0);
    roster.observe([member("vet"), member("late")], T0 + 60 * MIN);
    assert.equal(roster.isNew("late", T0 + 60 * MIN + 1), false);
  });

  test("a joinedAt from the endpoint wins over the estimate", () => {
    const roster = new Roster();
    roster.observe([member("vet")], T0);
    roster.observe(
      [member("vet"), member("old", { joinedAt: new Date(T0 - 5 * 60 * MIN).toISOString() })],
      T0 + MIN,
    );
    // Appeared between two close polls, but the server says they joined five
    // hours ago, so they are not new.
    assert.equal(roster.isNew("old", T0 + 2 * MIN), false);

    // And the other direction: even on a first-ever roster, a fresh joinedAt
    // counts, because it is the real thing rather than an estimate.
    const fresh = new Roster();
    fresh.observe([member("just", { joinedAt: new Date(T0 - MIN).toISOString() })], T0);
    assert.equal(fresh.isNew("just", T0), true);
  });

  test("survives a restart: greeted ids and first-seen times are on disk", () => {
    const path = tmpLedger();
    const roster = rosterWithNewcomer({ path });
    roster.markGreeted("nova", T0 + 2 * MIN);

    const reloaded = new Roster({ path });
    assert.equal(reloaded.wasGreeted("nova"), true);
    assert.equal(reloaded.isNew("nova", T0 + 3 * MIN), true);
    assert.equal(JSON.parse(readFileSync(path, "utf8")).greeted.nova.how, "replied");
  });

  test("a corrupt ledger starts over rather than throwing", () => {
    const path = tmpLedger();
    writeFileSync(path, "{not json");
    const roster = new Roster({ path });
    assert.deepEqual(roster.observe([member("a")], T0), []);
  });
});

describe("Greeter.decide", () => {
  test("a newcomer who says oi gets one line, as a reply to their message", () => {
    const g = greeter(rosterWithNewcomer());
    const m = message({ id: "m-1" });
    const result = g.decide(m, T0 + 2 * MIN);
    assert.equal(result.reason, "hello");
    assert.equal(result.replyToId, "m-1");
    assert.ok(result.post.includes("@nova"), result.post);
    assert.ok(HELLO_REPLIES.some((l) => l.replace("{name}", "@nova") === result.post));
  });

  test("never greets the same person twice, across a restart", () => {
    const path = tmpLedger();
    const g = greeter(rosterWithNewcomer({ path }));
    const m = message();
    assert.equal(g.decide(m, T0 + 2 * MIN).reason, "hello");
    g.recordSent(m, T0 + 2 * MIN);
    assert.equal(g.decide(message(), T0 + 3 * MIN).reason, HELLO_SKIP.ALREADY);

    // "Restart": a fresh Roster from the same file, a fresh Greeter.
    const again = greeter(new Roster({ path }));
    assert.equal(again.decide(message(), T0 + 4 * MIN).reason, HELLO_SKIP.ALREADY);
  });

  test("somebody who joined an hour ago and says oi gets nothing", () => {
    const g = greeter(rosterWithNewcomer());
    assert.equal(g.decide(message(), T0 + MIN + 60 * MIN).reason, HELLO_SKIP.NOT_NEW);
  });

  test("a newcomer who asks a question, not a greeting, gets nothing from here", () => {
    const g = greeter(rosterWithNewcomer());
    const result = g.decide(message({ body: "como entro na call?" }), T0 + 2 * MIN);
    assert.equal(result.reason, HELLO_SKIP.NOT_GREETING);
  });

  test("a greeting plus a question still counts", () => {
    const g = greeter(rosterWithNewcomer());
    const result = g.decide(message({ body: "oi, como faço pra entrar na call?" }), T0 + 2 * MIN);
    assert.equal(result.reason, "hello");
  });

  test("only the greeting channel", () => {
    const g = greeter(rosterWithNewcomer());
    assert.equal(g.decide(message({ channelId: "ch-ajuda" }), T0 + 2 * MIN).reason, HELLO_SKIP.CHANNEL);
  });

  test("its own messages, webhooks, [bot] authors and characters are skipped", () => {
    const roster = rosterWithNewcomer();
    roster.observe(
      [member(BOT), member("vet"), member("nova"), member("npc", { isCharacter: true })],
      T0 + 2 * MIN,
    );
    const g = greeter(roster);
    const at = T0 + 3 * MIN;
    assert.equal(g.decide(message({ authorId: BOT }), at).reason, HELLO_SKIP.SELF);
    assert.equal(g.decide(message({ isWebhook: true }), at).reason, HELLO_SKIP.WEBHOOK);
    assert.equal(
      g.decide(message({ authorId: "other", authorName: "eco [bot]" }), at).reason,
      HELLO_SKIP.BOT_AUTHOR,
    );
    assert.equal(
      g.decide(message({ authorId: "npc", authorName: "Zé" }), at).reason,
      HELLO_SKIP.CHARACTER,
    );
  });

  test("the ten-minute cap holds, and the capped newcomer is still marked greeted", () => {
    const roster = new Roster();
    roster.observe([member(BOT)], T0);
    const crowd = ["a", "b", "c", "d", "e"].map((id) => member(id));
    roster.observe([member(BOT), ...crowd], T0 + MIN);
    const g = greeter(roster, { maxPerWindow: 3 });

    const at = T0 + 2 * MIN;
    for (const id of ["a", "b", "c"]) {
      const m = message({ authorId: id, authorName: id });
      assert.equal(g.decide(m, at).reason, "hello", id);
      g.recordSent(m, at);
    }
    assert.equal(g.decide(message({ authorId: "d" }), at + 1).reason, HELLO_SKIP.CAP);
    assert.equal(roster.wasGreeted("d"), true);
    // Not greeted late, even once the window has passed.
    assert.equal(g.decide(message({ authorId: "d" }), at + CAP_WINDOW_MS + 1).reason, HELLO_SKIP.ALREADY);
    // But the cap itself has rolled off for the next person.
    assert.equal(g.decide(message({ authorId: "e" }), at + 5 * MIN).reason, HELLO_SKIP.CAP);
    roster.observe([member(BOT), ...crowd, member("f")], at + CAP_WINDOW_MS);
    assert.equal(g.decide(message({ authorId: "f" }), at + CAP_WINDOW_MS + 2).reason, "hello");
  });

  test("two hellos in a row never get the same line", () => {
    const roster = new Roster();
    roster.observe([member(BOT)], T0);
    roster.observe([member(BOT), member("p"), member("q")], T0 + MIN);
    // A random source that always asks for the first candidate.
    const g = greeter(roster, { random: () => 0 });
    const a = g.decide(message({ authorId: "p" }), T0 + 2 * MIN);
    g.recordSent(message({ authorId: "p" }), T0 + 2 * MIN);
    const b = g.decide(message({ authorId: "q" }), T0 + 2 * MIN + 1);
    assert.notEqual(a.post.replace("@p", "{name}"), b.post.replace("@q", "{name}"));
  });

  test("SUPPORT_BOT_GREETINGS=false silences it", () => {
    const g = greeter(rosterWithNewcomer(), { enabled: greetingsEnabled({ SUPPORT_BOT_GREETINGS: "false" }) });
    assert.equal(g.decide(message(), T0 + 2 * MIN).reason, HELLO_SKIP.DISABLED);
  });
});

describe("answerHello (the I/O around the decision)", () => {
  function harness({ stopped = () => false, dryRun = false, rosterMembers } = {}) {
    const roster = new Roster();
    roster.observe([member(BOT), member("vet")], Date.now() - 30_000);
    const g = greeter(roster);
    const sent = [];
    const socket = {
      reply: (body, replyToId) => sent.push({ body, replyToId }),
    };
    const logged = [];
    const runtime = {
      roster,
      // The on-demand re-read: "nova" appears only when asked for.
      pollRoster: async () => {
        roster.observe(rosterMembers ?? [member(BOT), member("vet"), member("nova")], Date.now());
      },
    };
    return {
      sent,
      logged,
      run: (m) =>
        answerHello(
          { message: m, socket },
          {
            greeter: g,
            runtime,
            args: { dryRun },
            log: (event, fields) => logged.push({ event, ...fields }),
            stopped,
          },
        ),
    };
  }

  test("an unknown author triggers a roster re-read, then the reply goes out threaded", async () => {
    const h = harness();
    const m = message({ id: "m-9" });
    const result = await h.run(m);
    assert.equal(result.reason, "hello");
    assert.equal(h.sent.length, 1);
    assert.equal(h.sent[0].replyToId, "m-9");
    assert.ok(h.sent[0].body.includes("@nova"));
    assert.equal(h.logged.at(-1).event, "hello");
  });

  test("the kill switch stops a hello that was already decided", async () => {
    const h = harness({ stopped: () => true });
    const result = await h.run(message());
    assert.equal(result.reason, "kill-switch");
    assert.equal(h.sent.length, 0);
  });

  test("--dry-run prints and posts nothing, but still counts as greeted", async () => {
    const h = harness({ dryRun: true });
    const first = await h.run(message());
    assert.equal(first.reason, "hello");
    assert.equal(h.sent.length, 0);
    const second = await h.run(message());
    assert.equal(second.reason, HELLO_SKIP.ALREADY);
  });

  test("no greeter means nothing happens", async () => {
    const result = await answerHello(
      { message: message(), socket: {} },
      { greeter: null, runtime: {}, args: {}, log: () => {}, stopped: () => false },
    );
    assert.equal(result.post, null);
  });
});

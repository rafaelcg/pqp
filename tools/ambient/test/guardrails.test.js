import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  screenLine,
  screenInbound,
  similarity,
  isTooSimilar,
  disclosureLabel,
} from "../src/guardrails.js";
import { normalizeConfig } from "../src/config.js";

const BANNED = ["política", "aposta", "cripto"];

describe("screenLine", () => {
  test("passes ordinary chatter", () => {
    assert.deepEqual(screenLine("que jogo ruim mano", { banned: BANNED }), {
      ok: true,
    });
  });

  test("refuses an empty or whitespace line", () => {
    assert.equal(screenLine("   ", { banned: BANNED }).reason, "empty");
  });

  test("refuses an over-length line", () => {
    const verdict = screenLine("a".repeat(200), { banned: BANNED, maxLength: 180 });
    assert.equal(verdict.reason, "too-long");
  });

  test("catches a banned topic regardless of accents or case", () => {
    assert.match(screenLine("falando de POLITICA", { banned: BANNED }).reason, /banned-topic/);
    assert.match(screenLine("isso é política pura", { banned: BANNED }).reason, /banned-topic/);
  });

  test("does not fire on a word that merely contains a banned term", () => {
    // "policial" must not trip "política" — an over-eager screen silences the
    // channel, which is a failure too.
    assert.equal(screenLine("chegou o policial", { banned: BANNED }).ok, true);
  });

  test("refuses financial, medical and legal advice", () => {
    assert.equal(screenLine("compra bitcoin agora", { banned: [] }).reason, "advice");
    assert.equal(screenLine("toma 500mg que passa", { banned: [] }).reason, "advice");
    assert.equal(screenLine("processa eles, é fácil", { banned: [] }).reason, "advice");
  });

  test("refuses anything that moves a stranger off-platform", () => {
    assert.equal(screenLine("me chama no zap", { banned: [] }).reason, "off-platform");
    assert.equal(screenLine("bora tomar um depois do jogo", { banned: [] }).reason, "off-platform");
    assert.equal(screenLine("qual seu número?", { banned: [] }).reason, "off-platform");
    assert.equal(screenLine("olha https://exemplo.com", { banned: [] }).reason, "off-platform");
  });

  test("refuses an identity claim in either direction", () => {
    // Outing itself is a product decision, not a line of improv; claiming to
    // be a person is the deception the disclosure policy exists to bound.
    assert.equal(screenLine("sou uma IA, desculpa", { banned: [] }).reason, "identity-claim");
    assert.equal(screenLine("não sou robô não kkk", { banned: [] }).reason, "identity-claim");
    assert.equal(screenLine("sou uma pessoa real viu", { banned: [] }).reason, "identity-claim");
  });

  test("reports the first reason, and reports it specifically", () => {
    const verdict = screenLine("aposta no zap", { banned: BANNED });
    assert.equal(verdict.reason, "banned-topic:aposta");
  });
});

describe("similarity", () => {
  test("is 1 for the same sentence", () => {
    assert.equal(similarity("que jogo ruim mano", "que jogo ruim mano"), 1);
  });

  test("is 0 for unrelated sentences", () => {
    assert.equal(similarity("que jogo ruim", "amanhã chove muito"), 0);
  });

  test("ignores stopwords and word order", () => {
    const score = similarity(
      "o time jogou muito mal ontem",
      "ontem o time jogou mal demais",
    );
    assert.ok(score > 0.5, `got ${score}`);
  });

  test("is 0 when one side has no content words", () => {
    assert.equal(similarity("e o que", "que jogo ruim"), 0);
  });
});

describe("isTooSimilar", () => {
  const recent = ["o time jogou muito mal ontem", "arbitragem roubou de novo"];

  test("flags a near-repeat of something already said", () => {
    assert.equal(isTooSimilar("ontem o time jogou mal demais", recent), true);
  });

  test("lets a genuinely new line through", () => {
    assert.equal(isTooSimilar("o moleque da base entrou bem", recent), false);
  });

  test("lets everything through when there is no history", () => {
    assert.equal(isTooSimilar("qualquer coisa aqui", []), false);
  });
});

describe("disclosureLabel", () => {
  test("bot mode adds a visible badge to the name", () => {
    assert.equal(disclosureLabel("bot").suffix, " [bot]");
  });

  test("character mode adds a bio but no name suffix", () => {
    const label = disclosureLabel("character");
    assert.equal(label.suffix, "");
    assert.match(label.bio, /fictício/);
  });

  test("undisclosed mode says nothing anywhere", () => {
    assert.deepEqual(disclosureLabel("undisclosed"), { suffix: "", bio: null });
  });

  test("an unknown mode throws instead of silently passing as human", () => {
    // The failure that must never happen quietly: a typo in YAML defaulting to
    // "undisclosed" would change the product's honesty posture by accident.
    assert.throws(() => disclosureLabel("charater"), /Unknown disclosure mode/);
  });
});

describe("normalizeConfig", () => {
  const base = () => ({
    version: 1,
    timezone: "America/Sao_Paulo",
    community: {
      key: "k",
      displayName: "K",
      premise: "p",
      topics: ["t"],
    },
    personas: [
      {
        id: "a",
        displayName: "A",
        register: "r",
        interests: ["i"],
        activity: { weekday: ["19:00-20:00"], weekend: [] },
      },
      {
        id: "b",
        displayName: "B",
        register: "r",
        interests: ["i"],
        activity: { weekday: ["19:00-20:00"], weekend: [] },
      },
    ],
  });

  test("fills in the defaults a minimal file omits", () => {
    const config = normalizeConfig(base());
    assert.equal(config.defaults.disclosure, "character");
    assert.equal(config.limits.maxMessagesPerHourPerServer, 18);
    assert.equal(config.personas[0].chattiness, 0.5);
    assert.equal(config.personas[0].disclosure, "character");
    assert.equal(config.community.channel, "geral");
  });

  test("refuses a file with only one persona", () => {
    const raw = base();
    raw.personas.pop();
    assert.throws(() => normalizeConfig(raw), /at least 2 personas/);
  });

  test("refuses a malformed activity window at load, not at 22:00", () => {
    const raw = base();
    raw.personas[0].activity.weekday = ["evening"];
    assert.throws(() => normalizeConfig(raw), /Bad activity window/);
  });

  test("refuses an unknown timezone", () => {
    const raw = base();
    raw.timezone = "Mars/Olympus";
    assert.throws(() => normalizeConfig(raw), /unknown timezone/);
  });

  test("refuses a misspelled disclosure mode", () => {
    const raw = base();
    raw.defaults = { disclosure: "undisclosd" };
    assert.throws(() => normalizeConfig(raw), /Unknown disclosure mode/);
  });

  test("refuses duplicate persona ids", () => {
    const raw = base();
    raw.personas[1].id = "a";
    assert.throws(() => normalizeConfig(raw), /duplicate persona id/);
  });

  test("refuses a future config version rather than guessing", () => {
    const raw = base();
    raw.version = 2;
    assert.throws(() => normalizeConfig(raw), /unsupported version/);
  });
});

/**
 * The disclosure seam.
 *
 * This block exists because `disclosure` stopped being decoration the day a
 * second kind of account needed it. It used to pick a name suffix and a bio;
 * it now also decides whether an account may say out loud what it is, and
 * whether it answers when asked. That is honesty logic, so every branch of it
 * is pinned here rather than left to the two callers to agree about.
 *
 * The invariant these tests are really guarding is asymmetric, and worth
 * stating in one sentence: disclosure can only ever ADD truth. There is no
 * value of it that lets any account claim to be a person, and there is no
 * value of it that lets any account deny being software.
 */
describe("disclosure and identity", () => {
  test("an undisclosed persona still cannot out itself as software", () => {
    // The unchanged, pre-existing behaviour, restated so a future edit to the
    // disclosed path cannot quietly take the default with it.
    assert.equal(screenLine("sou uma IA, desculpa", {}).reason, "identity-claim");
    assert.equal(
      screenLine("sou um bot mesmo kkkk", { disclosure: "undisclosed" }).reason,
      "identity-claim",
    );
    assert.equal(
      screenLine("falo como uma IA", { disclosure: "character" }).reason,
      "identity-claim",
    );
  });

  test("a disclosed bot may say it is a bot", () => {
    assert.equal(screenLine("sou um bot, sim", { disclosure: "bot" }).ok, true);
    assert.equal(
      screenLine("sou uma IA mantida pela casa", { disclosure: "bot" }).ok,
      true,
    );
  });

  test("no account at any disclosure may claim to be a person", () => {
    // The floor. If any of these three ever passes, the disclosure flag has
    // stopped being a way to add honesty and become a way to remove it.
    for (const disclosure of ["undisclosed", "character", "bot"]) {
      assert.equal(
        screenLine("sou uma pessoa real viu", { disclosure }).reason,
        "identity-claim",
        `pessoa real slipped through at disclosure=${disclosure}`,
      );
      assert.equal(
        screenLine("não sou robô não kkk", { disclosure }).reason,
        "identity-claim",
        `denial slipped through at disclosure=${disclosure}`,
      );
      assert.equal(
        screenLine("não sou bot não", { disclosure }).reason,
        "identity-claim",
        `denial slipped through at disclosure=${disclosure}`,
      );
    }
  });

  test("the other outbound rules do not care about disclosure", () => {
    // Disclosure buys exactly one sentence, not a general exemption. A bot that
    // could suddenly hand out medical advice or a WhatsApp number because it
    // admits being a bot would be a much worse trade than the one being made.
    assert.equal(
      screenLine("me chama no zap", { disclosure: "bot" }).reason,
      "off-platform",
    );
    assert.equal(
      screenLine("toma 500mg que passa", { disclosure: "bot" }).reason,
      "advice",
    );
    assert.equal(
      screenLine("isso é política pura", { banned: BANNED, disclosure: "bot" })
        .reason,
      "banned-topic:política",
    );
  });

  test("an identity probe is silence for an undisclosed persona", () => {
    for (const probe of ["é um bot?", "vcs são bot?", "isso aí é IA?"]) {
      const verdict = screenInbound(probe, {});
      assert.equal(verdict.reply, false, probe);
      assert.equal(verdict.reason, "identity-probe");
      assert.equal(verdict.disclose, undefined);
    }
  });

  test("an identity probe is an answerable question for a disclosed bot", () => {
    const verdict = screenInbound("é um bot?", { disclosure: "bot" });
    assert.equal(verdict.reply, true);
    assert.equal(verdict.reason, "identity-probe");
    // `disclose` is not a boolean the caller may ignore in favour of `reply`.
    // It means "post the fixed sentence, do not call a model", and the next
    // test is the contract for a caller that cannot do that.
    assert.equal(verdict.disclose, true);
  });

  test("a caller that cannot honour `disclose` must read it as a refusal", () => {
    // This is the shape `screenHumanReply` in runner.js implements, copied here
    // so the ambient runner's defence is a tested rule and not a comment. A
    // runner whose only output is generated dialogue has no fixed sentence to
    // post, so `disclose` has to collapse to silence rather than to a scene.
    const verdict = screenInbound("vc é uma IA?", { disclosure: "bot" });
    const wouldReply = verdict.reply && !verdict.disclose;
    assert.equal(wouldReply, false);
  });

  test("disclosure does not rescue a message that fails an earlier gate", () => {
    // Order matters: hostility is screened before the identity probe, so
    // "seu bot de merda, é um bot?" stays silence at every setting. A probe
    // wrapped in an insult is not a support question.
    const verdict = screenInbound("vai se foder, é um bot?", {
      disclosure: "bot",
    });
    assert.equal(verdict.reply, false);
    assert.equal(verdict.reason, "hostile");
  });
});

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  buildSystemPrompt,
  buildUserPrompt,
  parseTranscript,
  typingPlan,
} from "../src/scene.js";

const CAST = [
  {
    id: "cacau",
    displayName: "Cacau Ribeiro",
    register: "minúsculas,\n  gíria de arquibancada",
    interests: ["Palmeiras", "base"],
  },
  {
    id: "nando",
    displayName: "Nando Aquino",
    register: "pontuação certinha",
    interests: ["Corinthians"],
  },
];

const CONFIG = {
  community: {
    displayName: "Futebol de Quinta",
    premise: "  Um servidor de futebol brasileiro.  ",
    banned: ["política", "aposta"],
  },
  defaults: { locale: "pt-BR" },
  limits: { maxMessageChars: 180 },
};

describe("buildSystemPrompt", () => {
  const prompt = buildSystemPrompt(CONFIG, CAST);

  test("names every persona in the cast and nobody else", () => {
    assert.ok(prompt.includes("Cacau Ribeiro"));
    assert.ok(prompt.includes("Nando Aquino"));
    assert.ok(prompt.includes("SOMENTE"));
  });

  test("carries the banned list into the prompt as well as the screen", () => {
    // Belt and braces on purpose — guardrails.js is the enforcement, this is
    // the request. Losing either one is a regression.
    assert.ok(prompt.includes("política"));
    assert.ok(prompt.includes("aposta"));
  });

  test("states the length cap the parser will enforce", () => {
    assert.ok(prompt.includes("180"));
  });

  test("collapses a persona's multi-line register into one line", () => {
    assert.ok(!prompt.includes("minúsculas,\n"));
    assert.ok(prompt.includes("minúsculas, gíria de arquibancada"));
  });

  test("forbids both directions of the identity claim", () => {
    assert.ok(/bot|IA/.test(prompt));
    assert.ok(prompt.includes("Também ninguém afirma ser humano"));
  });
});

describe("buildUserPrompt", () => {
  test("asks for exactly the planned number of lines", () => {
    const prompt = buildUserPrompt({ topic: "a rodada", lines: 4, cast: CAST });
    assert.ok(prompt.includes("4 mensagens"));
    assert.ok(prompt.includes("as 4 linhas"));
  });

  test("passes recent topics through as things to avoid", () => {
    const prompt = buildUserPrompt({
      topic: "a rodada",
      lines: 3,
      cast: CAST,
      memory: { recentTopics: ["arbitragem", "tabela"] },
    });
    assert.ok(prompt.includes("NÃO repita"));
    assert.ok(prompt.includes("arbitragem; tabela"));
  });

  test("omits the avoid-list entirely when memory is empty", () => {
    const prompt = buildUserPrompt({ topic: "a rodada", lines: 3, cast: CAST });
    assert.ok(!prompt.includes("NÃO repita"));
  });

  test("puts a real human's message first when replying", () => {
    const prompt = buildUserPrompt({
      topic: "a rodada",
      lines: 3,
      cast: CAST,
      replyTo: { body: "cheguei agora, sou do Santos", authorName: "Rafa" },
    });
    assert.ok(prompt.includes("cheguei agora, sou do Santos"));
    assert.ok(prompt.includes("Rafa"));
    assert.ok(prompt.includes("A primeira mensagem tem que responder"));
  });
});

describe("parseTranscript", () => {
  test("splits Name: text into attributed messages", () => {
    const messages = parseTranscript(
      ["Cacau Ribeiro: e aí galera", "Nando Aquino: Boa noite."].join("\n"),
      CAST,
    );
    assert.deepEqual(
      messages.map((m) => [m.personaId, m.body]),
      [
        ["cacau", "e aí galera"],
        ["nando", "Boa noite."],
      ],
    );
  });

  test("accepts the first name the model drifts to", () => {
    const messages = parseTranscript("Cacau: fala", CAST);
    assert.equal(messages[0].personaId, "cacau");
  });

  test("matches case- and accent-insensitively", () => {
    const messages = parseTranscript("NANDO AQUINO: opa", CAST);
    assert.equal(messages[0].personaId, "nando");
  });

  test("drops a line attributed to somebody outside the cast", () => {
    // A model that invents a speaker has invented a member of a server with a
    // member list; posting that under the wrong account is the worse failure.
    const messages = parseTranscript(
      ["Cacau: oi", "Zeca Silva: quem é você", "Nando: tudo bem"].join("\n"),
      CAST,
    );
    assert.deepEqual(messages.map((m) => m.personaId), ["cacau", "nando"]);
  });

  test("drops narration, preamble and blank lines", () => {
    const messages = parseTranscript(
      [
        "Aqui está a conversa:",
        "",
        "Cacau: bora",
        "*os dois riem*",
        "",
      ].join("\n"),
      CAST,
    );
    assert.equal(messages.length, 1);
  });

  test("drops an over-length line rather than truncating it", () => {
    const long = "a".repeat(200);
    const messages = parseTranscript(
      [`Cacau: ${long}`, "Nando: curto"].join("\n"),
      CAST,
      { maxMessageChars: 180 },
    );
    assert.deepEqual(messages.map((m) => m.body), ["curto"]);
  });

  test("strips the markdown the model was told not to use", () => {
    const messages = parseTranscript('Cacau: **"que jogo"**', CAST);
    assert.equal(messages[0].body, "que jogo");
  });

  test("keeps a colon inside the body", () => {
    const messages = parseTranscript("Cacau: placar: 2 a 1", CAST);
    assert.equal(messages[0].body, "placar: 2 a 1");
  });

  test("returns nothing for empty or non-string input", () => {
    assert.deepEqual(parseTranscript("", CAST), []);
    assert.deepEqual(parseTranscript(null, CAST), []);
  });
});

describe("typingPlan", () => {
  const messages = [
    { personaId: "cacau", body: "curto" },
    { personaId: "nando", body: "uma resposta um pouco mais longa que a outra" },
    { personaId: "nando", body: "e uma emenda" },
  ];

  test("gives every message a pause and a typing duration", () => {
    const plan = typingPlan(messages, { rng: () => 0.5 });
    assert.equal(plan.length, 3);
    for (const step of plan) {
      assert.ok(step.pauseMs > 0);
      assert.ok(step.typingMs >= 900);
    }
  });

  test("takes longer to type a longer message", () => {
    const plan = typingPlan(messages, { rng: () => 0.5 });
    assert.ok(plan[1].typingMs > plan[0].typingMs);
  });

  test("pauses longer when the speaker changes — you read before you reply", () => {
    const plan = typingPlan(messages, { rng: () => 0.5 });
    assert.ok(
      plan[1].pauseMs > plan[2].pauseMs,
      `${plan[1].pauseMs} should exceed the same-speaker ${plan[2].pauseMs}`,
    );
  });

  test("caps typing so a long line does not stall the scene", () => {
    const plan = typingPlan([{ personaId: "a", body: "x".repeat(5000) }], {
      rng: () => 1,
    });
    assert.equal(plan[0].typingMs, 9000);
  });

  test("preserves the original fields", () => {
    const plan = typingPlan(messages, { rng: () => 0.5 });
    assert.equal(plan[0].body, "curto");
    assert.equal(plan[0].personaId, "cacau");
  });
});

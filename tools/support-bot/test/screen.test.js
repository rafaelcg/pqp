import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { loadFacts } from "../src/facts.js";
import {
  screenAnswer,
  disallowedLink,
  disallowedMention,
  ungroundedMeasurement,
  makesAppStoreClaim,
} from "../src/screen.js";

const facts = loadFacts(
  join(dirname(fileURLToPath(import.meta.url)), "..", "facts.md"),
);
const opts = { facts, ownerHandle: "rafa" };

/** The reason `screenAnswer` gives, or `null` when it passed. */
function why(body, extra = {}) {
  const verdict = screenAnswer(body, { ...opts, ...extra });
  return verdict.ok ? null : verdict.reason;
}

describe("screenAnswer: the answers it must let through", () => {
  // A screen that rejects correct answers is a bot that says "não sei" to
  // everything, which is a different failure and just as useless.
  const good = [
    "a captura é 1080p30 e não existe ajuste manual de qualidade.",
    "quanto menos gente assistindo, mais nítida a imagem fica. o envio divide uns 5 Mbps entre os espectadores.",
    "o som só vai junto no chrome, compartilhando uma guia, com a caixinha de áudio da guia marcada.",
    "o código é aberto, tá em github.com/rafaelcg/pqp.",
    "tem um beta de iphone pelo testflight em pqp.gg/beta.",
    "o app não está na App Store ainda.",
    "não, as mensagens não são criptografadas de ponta a ponta. o pqp está em beta.",
    "sou um bot, sim.",
    "a voz vai bem até umas 5 ou 6 pessoas por sala.",
    "essa eu não sei responder. @rafa consegue te dizer.",
  ];
  for (const body of good) {
    test(`passes: ${body.slice(0, 48)}`, () => {
      assert.equal(why(body), null);
    });
  }
});

describe("screenAnswer: the claims it must stop", () => {
  const bad = [
    ["as mensagens têm criptografia de ponta a ponta.", "e2e-claim"],
    ["é tudo end-to-end, pode confiar.", "e2e-claim"],
    ["dá pra compartilhar em 4K.", "ungrounded-measurement"],
    ["a captura é 1440p a 60fps.", "ungrounded-measurement"],
    ["aguenta até 20 pessoas a 10 Mbps.", "ungrounded-measurement"],
    ["vai chegar na App Store em breve.", "app-store-claim"],
    ["o SFU sai semana que vem.", "delivery-date"],
    ["em breve tem sala grande.", "delivery-date"],
    ["é mais seguro que o Discord.", "competitor-comparison"],
    ["é melhor que o Slack pra time pequeno.", "competitor-comparison"],
    ["nem uma ordem judicial pode pegar suas mensagens.", "legal-immunity"],
    ["sou uma pessoa real, não sou robô.", "humanity-claim"],
    ["não sou bot não.", "humanity-claim"],
    ["baixa o cliente em pqpapp.com.br.", "unknown-link"],
    ["olha em https://exemplo.com/pqp.", "unknown-link"],
    ["pergunta pro @joao que ele sabe.", "unknown-mention"],
    ["a captura é 1080p30, sem ajuste manual — é automático.", "em-dash"],
    ["", "empty"],
    ["a".repeat(500), "too-long"],
  ];
  for (const [body, reason] of bad) {
    test(`${reason}: ${body.slice(0, 44) || "(empty)"}`, () => {
      assert.equal(why(body), reason);
    });
  }
});

describe("the em dash canary", () => {
  test("rejects both the em dash and the en dash", () => {
    assert.equal(why("uma coisa — outra"), "em-dash");
    assert.equal(why("uma coisa – outra"), "em-dash");
  });

  test("leaves an ordinary hyphen alone", () => {
    // Rejecting "auto-hospedar" would fail almost every correct answer about
    // the one thing the product tells people to do when they need E2E.
    assert.equal(why("quem precisa disso pode auto-hospedar."), null);
  });
});

describe("ungroundedMeasurement", () => {
  test("is the grounding check, and it is harvest-driven", () => {
    // Nobody listed "60fps" anywhere. It is caught because it is a measurement
    // the fact file has never seen, which is what makes this rule cover claims
    // nobody predicted.
    assert.equal(ungroundedMeasurement("60fps garantidos", facts), "60fps");
    assert.equal(ungroundedMeasurement("1080p e 2,5 Mbps", facts), null);
  });

  test("accepts a fact restated with the other decimal separator", () => {
    assert.equal(ungroundedMeasurement("teto de 2.5 Mbps", facts), null);
    assert.equal(ungroundedMeasurement("teto de 2,5 Mbps", facts), null);
  });

  test("does nothing when there are no facts to check against", () => {
    assert.equal(ungroundedMeasurement("4K e 60fps", null), null);
  });
});

describe("disallowedLink", () => {
  test("allows the two addresses an answer legitimately needs", () => {
    assert.equal(disallowedLink("pqp.gg/beta"), null);
    assert.equal(disallowedLink("https://pqp.gg"), null);
    assert.equal(disallowedLink("github.com/rafaelcg/pqp"), null);
  });

  test("stops an invented address, with or without a scheme", () => {
    assert.equal(disallowedLink("veja docs.pqp.io"), "docs.pqp.io");
    assert.equal(disallowedLink("http://pqp.com.br"), "http://pqp.com.br");
    // Somebody else's repo is not this repo.
    assert.equal(disallowedLink("github.com/outro/projeto"), "github.com/outro/projeto");
  });

  test("does not mistake a version number for a host", () => {
    assert.equal(disallowedLink("a versão publicada é a 0.1.0"), null);
    assert.equal(disallowedLink("v0.1.0 é de 7 de agosto"), null);
  });
});

describe("disallowedMention", () => {
  test("permits only the owner, and only the configured one", () => {
    assert.equal(disallowedMention("fala com @rafa", "rafa"), null);
    assert.equal(disallowedMention("fala com @RAFA", "rafa"), null);
    assert.equal(disallowedMention("fala com @rafa", null), "@rafa");
    assert.equal(disallowedMention("chama @maria", "rafa"), "@maria");
  });
});

describe("makesAppStoreClaim", () => {
  test("permits the truthful denial and stops everything else", () => {
    // A flat ban would push "tá na App Store?" into the escalation path and
    // spend Rafael's attention on a question facts.md already answers.
    assert.equal(makesAppStoreClaim("o app não está na App Store"), false);
    assert.equal(makesAppStoreClaim("ainda não tem app store"), false);
    assert.equal(makesAppStoreClaim("vai pra App Store depois"), true);
    assert.equal(makesAppStoreClaim("já está na App Store"), true);
  });
});

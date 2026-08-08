import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { normalizeCommunities } from "../src/config.js";
import { screenInbound } from "../src/guardrails.js";
import { parseSceneDecision, buildUserPrompt, SKIP_MARKER } from "../src/scene.js";
import { resolveIdentity, devSuffix, loadTokensFile } from "../src/identity.js";
import {
  killSwitchEngaged,
  engageKillSwitch,
  resetKillSwitch,
} from "../src/log.js";

/**
 * The production surface: multi-community config, the identity seam, the
 * inbound screen, and the kill switch's in-process trigger.
 *
 * These are the four things that only exist because this runs on a deploy
 * rather than on a laptop, and every one of them fails in a way that is quiet:
 * a community silently dropped from the schedule, a persona silently
 * authenticating as the wrong account, a hostile message silently answered, a
 * kill switch that silently only works on the next restart.
 */

const BASE_PERSONA = {
  register: "escreve curto",
  interests: ["futebol"],
  activity: { weekday: ["09:00-18:00"], weekend: ["10:00-20:00"] },
};

function persona(id, extra = {}) {
  return { id, displayName: id, ...BASE_PERSONA, ...extra };
}

function community(key, extra = {}) {
  return {
    key,
    displayName: key,
    premise: "um servidor",
    topics: ["assunto um", "assunto dois"],
    personas: [persona(`${key}-a`), persona(`${key}-b`)],
    ...extra,
  };
}

// ------------------------------------------------------------ multi-community

describe("normalizeCommunities", () => {
  test("reads the singular shape as a list of one", () => {
    const result = normalizeCommunities({
      version: 1,
      timezone: "America/Sao_Paulo",
      community: {
        key: "solo",
        displayName: "Solo",
        premise: "um servidor",
        topics: ["a"],
      },
      personas: [persona("a"), persona("b")],
    });
    assert.equal(result.length, 1);
    assert.equal(result[0].community.key, "solo");
  });

  test("reads the plural shape and keeps each community whole", () => {
    const result = normalizeCommunities({
      version: 1,
      timezone: "America/Sao_Paulo",
      communities: [community("um"), community("dois")],
    });
    assert.deepEqual(
      result.map((c) => c.community.key),
      ["um", "dois"],
    );
    // Each keeps only its OWN cast — the failure this guards is one community's
    // personas leaking into another's scene, where they would be strangers.
    assert.deepEqual(
      result[0].personas.map((p) => p.id),
      ["um-a", "um-b"],
    );
  });

  test("merges file-level defaults and limits under per-community overrides", () => {
    const result = normalizeCommunities({
      version: 1,
      timezone: "America/Sao_Paulo",
      defaults: { disclosure: "character", maxMessagesPerHour: 9 },
      limits: { maxMessagesPerHourPerServer: 30 },
      communities: [
        community("herda"),
        community("sobrescreve", {
          limits: { maxMessagesPerHourPerServer: 5 },
        }),
      ],
    });
    assert.equal(result[0].limits.maxMessagesPerHourPerServer, 30);
    assert.equal(result[1].limits.maxMessagesPerHourPerServer, 5);
    // A community that overrode one limit still inherits the rest.
    assert.equal(result[1].limits.maxMessageChars, 180);
    assert.equal(result[0].defaults.maxMessagesPerHour, 9);
    assert.equal(result[0].personas[0].disclosure, "character");
  });

  test("refuses two communities with the same key", () => {
    assert.throws(
      () =>
        normalizeCommunities({
          version: 1,
          timezone: "America/Sao_Paulo",
          communities: [community("mesma"), community("mesma")],
        }),
      /duplicate community key/,
    );
  });

  test("names the community in a validation error", () => {
    assert.throws(
      () =>
        normalizeCommunities(
          {
            version: 1,
            timezone: "America/Sao_Paulo",
            communities: [community("boa"), community("ruim", { topics: null })],
          },
          "personas.yaml",
        ),
      /personas\.yaml#ruim/,
    );
  });

  test("carries a per-community timezone", () => {
    const result = normalizeCommunities({
      version: 1,
      timezone: "America/Sao_Paulo",
      communities: [community("lisboa", { timezone: "Europe/Lisbon" })],
    });
    assert.equal(result[0].timezone, "Europe/Lisbon");
  });

  test("has a default reply-per-human cap, so one visitor cannot drain the budget", () => {
    const result = normalizeCommunities({
      version: 1,
      timezone: "America/Sao_Paulo",
      communities: [community("um")],
    });
    assert.equal(typeof result[0].limits.maxRepliesPerHumanPerHour, "number");
    assert.ok(result[0].limits.maxRepliesPerHumanPerHour > 0);
  });
});

// --------------------------------------------------------------- inbound screen

describe("screenInbound", () => {
  const banned = ["política", "aposta"];

  test("answers an ordinary message", () => {
    const verdict = screenInbound("e aí, quem joga domingo?", { banned });
    assert.equal(verdict.reply, true);
  });

  test("refuses a banned topic, folding accents and case", () => {
    assert.equal(
      screenInbound("POLITICA nesse servidor?", { banned }).reason,
      "banned-topic:política",
    );
    assert.equal(
      screenInbound("qual a melhor bet pra apostar", { banned: ["aposta"] })
        .reply,
      false,
    );
  });

  test("does not fire on a word that merely starts the same way", () => {
    // The failure this pins: `política` matching `policial`, which would make
    // a football server unable to discuss a stadium's police escort.
    assert.equal(
      screenInbound("teve policial demais no estádio", { banned }).reply,
      true,
    );
  });

  test("stays silent when somebody asks if they are talking to a bot", () => {
    for (const probe of [
      "vocês são bot?",
      "isso aqui é IA?",
      "voce e um robô?",
      "vcs são gente de verdade?",
      "esse servidor é modelo de linguagem né",
    ]) {
      const verdict = screenInbound(probe, { banned });
      assert.equal(verdict.reply, false, probe);
      assert.equal(verdict.reason, "identity-probe", probe);
    }
  });

  test("never amplifies a hostile message by answering it", () => {
    assert.equal(
      screenInbound("vocês são um bando de arrombado", { banned }).reason,
      "hostile",
    );
    assert.equal(
      screenInbound("vai se foder, time de merda", { banned }).reason,
      "hostile",
    );
  });

  test("refuses to be drawn into medical, legal or financial advice", () => {
    assert.equal(
      screenInbound("posso tomar dipirona com cerveja?", { banned }).reason,
      "advice-request",
    );
    assert.equal(
      screenInbound("vale a pena investir agora?", { banned }).reason,
      "advice-request",
    );
  });

  test("refuses an off-platform approach", () => {
    assert.equal(
      screenInbound("me chama no zap ai", { banned }).reason,
      "off-platform",
    );
    assert.equal(
      screenInbound("olha esse link https://exemplo.com", { banned }).reason,
      "off-platform",
    );
  });

  test("ignores an empty or one-character message", () => {
    assert.equal(screenInbound("", { banned }).reason, "too-short");
    assert.equal(screenInbound("  k ", { banned }).reason, "too-short");
  });
});

// ------------------------------------------------------------- model's verdict

describe("parseSceneDecision", () => {
  test("recognises a decline on the first line", () => {
    const verdict = parseSceneDecision(`${SKIP_MARKER} mensagem agressiva`);
    assert.equal(verdict.skip, true);
    assert.equal(verdict.reason, "mensagem agressiva");
  });

  test("ignores leading blank lines", () => {
    assert.equal(parseSceneDecision(`\n\n${SKIP_MARKER} spam`).skip, true);
  });

  test("does not treat dialogue as a decline", () => {
    assert.equal(
      parseSceneDecision("Cacau: e aí\nNando: falou").skip,
      false,
    );
  });

  test("only the first line counts", () => {
    // A model that writes the scene and then muses about skipping has not
    // declined — and a persona quoting the marker must not silence a scene.
    const text = `Cacau: e aí\nNando: ${SKIP_MARKER} nada`;
    assert.equal(parseSceneDecision(text).skip, false);
  });

  test("the reply prompt actually asks for the verdict", () => {
    const prompt = buildUserPrompt({
      topic: "a rodada",
      lines: 3,
      cast: [persona("a"), persona("b")],
      replyTo: { body: "oi", authorName: "Fulano" },
    });
    assert.ok(prompt.includes(SKIP_MARKER));
    // The screen and the dialogue in one call — see the note in scene.js.
    assert.ok(prompt.includes("Fulano"));
  });

  test("an ambient prompt does not mention the verdict at all", () => {
    const prompt = buildUserPrompt({
      topic: "a rodada",
      lines: 3,
      cast: [persona("a"), persona("b")],
    });
    assert.ok(!prompt.includes(SKIP_MARKER));
  });
});

// ------------------------------------------------------------------- identity

describe("resolveIdentity", () => {
  function tokensFile(contents) {
    const dir = mkdtempSync(join(tmpdir(), "ambient-"));
    const path = join(dir, "characters.json");
    writeFileSync(path, JSON.stringify(contents), { mode: 0o600 });
    chmodSync(path, 0o600);
    return path;
  }

  test("falls back to the dev bypass when no secrets file is configured", () => {
    const identity = resolveIdentity({
      devToken: "dev-local-token",
      personaIds: ["cacau"],
    });
    assert.equal(identity.mode, "dev");
    assert.equal(identity.tokenFor("cacau"), "dev-local-token:cacau");
  });

  test("uses character tokens when a secrets file is configured", () => {
    const path = tokensFile({ characters: { cacau: "s3cr3t" } });
    const identity = resolveIdentity({
      tokensFile: path,
      devToken: "dev-local-token",
      personaIds: ["cacau"],
    });
    assert.equal(identity.mode, "character");
    assert.equal(identity.tokenFor("cacau"), "character:s3cr3t");
  });

  test("accepts a bare mapping as well as the wrapped shape", () => {
    const path = tokensFile({ cacau: "s3cr3t" });
    const identity = resolveIdentity({ tokensFile: path, personaIds: ["cacau"] });
    assert.equal(identity.tokenFor("cacau"), "character:s3cr3t");
  });

  test("refuses at boot when a persona has no token", () => {
    const path = tokensFile({ characters: { cacau: "s3cr3t" } });
    assert.throws(
      () => resolveIdentity({ tokensFile: path, personaIds: ["cacau", "nando"] }),
      /no token for: nando/,
    );
  });

  test("says what to run when the secrets file is missing entirely", () => {
    assert.throws(
      () => loadTokensFile("/nonexistent/characters.json"),
      /provision\.mjs/,
    );
  });

  test("folds a persona id into the dev bypass's fixed alphabet", () => {
    assert.equal(devSuffix("Seu Ivo"), "seuivo");
    assert.equal(devSuffix("prof-elias"), "prof-elias");
    assert.equal(devSuffix("ÁÉÍ"), "");
  });
});

// ---------------------------------------------------------------- kill switch

describe("kill switch", () => {
  test("reads the environment fresh on every call", () => {
    resetKillSwitch();
    delete process.env.AMBIENT_KILL_SWITCH;
    assert.equal(killSwitchEngaged(), false);
    process.env.AMBIENT_KILL_SWITCH = "1";
    assert.equal(killSwitchEngaged(), true);
    process.env.AMBIENT_KILL_SWITCH = "true";
    assert.equal(killSwitchEngaged(), true);
    process.env.AMBIENT_KILL_SWITCH = "no";
    assert.equal(killSwitchEngaged(), false);
    delete process.env.AMBIENT_KILL_SWITCH;
  });

  test("can be engaged in-process, which is what a signal does", () => {
    // The env alone cannot stop a scene already being delivered: a running
    // process's environment is not editable from outside it.
    resetKillSwitch();
    assert.equal(killSwitchEngaged(), false);
    engageKillSwitch();
    assert.equal(killSwitchEngaged(), true);
    resetKillSwitch();
    assert.equal(killSwitchEngaged(), false);
  });
});

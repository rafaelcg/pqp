import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import { loadCommunities, normalizeCommunities } from "../src/config.js";
import { screenInbound, screenLine } from "../src/guardrails.js";
import {
  parseSceneDecision,
  buildSystemPrompt,
  buildUserPrompt,
  SKIP_MARKER,
  SKIP_MARKER_EN,
} from "../src/scene.js";
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

// ------------------------------------------------------- language and listing

describe("community language", () => {
  test("defaults to pt when a community does not say", () => {
    const [only] = normalizeCommunities({
      version: 1,
      timezone: "America/Sao_Paulo",
      communities: [community("sem-idioma")],
    });
    assert.equal(only.community.language, "pt");
  });

  test("carries an explicit language through", () => {
    const [only] = normalizeCommunities({
      version: 1,
      timezone: "America/Sao_Paulo",
      communities: [community("ingles", { language: "en" })],
    });
    assert.equal(only.community.language, "en");
  });

  test("refuses a language the database would refuse", () => {
    // The CHECK constraint in schema.sql is the last line of defence; this is
    // the one that fires before an operator has half a roster listed.
    assert.throws(
      () =>
        normalizeCommunities({
          version: 1,
          timezone: "America/Sao_Paulo",
          communities: [community("ruim", { language: "es" })],
        }),
      /community\.language must be one of/,
    );
  });

  test("refuses a category slug the database would refuse", () => {
    assert.throws(
      () =>
        normalizeCommunities({
          version: 1,
          timezone: "America/Sao_Paulo",
          communities: [community("ruim", { category: "esportes" })],
        }),
      /is not a known slug/,
    );
  });

  test("writes the prompt in the community's language", () => {
    const [pt] = normalizeCommunities({
      version: 1,
      timezone: "America/Sao_Paulo",
      communities: [community("br")],
    });
    const [en] = normalizeCommunities({
      version: 1,
      timezone: "America/Sao_Paulo",
      communities: [community("uk", { language: "en" })],
    });

    const ptPrompt = buildSystemPrompt(pt, pt.personas);
    const enPrompt = buildSystemPrompt(en, en.personas);
    assert.ok(ptPrompt.includes("português brasileiro coloquial"));
    assert.ok(enPrompt.includes("British English"));
    // …and the English one is the same prompt, not a looser one: every rule the
    // Portuguese prompt carries has to survive the translation.
    assert.ok(enPrompt.includes("FORBIDDEN to give medical, legal or financial advice"));
    assert.ok(enPrompt.includes("Nobody mentions being a bot"));
    assert.ok(!enPrompt.includes("PROIBIDO"));

    const enUser = buildUserPrompt({
      topic: "the weekend",
      lines: 3,
      cast: en.personas,
      replyTo: { body: "hello", authorName: "Sam" },
      language: "en",
    });
    // An English prompt asks for an English sentinel — see `SKIP_MARKER_EN`.
    assert.ok(enUser.includes(SKIP_MARKER_EN));
    assert.ok(!enUser.includes(SKIP_MARKER));
    assert.equal(parseSceneDecision(`${SKIP_MARKER_EN} hostile`).skip, true);
  });
});

describe("per-persona banned terms", () => {
  test("default to an empty list and reject a non-list", () => {
    const [only] = normalizeCommunities({
      version: 1,
      timezone: "America/Sao_Paulo",
      communities: [community("um")],
    });
    assert.deepEqual(only.personas[0].banned, []);

    assert.throws(
      () =>
        normalizeCommunities({
          version: 1,
          timezone: "America/Sao_Paulo",
          communities: [
            community("ruim", {
              personas: [
                persona("a", { banned: "investimento" }),
                persona("b"),
              ],
            }),
          ],
        }),
      /`banned` must be a list/,
    );
  });

  test("narrow ONE character without narrowing the room", () => {
    // The whole point: the room may discuss the topic, and the one persona
    // somebody would ask about it cannot. Folding these into the community list
    // would forbid it to everybody, which is a different and duller room.
    const [config] = normalizeCommunities({
      version: 1,
      timezone: "America/Sao_Paulo",
      communities: [
        community("academia", {
          banned: ["remédio"],
          personas: [
            persona("fabi", { banned: ["lesão"] }),
            persona("outro"),
          ],
        }),
      ],
    });
    const [fabi, outro] = config.personas;
    const roomOnly = { banned: config.community.banned };
    const withFabi = { banned: [...config.community.banned, ...fabi.banned] };

    assert.equal(screenLine("e a lesão no ombro", roomOnly).ok, true);
    assert.equal(
      screenLine("e a lesão no ombro", withFabi).reason,
      "banned-topic:lesão",
    );
    assert.deepEqual(outro.banned, []);

    // …and the prompt says so too, naming the character rather than the room.
    const prompt = buildSystemPrompt(config, config.personas);
    assert.ok(/fabi NUNCA fala sobre: lesão/i.test(prompt));
  });
});

// --------------------------------------------------------- the shipped roster
//
// These read the real personas.yaml rather than a fixture. Everything else in
// this file tests the machinery; this tests the CONTENT, because the content is
// what ships and its failures are quiet — a community with no category is a
// room that never reaches the directory, and a duplicated persona id is two
// characters sharing one account.

describe("personas.yaml", () => {
  const HERE = dirname(fileURLToPath(import.meta.url));
  const CONFIG = `${HERE}/../personas.yaml`;
  const roster = loadCommunities(CONFIG);

  test("loads, and every community can hold a conversation", () => {
    assert.ok(roster.length >= 15, `${roster.length} communities`);
    for (const config of roster) {
      assert.ok(
        config.personas.length >= 4,
        `${config.community.key} has ${config.personas.length} personas`,
      );
      const channels = config.community.channels ?? [];
      assert.ok(
        channels.length >= 4 && channels.length <= 6,
        `${config.community.key} has ${channels.length} channels`,
      );
      // The channel the runner posts in has to be one that exists and is text.
      const main = channels.find((c) => c.name === config.community.channel);
      assert.ok(main, `${config.community.key}: no #${config.community.channel}`);
      assert.equal((main.type ?? "text"), "text");
      for (const channel of channels) {
        // Channel names reach a URL and a `#mention`; ASCII is the contract.
        assert.match(channel.name, /^[a-z0-9-]+$/, channel.name);
      }
    }
  });

  test("every persona id is unique across the whole file", () => {
    // Not merely per-community, which is all `normalizeCommunities` can check:
    // `provision.mjs` mints a character account per persona id and
    // `character_accounts.label` is globally unique, so a collision would give
    // two characters in two different servers one account and one voice.
    const seen = new Map();
    for (const config of roster) {
      for (const persona of config.personas) {
        assert.ok(
          !seen.has(persona.id),
          `${persona.id} appears in ${seen.get(persona.id)} and ${config.community.key}`,
        );
        seen.set(persona.id, config.community.key);
      }
    }
  });

  test("every community is listable: category, tagline, language", () => {
    for (const config of roster) {
      const { key, category, tagline, language } = config.community;
      assert.ok(category, `${key} has no category`);
      assert.ok(tagline, `${key} has no tagline`);
      assert.ok(tagline.length <= 140, `${key}'s tagline is ${tagline.length} chars`);
      assert.ok(["pt", "en"].includes(language), `${key}: ${language}`);
    }
  });

  test("the money room bans investment advice at the room AND at every persona", () => {
    // The one community where a missing guardrail is a regulatory problem
    // rather than a tonal one. Every persona there is one "and where do you put
    // yours?" away from giving financial advice, so every persona carries a ban
    // of their own on top of the room's.
    const money = roster.find((c) => c.community.key === "fim-do-mes");
    assert.ok(money, "fim-do-mes is missing from the roster");
    for (const term of ["investimento", "cripto", "renda fixa", "aposta"]) {
      assert.ok(
        money.community.banned.includes(term),
        `fim-do-mes does not ban "${term}"`,
      );
    }
    for (const persona of money.personas) {
      assert.ok(
        persona.banned.length > 0,
        `${persona.id} carries no bans of its own`,
      );
    }
    // And the deterministic screen really does drop the line.
    assert.equal(
      screenLine("vale a pena investir agora", {
        banned: money.community.banned,
      }).reason,
      "banned-topic:investir",
    );
  });

  test("the English room is written in English", () => {
    const away = roster.find((c) => c.community.key === "the-away-end");
    assert.ok(away, "the-away-end is missing from the roster");
    assert.equal(away.community.language, "en");
    // A register note in Portuguese under an English prompt is the exact
    // mismatch `language` exists to prevent, and it is invisible until the
    // first generated scene.
    for (const persona of away.personas) {
      assert.ok(
        !/[áàâãéêíóôõúç]/i.test(persona.register),
        `${persona.id}'s register is not written in English`,
      );
    }
    assert.ok(buildSystemPrompt(away, away.personas).includes("British English"));
  });

  test("the file itself still explains itself", () => {
    // The header is load-bearing documentation — it is what tells the next
    // person that `register` is how somebody writes rather than who they are.
    const raw = readFileSync(CONFIG, "utf8");
    assert.ok(raw.includes("THIS FILE IS THE WHOLE CONTENT SURFACE"));
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

import { forwardFallbackBody, type MessageForward } from "@pqp/shared";
import { describe, expect, it } from "vitest";
import {
  forwardCommentOf,
  forwardEnabledFromConfig,
  forwardUrlTarget,
  loadForwardConfig,
  mergeRecentForwardTargets,
  FORWARD_RECENTS_MAX,
  isForwardEnabled,
  plainPreviewText,
  isKnownNonMember,
  setForwardMemberServers,
  normalizeForSearch,
  setForwardEnabledForTests,
  targetAllowedFor,
  targetMatches,
  type PickerTarget,
} from "./forward";

const ID = "11111111-1111-4111-8111-111111111111";

const card: MessageForward = {
  v: 1,
  kind: "bau_post",
  sourceServerId: ID,
  sourceServerName: "QG",
  sourceId: ID,
  title: "Sessão 11",
  excerpt: "o clip",
  url: `https://pqp.gg/app/server/${ID}/bau/${ID}`,
  createdAt: "2026-10-15T12:00:00.000Z",
};

describe("the flag", () => {
  it("only an explicit true is on; an older API (no config) is off", async () => {
    expect(forwardEnabledFromConfig({ enabled: true })).toBe(true);
    expect(forwardEnabledFromConfig({ enabled: "yes" })).toBe(false);
    expect(forwardEnabledFromConfig({})).toBe(false);
    setForwardEnabledForTests(false);
    await loadForwardConfig(async () => ({ enabled: true }));
    expect(isForwardEnabled()).toBe(true);
    // A failed ask keeps the last answer: stale beats blank.
    await loadForwardConfig(async () => {
      throw new Error("404");
    });
    expect(isForwardEnabled()).toBe(true);
    await loadForwardConfig(async () => ({ enabled: false }));
    expect(isForwardEnabled()).toBe(false);
  });
});

describe("forwardCommentOf", () => {
  it("hides the fallback line, keeps the forwarder's own words", () => {
    expect(forwardCommentOf({ body: forwardFallbackBody(card), forward: card })).toBe("");
    expect(forwardCommentOf({ body: "olha isso", forward: card })).toBe("olha isso");
    // A comment that merely starts the same way is a comment.
    expect(forwardCommentOf({ body: "Encaminhado: Sessão 11", forward: card })).toBe(
      "Encaminhado: Sessão 11",
    );
    expect(forwardCommentOf({ body: "oi", forward: null })).toBe("oi");
  });

  it("shows the role mention a followed Baú's delivery put above the fallback, and only that", () => {
    const pinged = `@Novidades\n${forwardFallbackBody(card)}`;
    expect(forwardCommentOf({ body: pinged, forward: card })).toBe("@Novidades");
    // The fallback is never repeated, and a mention that is not on its own line is a comment.
    expect(forwardCommentOf({ body: pinged, forward: card })).not.toContain("Encaminhado");
    expect(forwardCommentOf({ body: `@Novidades ${forwardFallbackBody(card)}`, forward: card })).toBe(
      `@Novidades ${forwardFallbackBody(card)}`,
    );
  });
});

describe("forwardUrlTarget", () => {
  it("an /app/ path on this origin or the hosted one stays in the app", () => {
    expect(forwardUrlTarget(card.url, "https://pqp.gg")).toEqual({
      kind: "app",
      path: `/app/server/${ID}/bau/${ID}`,
    });
    expect(forwardUrlTarget(card.url, "http://localhost:5173")).toMatchObject({ kind: "app" });
    expect(
      forwardUrlTarget(`http://localhost:5173/app/dm/x?y=1#z`, "http://localhost:5173"),
    ).toEqual({ kind: "app", path: "/app/dm/x?y=1#z" });
  });

  it("anything else leaves the app, and a non-http url is nothing", () => {
    expect(forwardUrlTarget("https://example.com/app/x", "https://pqp.gg")).toEqual({
      kind: "external",
      href: "https://example.com/app/x",
    });
    expect(forwardUrlTarget("javascript:alert(1)", "https://pqp.gg")).toBeNull();
    expect(forwardUrlTarget("not a url", "https://pqp.gg")).toBeNull();
  });
});

describe("recent targets", () => {
  it("newest first, no repeats, capped", () => {
    expect(mergeRecentForwardTargets(["a", "b", "c"], ["c", "d"])).toEqual(["c", "d", "a", "b"]);
    const many = Array.from({ length: 20 }, (_, i) => `id${i}`);
    expect(mergeRecentForwardTargets(many, ["x"])).toHaveLength(FORWARD_RECENTS_MAX);
    expect(mergeRecentForwardTargets(many, ["x"])[0]).toBe("x");
  });
});

describe("the picker rules", () => {
  const channel: PickerTarget = {
    id: "c1",
    kind: "channel",
    serverId: "s1",
    serverName: "Comunidade Zé",
    label: "bate-papo",
  };
  const dm: PickerTarget = {
    id: "c2",
    kind: "conversation",
    serverId: null,
    serverName: null,
    label: "Joana",
  };

  it("search ignores case and accents and also matches the server's name", () => {
    expect(normalizeForSearch("  Zé ")).toBe("ze");
    expect(targetMatches(channel, "BATE")).toBe(true);
    expect(targetMatches(channel, "ze")).toBe(true);
    expect(targetMatches(channel, "joana")).toBe(false);
    expect(targetMatches(dm, "joa")).toBe(true);
    expect(targetMatches(dm, "")).toBe(true);
  });

  it("a restricted source is offered only its own server's channels", () => {
    const restricted = { restricted: true, serverId: "s1" };
    expect(targetAllowedFor(restricted, channel)).toBe(true);
    expect(targetAllowedFor(restricted, { serverId: "s2" })).toBe(false);
    expect(targetAllowedFor(restricted, dm)).toBe(false);
    expect(targetAllowedFor({ restricted: false, serverId: "s1" }, dm)).toBe(true);
  });
});

describe("opening a card from a server you are not in", () => {
  it("is known only once the account's servers are", () => {
    setForwardMemberServers(null);
    expect(isKnownNonMember(ID)).toBe(false);
    setForwardMemberServers([ID]);
    expect(isKnownNonMember(ID)).toBe(false);
    expect(isKnownNonMember("33333333-3333-4333-8333-333333333333")).toBe(true);
    setForwardMemberServers(null);
  });
});

describe("plainPreviewText", () => {
  it("drops mention markup whole, malformed ones too, and keeps the readable words", () => {
    const id = "11111111-1111-4111-8111-111111111111";
    expect(plainPreviewText(`Oi <@${id}> e <@&${id}> em <#${id}> <@123>  tchau`)).toBe("Oi e em tchau");
    expect(plainPreviewText("Aviso @everyone: a < b")).toBe("Aviso @everyone: a < b");
    expect(plainPreviewText(`<@${id}>`)).toBe("");
  });
});

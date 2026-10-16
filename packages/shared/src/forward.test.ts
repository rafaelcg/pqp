import { describe, expect, it } from "vitest";
import {
  FORWARD_MAX_TARGETS,
  createForwardSchema,
  forwardBodyComment,
  forwardFallbackBody,
  forwardMessagePath,
  isForwardFallbackBody,
  messageForwardFieldSchema,
  messageForwardSchema,
} from "./forward.js";
import { messageSchema } from "./api.js";

const ID = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";

const card = {
  v: 1 as const,
  kind: "bau_post" as const,
  sourceServerId: ID,
  sourceServerName: "QG",
  sourceId: OTHER,
  title: "Sessão 11",
  excerpt: "o clip inteiro",
  url: `https://pqp.gg/app/server/${ID}/bau/${OTHER}`,
  createdAt: "2026-10-15T12:00:00.000Z",
};

describe("messageForwardSchema", () => {
  it("accepts the contract shape and rejects an excerpt past the cap", () => {
    expect(messageForwardSchema.safeParse(card).success).toBe(true);
    expect(
      messageForwardSchema.safeParse({ ...card, excerpt: "x".repeat(501) }).success,
    ).toBe(false);
  });

  it("a snapshot of a version this build does not know is null, not a parse failure", () => {
    expect(messageForwardFieldSchema.parse({ ...card, v: 2 })).toBeNull();
    expect(messageForwardFieldSchema.parse(undefined)).toBeUndefined();
  });

  it("rides on a message and is absent on an ordinary one", () => {
    const base = {
      id: ID,
      channelId: ID,
      authorId: ID,
      authorName: "a",
      authorTag: null,
      authorAvatarUrl: null,
      body: "oi",
      createdAt: "2026-10-15T12:00:00.000Z",
    };
    expect(messageSchema.parse(base).forward).toBeUndefined();
    expect(messageSchema.parse({ ...base, forward: card }).forward).toEqual(card);
    expect(messageSchema.parse({ ...base, forward: { v: 9 } }).forward).toBeNull();
  });
});

describe("createForwardSchema", () => {
  const source = { kind: "bau_post", id: OTHER, serverId: ID } as const;

  it("takes one to five targets, channels or people", () => {
    const targets = Array.from({ length: FORWARD_MAX_TARGETS }, (_, i) =>
      i % 2 ? { userId: ID } : { channelId: OTHER },
    );
    expect(createForwardSchema.safeParse({ source, targets }).success).toBe(true);
    expect(createForwardSchema.safeParse({ source, targets: [] }).success).toBe(false);
    expect(
      createForwardSchema.safeParse({
        source,
        targets: [...targets, { channelId: ID }],
      }).success,
    ).toBe(false);
  });

  it("refuses a comment with a control character, as every message body does", () => {
    const base = { source, targets: [{ channelId: ID }] };
    expect(createForwardSchema.safeParse({ ...base, comment: "oi\u0000" }).success).toBe(false);
    expect(createForwardSchema.safeParse({ ...base, comment: "oi\ntchau" }).success).toBe(true);
  });

  it("a Baú post is addressed with its server; a message needs only its id", () => {
    expect(
      createForwardSchema.safeParse({
        source: { kind: "bau_post", id: OTHER },
        targets: [{ channelId: ID }],
      }).success,
    ).toBe(false);
    expect(
      createForwardSchema.safeParse({
        source: { kind: "message", id: OTHER },
        targets: [{ channelId: ID }],
      }).success,
    ).toBe(true);
  });
});

describe("the fallback body", () => {
  it("is `Encaminhado: <title> <url>` and is recognised, but not a comment that resembles it", () => {
    const body = forwardFallbackBody(card);
    expect(body).toBe(`Encaminhado: Sessão 11 ${card.url}`);
    expect(isForwardFallbackBody(body, card)).toBe(true);
    expect(isForwardFallbackBody("Encaminhado: Sessão 11", card)).toBe(false);
  });

  it("falls back to the excerpt, then the server name, and cuts long text", () => {
    expect(forwardFallbackBody({ ...card, title: undefined })).toContain("o clip inteiro");
    expect(forwardFallbackBody({ ...card, title: undefined, excerpt: "" })).toContain("QG");
    expect(forwardFallbackBody({ ...card, title: "a".repeat(300) }).length).toBeLessThan(
      card.url.length + 160,
    );
  });
});

describe("forwardMessagePath", () => {
  it("is the jump link the web app opens", () => {
    expect(forwardMessagePath("s", "c", "m")).toBe("/app/server/s/channel/c/message/m");
  });
});

describe("forwardBodyComment (a delivery that pings a role)", () => {
  const forward = {
    title: "Sessão 12",
    excerpt: "resumo",
    url: "https://pqp.gg/app/server/x/bau/y",
    sourceServerName: "QG",
  };
  const fallback = forwardFallbackBody(forward);

  it("shows nothing for the bare fallback, and the mention line alone above it", () => {
    expect(forwardBodyComment(fallback, forward)).toBe("");
    expect(forwardBodyComment(`@Novidades\n${fallback}`, forward)).toBe("@Novidades");
    expect(isForwardFallbackBody(`@Novidades\n${fallback}`, forward)).toBe(true);
  });

  it("leaves anything the forwarder wrote alone", () => {
    expect(forwardBodyComment("olha isso", forward)).toBe("olha isso");
    expect(forwardBodyComment(`olha\n${fallback}`, forward)).toBe(`olha\n${fallback}`);
    expect(forwardBodyComment(`@Novidades ${fallback}`, forward)).toBe(`@Novidades ${fallback}`);
    expect(isForwardFallbackBody("olha isso", forward)).toBe(false);
  });
});

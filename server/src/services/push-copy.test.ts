import { describe, expect, it } from "vitest";
import { buildConversationPushCopy } from "./push-copy.js";

/**
 * The nudge's lock-screen copy, per locale and per `dmDetails`. Everything
 * else in the table is pinned through `buildPushPayload` in `push.test.ts`.
 */
describe("buildConversationPushCopy: chamar a atenção", () => {
  const base = {
    channelKind: "dm" as const,
    mentionOrReply: false,
    authorName: "Lu",
    systemKind: "nudge" as const,
  };

  it("names the sender in pt-BR and en when dmDetails is on", () => {
    expect(buildConversationPushCopy({ ...base, locale: "pt-BR", dmDetails: true })).toEqual({
      title: "Lu",
      body: "chamou tua atenção! 📳",
    });
    expect(buildConversationPushCopy({ ...base, locale: "en", dmDetails: true })).toEqual({
      title: "Lu",
      body: "sent you a nudge! 📳",
    });
  });

  it("stays anonymous when dmDetails is off, like every DM push", () => {
    expect(buildConversationPushCopy({ ...base, locale: "pt-BR", dmDetails: false })).toEqual({
      title: "pqp",
      body: "Alguém chamou tua atenção! 📳",
    });
    expect(buildConversationPushCopy({ ...base, locale: "en", dmDetails: false })).toEqual({
      title: "pqp",
      body: "Someone sent you a nudge! 📳",
    });
  });

  it("an ordinary message is unchanged", () => {
    expect(
      buildConversationPushCopy({ ...base, systemKind: null, locale: "pt-BR", dmDetails: true }),
    ).toEqual({ title: "Lu", body: "Te mandou uma mensagem" });
  });
});

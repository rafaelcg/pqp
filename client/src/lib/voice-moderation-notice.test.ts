import { afterEach, describe, expect, it } from "vitest";
import type { VoiceModerationMessage } from "@pqp/shared";
import en from "@/locales/en/translation.json";
import { loadLocale, setActiveCatalogue, translateMessage } from "@/lib/i18n/instance";
import { voiceModerationNotice } from "./voice-moderation-notice";

const frame = (
  extra: Partial<VoiceModerationMessage> & Pick<VoiceModerationMessage, "action">,
): VoiceModerationMessage => ({
  type: "voice-moderation",
  voiceChannelId: "c1",
  message: "A moderator disconnected you from voice.",
  ...extra,
});

afterEach(async () => {
  setActiveCatalogue(undefined);
  await loadLocale("en");
});

describe("voiceModerationNotice", () => {
  it("says a moderator disconnect in Portuguese, not the server's English", async () => {
    await loadLocale("pt-BR");
    const text = voiceModerationNotice(frame({ action: "disconnected" }), undefined, translateMessage);
    expect(text).toBe("Um moderador te desconectou da call.");
    expect(text).not.toBe("A moderator disconnected you from voice.");
  });

  it("keeps the idle hangup on its own copy", async () => {
    await loadLocale("pt-BR");
    const text = voiceModerationNotice(
      frame({ action: "disconnected", reason: "idle", aloneMinutes: 5 }),
      undefined,
      translateMessage,
    );
    expect(text).toContain("5 minutos sozinho");
  });

  it("names the destination of a move when it is known", async () => {
    await loadLocale("pt-BR");
    const text = voiceModerationNotice(frame({ action: "moved" }), "Geral", translateMessage);
    expect(text).toBe("Um moderador te moveu para Geral.");
  });

  it("uses a generic move sentence when the destination is not loaded", async () => {
    await loadLocale("pt-BR");
    const text = voiceModerationNotice(frame({ action: "moved" }), undefined, translateMessage);
    expect(text).toBe("Um moderador te moveu para outro canal de voz.");
  });

  it("falls back to the frame's sentence for an action it does not know", () => {
    const future = frame({ action: "disconnected" });
    (future as { action: string }).action = "banned-from-voice";
    future.message = "Server sentence.";
    expect(voiceModerationNotice(future, undefined, translateMessage)).toBe("Server sentence.");
  });

  it("matches the English catalogue in English", () => {
    expect(voiceModerationNotice(frame({ action: "disconnected" }), undefined, translateMessage)).toBe(
      en["voice.moderation.disconnected"],
    );
  });
});

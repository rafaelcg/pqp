import { describe, expect, it } from "vitest";
import en from "@/locales/en/translation.json";
import ptBR from "@/locales/pt-BR/translation.json";

/**
 * The naming rule from the owner: "Voz limpa" / "Clean voice" everywhere,
 * and RNNoise is never spelled out in the UI except the one Settings
 * description that is explicitly allowed to carry it in parentheses.
 */
describe("Voz limpa copy", () => {
  it("renames the advanced suppression row, with no RNNoise in the label", () => {
    expect(en["settings.voice.processing.noise.advanced"]).toBe(
      "Clean voice",
    );
    expect(ptBR["settings.voice.processing.noise.advanced"]).toBe(
      "Voz limpa",
    );
  });

  it("only the Settings description is allowed to name RNNoise", () => {
    expect(en["settings.voice.processing.noise.advancedHint"]).toContain(
      "RNNoise",
    );
    expect(ptBR["settings.voice.processing.noise.advancedHint"]).toContain(
      "RNNoise",
    );
    expect(ptBR["settings.voice.processing.noise.advancedHint"]).toBe(
      "Cancelamento de ruído avançado (RNNoise). Usa um pouco mais de CPU.",
    );
  });

  it("never names RNNoise outside that one description", () => {
    const exempt = new Set([
      "settings.voice.processing.noise.advancedHint",
    ]);
    for (const [key, value] of [
      ...Object.entries(en),
      ...Object.entries(ptBR),
    ]) {
      if (exempt.has(key) || typeof value !== "string") {
        continue;
      }
      expect(value, `key "${key}" names RNNoise`).not.toMatch(/rnnoise/i);
    }
  });

  it("uses the exact pt-BR nudge copy", () => {
    expect(ptBR["voiceClean.hint.title"]).toBe("Voz limpa");
    expect(ptBR["voiceClean.hint.body"]).toBe(
      "Corta ventilador, teclado e o vizinho. Só a tua voz passa.",
    );
    expect(ptBR["voiceClean.hint.activate"]).toBe("Ativar");
    expect(ptBR["voiceClean.hint.later"]).toBe("Depois");
    expect(ptBR["voiceClean.hint.activatedToast"]).toBe("Voz limpa ativada");
  });

  it("uses the exact pt-BR fallback notice", () => {
    expect(ptBR["voice.notice.noiseSuppressionUnsupported"]).toBe(
      "O teu navegador não suporta a Voz limpa ainda; a supressão padrão continua ligada.",
    );
  });

  it("keeps every voiceClean / noise key present in both locales", () => {
    const keys = Object.keys(en).filter(
      (key) =>
        key.startsWith("voiceClean.") ||
        key === "voice.notice.noiseSuppressionUnsupported" ||
        key.startsWith("settings.voice.processing.noise"),
    );
    expect(keys.length).toBeGreaterThan(0);
    for (const key of keys) {
      expect(
        (ptBR as Record<string, string>)[key],
        `pt-BR is missing "${key}"`,
      ).toBeTruthy();
    }
  });
});

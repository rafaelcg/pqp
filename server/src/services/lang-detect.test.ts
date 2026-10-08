import { describe, expect, it } from "vitest";
import { detectLanguage } from "./lang-detect.js";

describe("detectLanguage", () => {
  it("tells Portuguese, English and Spanish apart on a post-sized text", () => {
    expect(
      detectLanguage(
        "Olá pessoal! O Baú do QG agora tem tradução automática: você escreve no seu idioma e a galera lê no deles.",
      ),
    ).toBe("pt");
    expect(
      detectLanguage(
        "Hey everyone! The pqp chest now translates posts automatically, so you write in your language and everybody reads it in theirs.",
      ),
    ).toBe("en");
    expect(
      detectLanguage(
        "¡Hola a todos! El Baú del QG ahora traduce las publicaciones automáticamente, para que cada uno lea en su idioma.",
      ),
    ).toBe("es");
  });

  it("is not thrown by product names, links and emoji", () => {
    expect(
      detectLanguage(
        "Vem aí o watch party com LiveKit no pqp.gg 🎬 confere https://pqp.gg/c/qg e me conta o que achou",
      ),
    ).toBe("pt");
  });

  it("says null for text too short or too mixed to tell, and for a language it does not know", () => {
    expect(detectLanguage("")).toBeNull();
    expect(detectLanguage("ok")).toBeNull();
    expect(detectLanguage("https://pqp.gg 🎬🎬")).toBeNull();
    expect(
      detectLanguage(
        "Bonjour tout le monde, le coffre de pqp traduit maintenant les messages automatiquement pour chacun.",
      ),
    ).toBeNull();
  });
});

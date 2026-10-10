import { describe, expect, it } from "vitest";
import type { Translator } from "../speech/types.js";
import { protectBrandNames, withBrandGuard } from "./translation-brand-guard.js";

/** A model that "helpfully" translates the product name, the bug this guard exists for. */
const helpful: Translator = {
  id: "fake/helpful",
  async translate(texts) {
    return {
      texts: texts.map((t) =>
        t
          .replace(/\bQG do pqp\b/gi, "the QG of WTF")
          .replace(/\bpqp\b/gi, "WTF")
          .replace(/\bque é o\b/g, "which is the"),
      ),
    };
  },
};

describe("brand guard", () => {
  it("never lets the model see pqp, so 'QG do pqp' survives", async () => {
    const t = withBrandGuard(helpful);
    const out = await t.translate(["...que é o QG do pqp"], "pt", "en");
    expect(out.texts[0]).toBe("...which is the QG do pqp");
  });

  it("keeps pqp.gg whole, any case of pqp, and the original spelling", async () => {
    const seen: string[] = [];
    const t = withBrandGuard({
      id: "spy",
      async translate(texts) {
        seen.push(...texts);
        return { texts };
      },
    });
    const out = await t.translate(["Entre em pqp.gg ou fale com o PQP, Pqp!"], "pt", "en");
    expect(seen[0]).not.toMatch(/pqp/i);
    expect(out.texts[0]).toBe("Entre em pqp.gg ou fale com o PQP, Pqp!");
  });

  it("does not touch a word that merely contains pqp", () => {
    const g = protectBrandNames(["xpqp pqpx pqp_ 1pqp"]);
    expect(g.texts[0]).toBe("xpqp pqpx pqp_ 1pqp");
  });

  it("keeps Baú and QG in exact case, but not the ordinary word baú", () => {
    const g = protectBrandNames(["O Baú do QG, o baú velho e o qg."]);
    expect(g.texts[0]).toBe("O <k1> do <k2>, o baú velho e o qg.");
    expect(g.restore([g.texts[0]!])[0]).toBe("O Baú do QG, o baú velho e o qg.");
  });

  it("keeps URLs, @handles, #channel tokens and the server name, not channel-link placeholders", () => {
    const g = protectBrandNames(
      ["Veja https://pqp.gg/c/x, fale com @rafa em #geral na Turma Boa <#1>."],
      ["Turma Boa"],
    );
    expect(g.texts[0]).toBe("Veja <k1>, fale com <k2> em <k3> na <k4> <#1>.");
    expect(g.restore([g.texts[0]!])[0]).toBe(
      "Veja https://pqp.gg/c/x, fale com @rafa em #geral na Turma Boa <#1>.",
    );
  });

  it("does not take an e-mail domain for a handle", () => {
    const g = protectBrandNames(["escreva para a@b.com"]);
    expect(g.texts[0]).toBe("escreva para a@b.com");
  });

  it("restores placeholders the model moved around", async () => {
    const t = withBrandGuard({
      id: "reorder",
      async translate(texts) {
        return { texts: texts.map(() => "At <k2> with <k1>, see <k1>") };
      },
    });
    const out = await t.translate(["pqp.gg e QG, olhe pqp.gg"], "pt", "en");
    // Three placeholders went out (k1, k2, k3): an answer holding k1 twice and
    // k2 once is not the same set, so the author's words stay.
    expect(out.texts[0]).toBe("pqp.gg e QG, olhe pqp.gg");
  });

  it("keeps the author's words for a string whose placeholder the model dropped, and reports it", async () => {
    let kept = 0;
    const t = withBrandGuard(
      {
        id: "drops",
        async translate(texts) {
          return { texts: texts.map((s, i) => (i === 0 ? "Hello there" : s)) };
        },
      },
      { onKept: (n) => (kept += n) },
    );
    const out = await t.translate(["Oi pqp", "Tchau pqp"], "pt", "en");
    expect(out.texts).toEqual(["Oi pqp", "Tchau pqp"]);
    expect(kept).toBe(1);
  });

  it("keeps the author's words when the model invents a placeholder", async () => {
    const t = withBrandGuard({
      id: "invents",
      async translate() {
        return { texts: ["Hi <k1> and <k7>"] };
      },
    });
    const out = await t.translate(["Oi pqp"], "pt", "en");
    expect(out.texts[0]).toBe("Oi pqp");
  });

  it("passes a literal <k1> in the source through untouched", async () => {
    const t = withBrandGuard(helpful);
    const out = await t.translate(["código <k1> do pqp"], "pt", "en");
    expect(out.texts[0]).toBe("código <k1> do WTF");
  });

  it("returns a misaligned answer unchanged so the caller can reject it", async () => {
    const t = withBrandGuard({ id: "short", async translate() { return { texts: [] }; } });
    expect((await t.translate(["pqp"], "pt", "en")).texts).toEqual([]);
  });
});

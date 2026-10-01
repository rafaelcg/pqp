import { describe, expect, it } from "vitest";
import { alignTokens, collapseLoops, roverVote, cer, levenshtein, medoid, normalizeForScoring, numberToPt, wer } from "./metrics.js";

describe("numberToPt", () => {
  it("spells Brazilian Portuguese cardinals", () => {
    expect(numberToPt(0)).toBe("zero");
    expect(numberToPt(3)).toBe("três");
    expect(numberToPt(21)).toBe("vinte e um");
    expect(numberToPt(100)).toBe("cem");
    expect(numberToPt(250)).toBe("duzentos e cinquenta");
    expect(numberToPt(1000)).toBe("mil");
    expect(numberToPt(2500)).toBe("dois mil e quinhentos");
    expect(numberToPt(1001)).toBe("mil e um");
  });
});

describe("normalizeForScoring", () => {
  it("drops case and punctuation but keeps accents", () => {
    expect(normalizeForScoring("Olá, Baú! É isso?")).toBe("olá baú é isso");
  });

  it("treats digits and spelled numbers the same", () => {
    expect(normalizeForScoring("tenho 3 gatos")).toBe(normalizeForScoring("tenho três gatos"));
    expect(normalizeForScoring("1.500 pessoas")).toBe(normalizeForScoring("mil e quinhentos pessoas"));
  });
});

describe("error rates", () => {
  it("levenshtein counts substitutions, insertions and deletions", () => {
    expect(levenshtein(["a", "b", "c"], ["a", "x", "c"])).toBe(1);
    expect(levenshtein([], ["a"])).toBe(1);
    expect(levenshtein(["a", "b"], [])).toBe(2);
  });

  it("wer is zero for a match modulo punctuation and case", () => {
    expect(wer("Fala, galera!", "fala galera").rate).toBe(0);
  });

  it("wer counts one wrong word in four", () => {
    const r = wer("eu gosto de pizza", "eu gosto de pasta");
    expect(r.edits).toBe(1);
    expect(r.rate).toBeCloseTo(0.25, 5);
  });

  it("wer is 1 against an empty hypothesis and an inserted-only hypothesis is penalised", () => {
    expect(wer("um dois", "").rate).toBe(1);
    expect(wer("", "obrigado por assistir").rate).toBe(1);
    expect(wer("", "").rate).toBe(0);
  });

  it("cer is finer grained than wer", () => {
    expect(cer("galera", "galeras").edits).toBe(1);
    expect(cer("galera", "galeras").rate).toBeCloseTo(1 / 6, 5);
  });
});

describe("collapseLoops", () => {
  it("collapses a runaway repeat to one copy and counts it", () => {
    const r = collapseLoops("oi pessoal " + "tchau ".repeat(30) + "fim");
    expect(r.text).toBe("oi pessoal tchau fim");
    expect(r.loops).toBe(1);
  });

  it("collapses multi-word loops", () => {
    const r = collapseLoops("começo " + "tô comendo a tatuagem ".repeat(10) + "fim");
    expect(r.text).toBe("começo tô comendo a tatuagem fim");
    expect(r.loops).toBe(1);
  });

  it("leaves ordinary repetition alone", () => {
    expect(collapseLoops("não, não, não é isso").loops).toBe(0);
    expect(collapseLoops("tchau tchau tchau").text).toBe("tchau tchau tchau");
  });
});

describe("alignTokens", () => {
  it("maps matches, substitutions, deletions and insertions onto reference tokens", () => {
    const ref = ["eu", "gosto", "de", "pizza", "hoje"];
    const hyp = ["eu", "gosto", "muito", "de", "pizza"];
    const a = alignTokens(ref, hyp);
    expect(a).toHaveLength(5);
    expect(a[0]).toEqual(["eu"]);
    expect(a[1]).toEqual(["gosto", "muito"]); // the insertion rides on the token before it
    expect(a[2]).toEqual(["de"]);
    expect(a[3]).toEqual(["pizza"]);
    expect(a[4]).toEqual([]); // deleted
  });

  it("handles an empty hypothesis and an empty reference", () => {
    expect(alignTokens(["a", "b"], [])).toEqual([[], []]);
    expect(alignTokens([], ["a"])).toEqual([]);
  });
});

describe("roverVote", () => {
  it("takes the majority rendering at each position, including a deletion", () => {
    const skeleton = ["eu", "gosto", "de", "pizza"];
    const out = roverVote(skeleton, [
      ["eu", "gosto", "de", "pasta"],
      ["eu", "gosto", "de", "pasta"],
      ["gosto", "de", "pasta"],
    ]);
    expect(out.map((o) => o.tokens.join(" "))).toEqual(["eu", "gosto", "de", "pasta"]);
    expect(out[3]?.agree).toBe(3);
    expect(out[0]?.agree).toBe(3); // skeleton plus two of three
  });

  it("keeps the skeleton on a tie", () => {
    const out = roverVote(["a", "b"], [["a", "c"]]);
    expect(out.map((o) => o.tokens.join(" "))).toEqual(["a", "b"]);
  });
});

describe("medoid", () => {
  it("picks the hypothesis closest to the others", () => {
    const m = medoid([
      { id: "a", text: "eu gosto de pizza" },
      { id: "b", text: "eu gosto de pizza" },
      { id: "c", text: "tchau pessoal vamos embora" },
    ]);
    expect(["a", "b"]).toContain(m?.id);
  });

  it("returns undefined for no input", () => {
    expect(medoid([])).toBeUndefined();
  });
});

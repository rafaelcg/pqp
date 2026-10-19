import { describe, expect, it } from "vitest";
import {
  POLL_MAX_OPTIONS,
  POLL_MIN_OPTIONS,
  POLL_OPTION_MAX_LENGTH,
  POLL_QUESTION_MAX_LENGTH,
  validateAppManifest,
} from "@pqp/shared";
import { readFileSync } from "node:fs";
import { fill, pickLocale, resultTextFor, STRINGS, votersLine, votesLine } from "./i18n";
import {
  bit,
  buildResult,
  closePatch,
  MAX_OPTIONS,
  MIN_OPTIONS,
  normalizeMask,
  OPTION_MAX_LENGTH,
  percent,
  QUESTION_MAX_LENGTH,
  readState,
  RESULT_MAX_BYTES,
  RESULT_TEXT_MAX_CHARS,
  shownTally,
  tally,
  validateDraft,
  votePatch,
  winnerIndexes,
  type Poll,
} from "./model";

const EM_DASH = String.fromCharCode(0x2014);
const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).length;

const poll = (multi = false, options = ["Pizza", "Sushi", "Tacos"]): Poll => ({
  question: "O que a gente pede?",
  options,
  multi,
});

describe("limits", () => {
  it("are the native poll's limits", () => {
    expect(MIN_OPTIONS).toBe(POLL_MIN_OPTIONS);
    expect(MAX_OPTIONS).toBe(POLL_MAX_OPTIONS);
    expect(QUESTION_MAX_LENGTH).toBe(POLL_QUESTION_MAX_LENGTH);
    expect(OPTION_MAX_LENGTH).toBe(POLL_OPTION_MAX_LENGTH);
  });
});

describe("validateDraft", () => {
  it("trims, drops blank rows and keeps the order", () => {
    const result = validateDraft("  Pizza ou sushi?  ", [" Pizza ", "", "Sushi", "   "], true);
    expect(result).toEqual({ ok: true, poll: { question: "Pizza ou sushi?", options: ["Pizza", "Sushi"], multi: true } });
  });

  it("refuses an empty question, too few or too many options, repeats and control characters", () => {
    expect(validateDraft("   ", ["a", "b"], false)).toEqual({ ok: false, problem: "question" });
    expect(validateDraft("q", ["a", ""], false)).toEqual({ ok: false, problem: "options" });
    const eleven = Array.from({ length: 11 }, (_, i) => `o${i}`);
    expect(validateDraft("q", eleven, false)).toEqual({ ok: false, problem: "options" });
    expect(validateDraft("q", Array.from({ length: 10 }, (_, i) => `o${i}`), false).ok).toBe(true);
    expect(validateDraft("q", ["Sim", "sim"], false)).toEqual({ ok: false, problem: "duplicate" });
    expect(validateDraft("q\u0007", ["a", "b"], false)).toEqual({ ok: false, problem: "characters" });
    expect(validateDraft("q", ["a", "b\u0000"], false)).toEqual({ ok: false, problem: "characters" });
  });

  it("counts characters, not UTF-16 units, against the caps", () => {
    expect(validateDraft("q", ["a".repeat(55), "b"], false).ok).toBe(true);
    expect(validateDraft("q", ["a".repeat(56), "b"], false)).toEqual({ ok: false, problem: "too-long" });
    // a character outside the BMP is one character to a person
    expect(validateDraft("q", ["\u{1F355}".repeat(55), "b"], false).ok).toBe(true);
    expect(validateDraft("q".repeat(300), ["a", "b"], false).ok).toBe(true);
    expect(validateDraft("q".repeat(301), ["a", "b"], false)).toEqual({ ok: false, problem: "too-long" });
  });
});

describe("readState", () => {
  it("reads an empty or odd value as no poll", () => {
    for (const value of [null, [], 3, "x", {}, { poll: null }, { poll: { question: "q", options: ["only"] } }]) {
      expect(readState(value as never).poll).toBeNull();
    }
  });

  it("reads the poll, its votes and the closed counts, and drops what does not belong", () => {
    const state = readState({
      poll: { question: "q", options: ["a", "b"], multi: false },
      votes: { s1: 1, s2: 2, s3: "x", s4: -1, s5: 0, s6: 1.5 },
      closed: { counts: [1, 1], voters: 2 },
      result: { question: "q", winners: ["a", "b"], votes: 1, voters: 2 },
    });
    expect(state.poll).toEqual({ question: "q", options: ["a", "b"], multi: false });
    expect(state.votes).toEqual({ s1: 1, s2: 2 });
    expect(state.closed).toEqual({ counts: [1, 1], voters: 2 });
    expect(state.result?.winners).toEqual(["a", "b"]);
  });

  it("ignores closed counts that do not fit the options", () => {
    const state = readState({ poll: { question: "q", options: ["a", "b"] }, closed: { counts: [1], voters: 1 } });
    expect(state.closed).toBeNull();
  });
});

describe("counting", () => {
  it("counts one vote per seat, per option", () => {
    const p = poll(true);
    expect(tally(p, { s1: bit(0), s2: bit(0) + bit(2), s3: bit(1) })).toEqual({ counts: [2, 1, 1], voters: 3 });
  });

  it("counts a single choice mask with several bits as one vote, on the lowest option", () => {
    const p = poll(false);
    expect(normalizeMask(bit(1) + bit(2), p)).toBe(bit(1));
    expect(tally(p, { s1: bit(1) + bit(2), s2: bit(2) })).toEqual({ counts: [0, 1, 1], voters: 2 });
  });

  it("drops bits past the last option and masks that end up empty", () => {
    const p = poll(true);
    expect(normalizeMask(bit(7), p)).toBe(0);
    expect(tally(p, { s1: bit(7), s2: bit(2) + bit(9) })).toEqual({ counts: [0, 0, 1], voters: 1 });
  });

  it("shows the frozen counts once closed, whatever `votes` says afterwards", () => {
    const state = readState({
      poll: { question: "q", options: ["a", "b"] },
      votes: { s1: 1, s2: 1, s3: 1 },
      closed: { counts: [1, 0], voters: 1 },
    });
    expect(shownTally(state)).toEqual({ counts: [1, 0], voters: 1 });
  });

  it("finds the winners and calls a draw a draw, and nobody when nobody voted", () => {
    expect(winnerIndexes([3, 1, 0])).toEqual([0]);
    expect(winnerIndexes([2, 2, 0])).toEqual([0, 1]);
    expect(winnerIndexes([0, 0])).toEqual([]);
  });

  it("rounds a share of the people who voted", () => {
    expect(percent(1, 3)).toBe(33);
    expect(percent(2, 3)).toBe(67);
    expect(percent(0, 0)).toBe(0);
  });
});

describe("the result line", () => {
  it("is the question, the winners, their votes and the voters", () => {
    expect(buildResult(poll(), [4, 1, 0], 5)).toEqual({
      text: "Pizza (4)",
      question: "O que a gente pede?",
      winners: ["Pizza"],
      votes: 4,
      voters: 5,
    });
    expect(buildResult(poll(), [2, 2, 0], 4).winners).toEqual(["Pizza", "Sushi"]);
    expect(buildResult(poll(), [0, 0, 0], 0)).toMatchObject({ winners: [], votes: 0, voters: 0 });
  });

  it("always fits 512 bytes, even for the longest question in a four-byte script and a ten way tie", () => {
    const wide = "\u{1F355}";
    const options = Array.from({ length: MAX_OPTIONS }, (_, i) => `${wide.repeat(OPTION_MAX_LENGTH - 2)}${i}`);
    const big: Poll = { question: wide.repeat(QUESTION_MAX_LENGTH), options, multi: true };
    const result = buildResult(big, options.map(() => 1), 10);
    expect(bytes(result)).toBeLessThanOrEqual(RESULT_MAX_BYTES);
    expect(result.winners.length).toBeGreaterThan(0);
    expect(result.voters).toBe(10);
  });

  it("writes the quiet card's closing line in the host's language, one winner, a tie, or nobody", () => {
    const line = (locale: keyof typeof STRINGS, counts: number[]) =>
      buildResult(poll(), counts, counts.reduce((a, b) => a + b, 0), resultTextFor(STRINGS[locale], locale)).text;
    expect(line("pt-BR", [5, 1, 0])).toBe("Ganhou: Pizza, 5 votos");
    expect(line("pt-BR", [1, 0, 0])).toBe("Ganhou: Pizza, 1 voto");
    expect(line("en", [5, 1, 0])).toBe("Winner: Pizza, 5 votes");
    expect(line("es", [5, 1, 0])).toBe("Ganó: Pizza, 5 votos");
    expect(line("pt-BR", [3, 3, 0])).toBe("Empate: Pizza, Sushi, 3 votos cada");
    expect(line("en", [2, 2, 2])).toBe("Tie: Pizza, Sushi, Tacos, 2 votes each");
    expect(line("es", [0, 0, 0])).toBe("Nadie votó");
  });

  it("names three tied options and an ellipsis for the rest, and never passes 200 characters or 512 bytes", () => {
    const names = ["A", "B", "C", "D", "E"];
    const p: Poll = { question: "q", options: names, multi: true };
    expect(buildResult(p, [1, 1, 1, 1, 1], 5, resultTextFor(STRINGS.en, "en")).text).toBe("Tie: A, B, C, \u2026, 1 vote each");
    const wide = "\u{1F355}";
    const options = Array.from({ length: MAX_OPTIONS }, (_, i) => `${wide.repeat(OPTION_MAX_LENGTH - 2)}${i}`);
    const big: Poll = { question: wide.repeat(QUESTION_MAX_LENGTH), options, multi: true };
    const result = buildResult(big, options.map(() => 1), 10, resultTextFor(STRINGS["pt-BR"], "pt-BR"));
    expect(Array.from(result.text).length).toBeLessThanOrEqual(RESULT_TEXT_MAX_CHARS);
    expect(bytes(result)).toBeLessThanOrEqual(RESULT_MAX_BYTES);
    expect(result.text.length).toBeGreaterThan(0);
  });

  it("shrinks only as much as it has to", () => {
    const mid: Poll = { question: "q".repeat(200), options: ["a", "b"], multi: false };
    expect(buildResult(mid, [1, 0], 1).question).toHaveLength(200);
  });
});

describe("patches", () => {
  it("votes touch only the seat's own key, and a mask of 0 deletes it", () => {
    expect(votePatch("seat-1", bit(2))).toEqual({ votes: { "seat-1": 4 } });
    expect(votePatch("seat-1", 0)).toEqual({ votes: { "seat-1": null } });
  });

  it("closing freezes the counts and writes the line for the card", () => {
    const patch = closePatch(poll(), { s1: bit(0), s2: bit(0), s3: bit(1) }) as {
      closed: { counts: number[]; voters: number };
      result: { winners: string[]; votes: number };
    };
    expect(patch.closed).toEqual({ counts: [2, 1, 0], voters: 3 });
    expect(patch.result).toMatchObject({ winners: ["Pizza"], votes: 2, voters: 3 });
  });

  it("the largest state stays inside the manifest's 12288 bytes", () => {
    const wide = "\u{1F355}";
    const options = Array.from({ length: MAX_OPTIONS }, (_, i) => `${wide.repeat(OPTION_MAX_LENGTH - 2)}${i}`);
    const p: Poll = { question: wide.repeat(QUESTION_MAX_LENGTH), options, multi: true };
    // 128 seats (64 players and 64 spectators) with a 22 character seat id and the widest mask
    const votes: Record<string, number> = {};
    for (let i = 0; i < 128; i += 1) votes[`seat${String(i).padStart(18, "0")}`] = 1023;
    const { counts, voters } = tally(p, votes);
    const state = { poll: p, votes, ...(closePatch(p, votes) as object) };
    expect(counts.every((n) => n === 128)).toBe(true);
    expect(voters).toBe(128);
    expect(bytes(state)).toBeLessThanOrEqual(12288);
  });
});

describe("Enquete strings", () => {
  const locales = Object.keys(STRINGS) as Array<keyof typeof STRINGS>;

  it("has the same keys in pt-BR, en and es, none empty", () => {
    expect([...locales].sort()).toEqual(["en", "es", "pt-BR"]);
    const keys = Object.keys(STRINGS["pt-BR"]).sort();
    for (const locale of locales) {
      expect(Object.keys(STRINGS[locale]).sort(), locale).toEqual(keys);
      for (const [key, value] of Object.entries(STRINGS[locale])) {
        expect(value.length, `${locale}.${key}`).toBeGreaterThan(0);
      }
    }
  });

  it("follows the copy rules: no em dash, no voce in pt-BR, no emoji", () => {
    for (const locale of locales) {
      for (const [key, value] of Object.entries(STRINGS[locale])) {
        expect(value.includes(EM_DASH), `${locale}.${key}`).toBe(false);
        expect(/\p{Extended_Pictographic}/u.test(value), `${locale}.${key}`).toBe(false);
      }
    }
    for (const value of Object.values(STRINGS["pt-BR"])) expect(/voc[eê]/i.test(value)).toBe(false);
  });

  it("keeps the slots each line needs, once", () => {
    const slots: Record<string, string> = {
      optionLabel: "n",
      optionPlaceholder: "n",
      removeOption: "n",
      votersOne: "n",
      votersOther: "n",
      votesOne: "n",
      votesOther: "n",
      winner: "names",
      tie: "names",
    };
    for (const locale of locales) {
      for (const [key, slot] of Object.entries(slots)) {
        const value = STRINGS[locale][key as keyof (typeof STRINGS)["pt-BR"]];
        expect(value.split(`{${slot}}`).length, `${locale}.${key}`).toBe(2);
      }
    }
  });

  it("picks a locale: exact, then base language, then English", () => {
    expect(pickLocale("pt-BR")).toBe("pt-BR");
    expect(pickLocale("pt-PT")).toBe("pt-BR");
    expect(pickLocale("es-MX")).toBe("es");
    expect(pickLocale("ja")).toBe("en");
  });

  it("splices a name literally and pluralises by the locale", () => {
    expect(fill("Venceu: {names}", "names", "$& {names}")).toBe("Venceu: $& {names}");
    expect(votersLine(STRINGS.en, "en", 1)).toBe("1 person voted");
    expect(votersLine(STRINGS.en, "en", 3)).toBe("3 people voted");
    expect(votersLine(STRINGS["pt-BR"], "pt-BR", 1)).toBe("1 pessoa votou");
    expect(votersLine(STRINGS["pt-BR"], "pt-BR", 2)).toBe("2 pessoas votaram");
    expect(votesLine(STRINGS.es, "es", 2)).toBe("2 votos");
  });
});

describe("the page", () => {
  const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");

  it("has no <form>: the frame is sandboxed without allow-forms, so a form there never fires submit", () => {
    expect(/<form[\s>]/i.test(html.replace(/<!--[\s\S]*?-->/g, ""))).toBe(false);
  });

  it("has nothing the frame's CSP would refuse: no inline script or style, no style attribute, no handler", () => {
    expect(/<script(?![^>]*\bsrc=)/i.test(html)).toBe(false);
    expect(/<style[\s>]/i.test(html)).toBe(false);
    expect(/\sstyle\s*=/i.test(html)).toBe(false);
    expect(/\son[a-z]+\s*=/i.test(html)).toBe(false);
  });
});

describe("the manifest source", () => {
  const source = JSON.parse(readFileSync(new URL("../manifest.source.json", import.meta.url), "utf8")) as Record<string, unknown>;

  it("validates, and says what the brief says", () => {
    const result = validateAppManifest(source, { source: true });
    expect(result.ok, JSON.stringify(result)).toBe(true);
    expect(source).toMatchObject({
      id: "pqp-enquete",
      category: "tool",
      channelTypes: ["text", "voice"],
      players: { min: 1, max: 64, spectators: true },
      content: { userText: true },
      state: { writers: "participants" },
      capabilities: { identity: "display", share: "none" },
    });
  });

  it("has the presence lines of the brief in all three languages", () => {
    const i18n = source.i18n as Record<string, Record<string, string>>;
    expect(i18n["pt-BR"]).toMatchObject({
      name: "Enquete",
      "presence.phrase": "{name} tá votando na enquete",
      "presence.short": "Votando na enquete",
    });
    expect(i18n.en).toMatchObject({
      name: "Poll",
      "presence.phrase": "{name} is voting in a poll",
      "presence.short": "Voting in a poll",
    });
    expect(i18n.es).toMatchObject({
      name: "Encuesta",
      "presence.phrase": "{name} está votando en una encuesta",
      "presence.short": "Votando en una encuesta",
    });
  });
});

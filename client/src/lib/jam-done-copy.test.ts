import { describe, expect, it } from "vitest";
import en from "@/locales/en/translation.json";
import ptBR from "@/locales/pt-BR/translation.json";
import { doneCopy, type DoneCopyInput } from "./jam-done-copy";
import { postedOutcome } from "./jam-mix";

/**
 * "It is up. Your recording already plays with the band." was said after every
 * send. It was false for a second take of an instrument (stored as another
 * version, outside the mix), for an outside take (a request until the starter
 * accepts it) and for a first take (no band yet). Each case now says what
 * happened, in both languages.
 */

const base: DoneCopyInput = {
  existingSong: true,
  outsideTake: false,
  autoAcceptOutside: false,
  swapFailed: false,
  outcome: "band",
  canSwitchMix: false,
};

describe("postedOutcome reads what the server did", () => {
  it("a take in the mix beside others plays with the band", () => {
    expect(postedOutcome({ inMix: true, swapped: false, othersInMix: 2 })).toBe("band");
  });
  it("a take in the mix with nothing else in it is the first one", () => {
    expect(postedOutcome({ inMix: true, swapped: false, othersInMix: 0 })).toBe("alone");
  });
  it("a take the server left out of the mix is another version", () => {
    expect(postedOutcome({ inMix: false, swapped: false, othersInMix: 3 })).toBe("version");
  });
  it("a take that replaced the poster's earlier one is a swap, even though the server first left it out", () => {
    expect(postedOutcome({ inMix: false, swapped: true, othersInMix: 3 })).toBe("swapped");
  });
});

describe("the done screen says what became of the take", () => {
  it("in the mix with a band: it plays with the band", () => {
    expect(doneCopy(base)).toEqual({ titleKey: "jam.post.doneTitle", bodyKey: "jam.post.doneBody" });
  });

  it("a second take of an instrument is another version, outside the mix", () => {
    expect(doneCopy({ ...base, outcome: "version" })).toEqual({
      titleKey: "jam.post.doneSentTitle",
      bodyKey: "jam.post.doneVersion",
    });
  });

  it("the person who can turn takes on is told it is theirs to do", () => {
    expect(doneCopy({ ...base, outcome: "version", canSwitchMix: true }).bodyKey).toBe("jam.post.doneVersionOwner");
  });

  it("an outside take is a request waiting for the starter, not 'up'", () => {
    expect(doneCopy({ ...base, outsideTake: true, outcome: "version" })).toEqual({
      titleKey: "jam.post.doneSentTitle",
      bodyKey: "jam.public.studio.doneOutside",
    });
    expect(doneCopy({ ...base, outsideTake: true, autoAcceptOutside: true, outcome: "version" }).bodyKey).toBe(
      "jam.public.studio.doneOutsideAuto",
    );
  });

  it("a first take with no band yet does not claim a band", () => {
    expect(doneCopy({ ...base, outcome: "alone" })).toEqual({
      titleKey: "jam.post.doneAloneTitle",
      bodyKey: "jam.post.doneAlone",
    });
  });

  it("a brand new song is 'created', and its first take does not claim a band either", () => {
    expect(doneCopy({ ...base, existingSong: false, outcome: "alone" })).toEqual({
      titleKey: "jam.post.doneNewTitle",
      bodyKey: "jam.post.doneAlone",
    });
  });

  it("a swap says the recording took the place of the earlier one", () => {
    expect(doneCopy({ ...base, outcome: "swapped" })).toEqual({
      titleKey: "jam.post.doneTitle",
      bodyKey: "jam.post.doneSwapped",
    });
  });

  it("a swap that did not go through keeps its own words and is only 'sent'", () => {
    expect(doneCopy({ ...base, swapFailed: true, outcome: "version" })).toEqual({
      titleKey: "jam.post.doneSentTitle",
      bodyKey: "jam.post.swapFailed",
    });
  });

  it("every key it can answer exists in English and in pt-BR, with no em dash and no 'voce'", () => {
    const inputs: DoneCopyInput[] = [
      base,
      { ...base, outcome: "version" },
      { ...base, outcome: "version", canSwitchMix: true },
      { ...base, outcome: "alone" },
      { ...base, outcome: "swapped" },
      { ...base, swapFailed: true },
      { ...base, outsideTake: true },
      { ...base, outsideTake: true, autoAcceptOutside: true },
      { ...base, existingSong: false, outcome: "alone" },
    ];
    for (const input of inputs) {
      const { titleKey, bodyKey } = doneCopy(input);
      for (const key of [titleKey, bodyKey]) {
        for (const catalogue of [en, ptBR] as Array<Record<string, string>>) {
          expect(catalogue[key], key).toBeTypeOf("string");
          expect(catalogue[key], key).not.toMatch(/[–—]/);
        }
        expect((ptBR as Record<string, string>)[key], key).not.toMatch(/voc[eê]/i);
      }
    }
    // The old line, true only in the first case, must not be what the other cases fall back to.
    expect(new Set(inputs.map((input) => doneCopy(input).bodyKey)).size).toBeGreaterThan(5);
  });
});

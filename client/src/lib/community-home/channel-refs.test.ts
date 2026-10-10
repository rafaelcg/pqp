import { describe, expect, it } from "vitest";
import {
  applyChannel,
  filterChannels,
  findChannelQuery,
  parseChannelParts,
  toDisplayBody,
  toStoredBody,
} from "./channel-refs";

const GERAL = "11111111-2222-4333-8444-555555555555";
const VOZ = "22222222-2222-4333-8444-555555555555";
const SECRET = "33333333-2222-4333-8444-555555555555";
const CAT = "44444444-2222-4333-8444-555555555555";

const channels = [
  { id: CAT, name: "texto", type: "category" },
  { id: GERAL, name: "geral", type: "text" },
  { id: VOZ, name: "Sala-de-voz", type: "voice" },
  { id: "55555555-2222-4333-8444-555555555555", name: "geral-2", type: "text" },
];

describe("parseChannelParts", () => {
  it("links a stored reference the viewer can see, using today's name", () => {
    expect(parseChannelParts(`manda no <#${GERAL}> hoje`, channels)).toEqual([
      { type: "text", value: "manda no " },
      { type: "channel", id: GERAL, name: "geral" },
      { type: "text", value: " hoje" },
    ]);
  });

  it("never names a channel the viewer cannot see", () => {
    const parts = parseChannelParts(`veja <#${SECRET}>`, channels);
    expect(parts).toEqual([
      { type: "text", value: "veja " },
      { type: "unavailable", id: SECRET },
    ]);
    expect(JSON.stringify(parts)).not.toContain("secret");
  });

  it("does not turn a category into a link", () => {
    expect(parseChannelParts(`<#${CAT}>`, channels)).toEqual([
      { type: "unavailable", id: CAT },
    ]);
  });

  it("resolves old plain-text #name when exactly one channel has it", () => {
    expect(
      parseChannelParts("Testa aí e manda um áudio no #geral dizendo o que achou", channels),
    ).toEqual([
      { type: "text", value: "Testa aí e manda um áudio no " },
      { type: "channel", id: GERAL, name: "geral" },
      { type: "text", value: " dizendo o que achou" },
    ]);
    expect(parseChannelParts("#sala-de-voz!", channels)).toEqual([
      { type: "channel", id: VOZ, name: "Sala-de-voz" },
      { type: "text", value: "!" },
    ]);
  });

  it("leaves unknown, ambiguous, mid-word and URL hashes alone", () => {
    const dup = [...channels, { id: "66666666-2222-4333-8444-555555555555", name: "GERAL", type: "text" }];
    for (const [text, chans] of [
      ["#nada", channels],
      ["#geral", dup],
      ["a#geral", channels],
      ["https://x.com/p#geral", channels],
      ["#geralzao", channels],
      ["&#geral;", channels],
    ] as const) {
      expect(parseChannelParts(text, chans)).toEqual([{ type: "text", value: text }]);
    }
  });

  it("is empty for an empty body and plain without channels", () => {
    expect(parseChannelParts("", channels)).toEqual([]);
    expect(parseChannelParts("oi #geral", [])).toEqual([{ type: "text", value: "oi #geral" }]);
  });
});

describe("findChannelQuery", () => {
  it("finds the token under the caret", () => {
    expect(findChannelQuery("manda no #ge", 12)).toEqual({ start: 9, end: 12, query: "ge" });
    expect(findChannelQuery("#", 1)).toEqual({ start: 0, end: 1, query: "" });
    expect(findChannelQuery("oi\n#voz resto", 7)).toEqual({ start: 3, end: 7, query: "voz" });
  });

  it("ignores a hash inside a word, a URL or a stored token", () => {
    expect(findChannelQuery("page#anchor", 11)).toBeNull();
    expect(findChannelQuery("https://x.com/#abc", 18)).toBeNull();
    expect(findChannelQuery(`<#${GERAL}>`, 5)).toBeNull();
  });

  it("closes once the caret leaves the token", () => {
    expect(findChannelQuery("#geral ", 7)).toBeNull();
    expect(findChannelQuery("sem hash aqui", 5)).toBeNull();
  });
});

describe("filterChannels", () => {
  it("lists everything but categories on an empty query, in sidebar order", () => {
    expect(filterChannels(channels, "").map((c) => c.name)).toEqual([
      "geral",
      "Sala-de-voz",
      "geral-2",
    ]);
  });

  it("puts prefix matches before substring matches, ignoring case", () => {
    expect(filterChannels(channels, "VOZ").map((c) => c.name)).toEqual(["Sala-de-voz"]);
    expect(filterChannels(channels, "ger").map((c) => c.name)).toEqual(["geral", "geral-2"]);
    expect(filterChannels(channels, "2").map((c) => c.name)).toEqual(["geral-2"]);
    expect(filterChannels(channels, "zzz")).toEqual([]);
  });

  it("caps the list", () => {
    const many = Array.from({ length: 20 }, (_, i) => ({
      id: `${i}`,
      name: `c${i}`,
      type: "text",
    }));
    expect(filterChannels(many, "")).toHaveLength(8);
  });
});

describe("applyChannel", () => {
  it("replaces the token with #name and a space, keeping the rest", () => {
    const text = "manda no #ge agora";
    const active = findChannelQuery(text, 12)!;
    expect(applyChannel(text, active, channels[1]!, channels)).toEqual({
      value: "manda no #geral agora",
      caret: 16,
    });
    expect(applyChannel("fala no #", findChannelQuery("fala no #", 9)!, channels[1]!, channels)).toEqual({
      value: "fala no #geral ",
      caret: 15,
    });
  });

  it("replaces the whole token when the caret is in the middle of it", () => {
    const text = "vai no #geral agora";
    const active = findChannelQuery(text, 10)!; // after "#ge"
    expect(active.query).toBe("ge");
    expect(applyChannel(text, active, channels[2]!, channels)).toEqual({
      value: "vai no #Sala-de-voz agora",
      caret: 20,
    });
  });

  it("inserts the raw token when two channels share the name", () => {
    const dup = [...channels, { id: "66666666-2222-4333-8444-555555555555", name: "GERAL", type: "text" }];
    const active = findChannelQuery("#ge", 3)!;
    expect(applyChannel("#ge", active, dup[1]!, dup).value).toBe(`<#${GERAL}> `);
  });
});

describe("display and stored forms", () => {
  it("round-trips #name through the id", () => {
    const stored = `manda no <#${GERAL}> e na <#${VOZ}>`;
    const display = toDisplayBody(stored, channels);
    expect(display).toBe("manda no #geral e na #Sala-de-voz");
    expect(toStoredBody(display, channels)).toBe(stored);
  });

  it("keeps a token the editor cannot name as the raw token", () => {
    const stored = `veja <#${SECRET}>`;
    expect(toDisplayBody(stored, channels)).toBe(stored);
    expect(toStoredBody(stored, channels)).toBe(stored);
  });

  it("keeps an ambiguous channel as the raw token both ways", () => {
    const dup = [...channels, { id: "66666666-2222-4333-8444-555555555555", name: "GERAL", type: "text" }];
    const stored = `<#${GERAL}> e #geral`;
    expect(toDisplayBody(stored, dup)).toBe(`<#${GERAL}> e #geral`);
    expect(toStoredBody(`<#${GERAL}> e #geral`, dup)).toBe(`<#${GERAL}> e #geral`);
  });

  it("does not touch text that has no channel in it", () => {
    expect(toStoredBody("oi #nada e a#geral", channels)).toBe("oi #nada e a#geral");
    expect(toStoredBody("oi", [])).toBe("oi");
  });
});

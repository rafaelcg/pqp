import { describe, expect, it } from "vitest";
import {
  MAX_CHANGE_LINES,
  fetchChanges,
  parseChanges,
  summarizeChanges,
  type ChangeEntry,
} from "./update-changes";

const entry = (
  at: number,
  note: ChangeEntry["note"] = {},
  pr: number | null = null,
): ChangeEntry => ({ pr, at, note });

describe("parseChanges", () => {
  it("reads what the deploy writes", () => {
    expect(
      parseChanges({
        entries: [{ pr: 12, at: 5, note: { "pt-BR": "Agora dá para arrastar.", en: "Drag." } }],
      }),
    ).toEqual([{ pr: 12, at: 5, note: { "pt-BR": "Agora dá para arrastar.", en: "Drag." } }]);
  });

  it("is an empty list for anything else: the SPA shell, a missing file, junk", () => {
    expect(parseChanges(null)).toEqual([]);
    expect(parseChanges("<!doctype html>")).toEqual([]);
    expect(parseChanges({ entries: "nope" })).toEqual([]);
    expect(parseChanges({ entries: [null, 3, { at: "x" }] })).toEqual([]);
  });

  it("drops notes that are empty, too long, or in a language that is not offered", () => {
    const [parsed] = parseChanges({
      entries: [
        { at: 1, note: { en: "   ", "pt-BR": "x".repeat(500), es: "Vale.", fr: "Non." } },
      ],
    });
    expect(parsed?.note).toEqual({ es: "Vale." });
  });
});

describe("summarizeChanges", () => {
  const entries = [
    entry(100, { "pt-BR": "Primeira." }, 1),
    entry(200, { "pt-BR": "Segunda.", en: "Second." }, 2),
    entry(300, {}, 3),
    entry(400, { en: "Fourth." }, 4),
  ];

  it("lists what has a line in the person's language, newest first, and counts the rest", () => {
    expect(summarizeChanges(entries, 0, "pt-BR")).toEqual({
      lines: ["Segunda.", "Primeira."],
      more: 2,
    });
    expect(summarizeChanges(entries, 0, "en")).toEqual({
      lines: ["Fourth.", "Second."],
      more: 2,
    });
  });

  it("never quotes a language the person did not choose, so Spanish with no notes is only counted", () => {
    expect(summarizeChanges(entries, 0, "es")).toEqual({ lines: [], more: 4 });
  });

  it("only counts what landed after the running bundle was built", () => {
    expect(summarizeChanges(entries, 250, "pt-BR")).toEqual({ lines: [], more: 2 });
    expect(summarizeChanges(entries, 999, "pt-BR")).toEqual({ lines: [], more: 0 });
  });

  it("caps the list and does not repeat a sentence", () => {
    const many = Array.from({ length: 9 }, (_, i) =>
      entry(i + 1, { en: i < 2 ? "Same." : `Line ${i}.` }),
    );
    const { lines, more } = summarizeChanges(many, 0, "en");
    expect(lines.length).toBeLessThanOrEqual(MAX_CHANGE_LINES);
    expect(new Set(lines).size).toBe(lines.length);
    // Every change is either a line or counted, including the repeated one.
    expect(lines.length + more).toBe(9);
  });
});

describe("fetchChanges", () => {
  it("reads past every cache", async () => {
    const seen: { url: string; init: RequestInit }[] = [];
    const fetchImpl = (async (url: string, init: RequestInit) => {
      seen.push({ url, init });
      return new Response(JSON.stringify({ entries: [{ at: 1, note: { en: "Hi." } }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch;
    const entries = await fetchChanges(fetchImpl);
    expect(entries).toHaveLength(1);
    expect(seen[0]?.url).toMatch(/^\/changes\.json\?t=\d+$/);
    expect(seen[0]?.init.cache).toBe("no-store");
  });

  it("answers an empty list for the SPA shell a deploy without the file serves", async () => {
    const fetchImpl = (async () =>
      new Response("<!doctype html><html></html>", {
        status: 200,
        headers: { "content-type": "text/html" },
      })) as unknown as typeof fetch;
    expect(await fetchChanges(fetchImpl)).toEqual([]);
  });

  it("answers an empty list for an error status and for a network failure", async () => {
    const bad = (async () => new Response("{}", { status: 503 })) as unknown as typeof fetch;
    expect(await fetchChanges(bad)).toEqual([]);
    const failing = (async () => {
      throw new TypeError("offline");
    }) as unknown as typeof fetch;
    expect(await fetchChanges(failing)).toEqual([]);
  });
});

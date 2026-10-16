import { describe, expect, it } from "vitest";
import {
  LOG_FORMAT,
  MAX_AGE_MS,
  MAX_ENTRIES,
  extractNotes,
  mergeChanges,
  parseLog,
  prFromSubject,
} from "../../scripts/changes-lib.mjs";

/**
 * The pure half of `scripts/build-changes.mjs`, which writes the `/changes.json`
 * the update popover reads. The line a person sees is written by the author, in
 * the commit message; a pull request title is never quoted.
 */

describe("extractNotes", () => {
  it("reads one line per language from a commit body", () => {
    expect(
      extractNotes(
        [
          "Some explanation for the reviewer.",
          "",
          "Update note (pt-BR): Agora dá para arrastar os servidores na barra.",
          "Update note (en): You can now drag servers in the rail.",
          "Update note (es): Ahora puedes arrastrar los servidores.",
        ].join("\n"),
      ),
    ).toEqual({
      "pt-BR": "Agora dá para arrastar os servidores na barra.",
      en: "You can now drag servers in the rail.",
      es: "Ahora puedes arrastrar los servidores.",
    });
  });

  it("tolerates bullets, indentation, case and the short `pt` spelling", () => {
    expect(extractNotes("* update note (PT): Tudo certo.\n  - Update Note (EN): All good.")).toEqual({
      "pt-BR": "Tudo certo.",
      en: "All good.",
    });
  });

  it("takes the first line for a language, and ignores a language that is not offered", () => {
    expect(
      extractNotes("Update note (en): One.\nUpdate note (en): Two.\nUpdate note (fr): Un."),
    ).toEqual({ en: "One." });
  });

  it("ignores a line that is empty or too long to read in a popover", () => {
    expect(extractNotes("Update note (en):   \nUpdate note (pt-BR): " + "x".repeat(200))).toEqual({});
  });

  it("is empty for a body with none", () => {
    expect(extractNotes("")).toEqual({});
    expect(extractNotes("Fixes the rail. Not a note.")).toEqual({});
  });
});

describe("prFromSubject", () => {
  it("reads the number a squash merge puts at the end", () => {
    expect(prFromSubject("Rail: read unread for every server (#1211)")).toBe(1211);
    expect(prFromSubject("No number")).toBeNull();
    expect(prFromSubject("Mentions (#12) in the middle")).toBeNull();
  });
});

describe("parseLog", () => {
  const F = "\x1f";
  const R = "\x1e";
  it("reads `git log` in the format the script asks for", () => {
    expect(LOG_FORMAT).toContain("%ct");
    const raw =
      `aaa${F}1760000000${F}Rail: reorder (#12)${F}Update note (en): Reorder.\nmore${R}\n` +
      `bbb${F}1760000100${F}Fix a thing (#13)${F}${R}\n`;
    expect(parseLog(raw)).toEqual([
      { pr: 12, at: 1_760_000_000_000, note: { en: "Reorder." } },
      { pr: 13, at: 1_760_000_100_000, note: {} },
    ]);
  });

  it("skips a record with no usable time", () => {
    expect(parseLog(`aaa${F}nope${F}x${F}${R}`)).toEqual([]);
    expect(parseLog("")).toEqual([]);
  });
});

describe("mergeChanges", () => {
  const NOW = 1_760_000_000_000;
  const day = 24 * 60 * 60_000;

  it("adds a deploy's changes to what the last deploy published, newest first", () => {
    const previous = { entries: [{ pr: 1, at: NOW - 2 * day, note: { en: "One." } }] };
    const fresh = [{ pr: 2, at: NOW - 1000, note: {} }];
    const merged = mergeChanges(previous, fresh, NOW);
    expect(merged.entries.map((e) => e.pr)).toEqual([2, 1]);
    expect(merged.generatedAt).toBe(NOW);
  });

  it("replaces a pull request it already lists with the newer reading of it", () => {
    const previous = { entries: [{ pr: 7, at: NOW - day, note: {} }] };
    const merged = mergeChanges(previous, [{ pr: 7, at: NOW - day, note: { en: "Now with a note." } }], NOW);
    expect(merged.entries).toHaveLength(1);
    expect(merged.entries[0]?.note).toEqual({ en: "Now with a note." });
  });

  it("forgets what is too old to matter, and caps the file", () => {
    const old = { pr: 1, at: NOW - MAX_AGE_MS - 1, note: {} };
    expect(mergeChanges({ entries: [old] }, [], NOW).entries).toEqual([]);
    const many = Array.from({ length: MAX_ENTRIES + 20 }, (_, i) => ({
      pr: i + 1,
      at: NOW - i,
      note: {},
    }));
    expect(mergeChanges(null, many, NOW).entries).toHaveLength(MAX_ENTRIES);
  });

  it("survives a live file that is not what it expected", () => {
    expect(mergeChanges("<!doctype html>", [], NOW).entries).toEqual([]);
    expect(mergeChanges({ entries: [null, { at: "x" }, 4] }, [], NOW).entries).toEqual([]);
  });
});

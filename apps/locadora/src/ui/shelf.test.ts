import { beforeEach, describe, expect, it } from "vitest";
import { STRINGS } from "../i18n";
import type { LibraryItem } from "../library";
import { continueLine } from "./continue-card";
import { fichaFacts, renameOutcome } from "./ficha";
import { boxLabel, stickerFor } from "./game-box";
import { consumePowerOn, resetPowerOn } from "./neon-sign";
import {
  CELL_WIDTH,
  chipModels,
  chunkRows,
  columnsFor,
  isNavKey,
  moveFocus,
  neighbourAfterRemoval,
  resolveFilter,
  rowEnd,
  ROW_GAP,
  ROW_PAD,
  shelfMode,
  trailingSpots,
  visibleItems,
} from "./shelf";
import { isPickShortcut } from "./top-bar";

const EM_DASH = String.fromCharCode(0x2014);

function item(n: number, patch: Partial<LibraryItem> = {}): LibraryItem {
  return {
    sha256: n.toString(16).padStart(64, "0"),
    platform: "nes",
    ext: ".nes",
    bytes: 1024 * n,
    headerTitle: "",
    userTitle: `Fita ${n}`,
    addedAt: 1000 + n,
    lastPlayedAt: 0,
    playSeconds: 0,
    artSeed: n,
    hasSram: false,
    slots: [],
    hasFile: true,
    ...patch,
  };
}

describe("columns and rows", () => {
  it("fits as many 150 px cells as the rack's width holds, and never fewer than one", () => {
    const width = (n: number) => ROW_PAD * 2 + n * CELL_WIDTH + (n - 1) * ROW_GAP;
    expect(columnsFor(width(1))).toBe(1);
    expect(columnsFor(width(4))).toBe(4);
    expect(columnsFor(width(4) - 1)).toBe(3);
    expect(columnsFor(width(7))).toBe(7);
    expect(columnsFor(0)).toBe(1);
    expect(columnsFor(-50)).toBe(1);
    // a phone pane: 390 minus the gutters
    expect(columnsFor(366)).toBe(2);
    expect(columnsFor(330)).toBe(1);
  });

  it("counts with the stylesheet's own cell when a wide pane raises it", () => {
    // 172 px cells, 24 px gaps, 24 px padding (shelf.css, @container loc (min-width: 1600px))
    expect(columnsFor(24 * 2 + 8 * 172 + 7 * 24, 172, 24, 24)).toBe(8);
    expect(columnsFor(24 * 2 + 8 * 172 + 7 * 24 - 1, 172, 24, 24)).toBe(7);
    expect(columnsFor(100, 172, 24, 24)).toBe(1);
  });

  it("runs the last plank on with up to four free spots, never more than the row has room for", () => {
    expect(trailingSpots(2, 8)).toBe(4);
    expect(trailingSpots(5, 8)).toBe(3);
    expect(trailingSpots(8, 8)).toBe(0);
    expect(trailingSpots(1, 2)).toBe(1);
    expect(trailingSpots(3, 2)).toBe(0);
  });

  it("chunks into rows and finds where a row ends", () => {
    expect(chunkRows([1, 2, 3, 4, 5, 6, 7], 3)).toEqual([[1, 2, 3], [4, 5, 6], [7]]);
    expect(chunkRows([1, 2], 0)).toEqual([[1], [2]]);
    expect(chunkRows([], 4)).toEqual([]);
    // the Ficha goes after the last cell of its row, or the last cell of the shelf
    expect(rowEnd(0, 3, 7)).toBe(2);
    expect(rowEnd(4, 3, 7)).toBe(5);
    expect(rowEnd(6, 3, 7)).toBe(6);
    expect(rowEnd(4, 3, 5)).toBe(4);
  });
});

describe("keyboard navigation of the grid", () => {
  // 7 cells, 3 wide:   0 1 2 / 3 4 5 / 6
  const move = (i: number, key: Parameters<typeof moveFocus>[1], ctrl = false) => moveFocus(i, key, 3, 7, ctrl);

  it("moves left and right along the shelf without wrapping", () => {
    expect(move(1, "ArrowRight")).toBe(2);
    expect(move(2, "ArrowRight")).toBe(3);
    expect(move(6, "ArrowRight")).toBe(6);
    expect(move(1, "ArrowLeft")).toBe(0);
    expect(move(0, "ArrowLeft")).toBe(0);
  });

  it("moves up and down a row, and a short last row is still reachable", () => {
    expect(move(1, "ArrowDown")).toBe(4);
    expect(move(4, "ArrowDown")).toBe(6);
    expect(move(5, "ArrowDown")).toBe(6);
    expect(move(6, "ArrowDown")).toBe(6);
    expect(move(4, "ArrowUp")).toBe(1);
    expect(move(1, "ArrowUp")).toBe(1);
    expect(move(6, "ArrowUp")).toBe(3);
  });

  it("Home and End are the row's ends, and with Ctrl the shelf's", () => {
    expect(move(4, "Home")).toBe(3);
    expect(move(4, "End")).toBe(5);
    expect(move(6, "End")).toBe(6);
    expect(move(4, "Home", true)).toBe(0);
    expect(move(1, "End", true)).toBe(6);
  });

  it("stays put on one column and on an empty grid, and clamps a stale index", () => {
    expect(moveFocus(0, "ArrowDown", 1, 3)).toBe(1);
    expect(moveFocus(2, "ArrowDown", 1, 3)).toBe(2);
    expect(moveFocus(0, "ArrowRight", 4, 0)).toBe(0);
    expect(moveFocus(99, "ArrowLeft", 3, 7)).toBe(5);
    expect(moveFocus(-4, "ArrowRight", 3, 7)).toBe(1);
  });

  it("walks the whole shelf with the arrows: every cell is reachable and none is skipped", () => {
    const seen = new Set<number>();
    let i = 0;
    for (let step = 0; step < 20; step++) {
      seen.add(i);
      i = moveFocus(i, "ArrowRight", 3, 7);
    }
    expect([...seen].sort()).toEqual([0, 1, 2, 3, 4, 5, 6]);
    let j = 0;
    const down = [];
    for (let step = 0; step < 6; step++) {
      down.push(j);
      j = moveFocus(j, "ArrowDown", 3, 7);
    }
    expect(down.slice(0, 4)).toEqual([0, 3, 6, 6]);
  });

  it("knows its keys", () => {
    for (const k of ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End"]) expect(isNavKey(k)).toBe(true);
    for (const k of ["Enter", "Delete", " ", "a", "Tab", "Escape"]) expect(isNavKey(k)).toBe(false);
  });
});

describe("what the shelf shows", () => {
  it("is unavailable without storage, empty without cartridges, a list otherwise", () => {
    expect(shelfMode("unavailable", 0)).toBe("unavailable");
    expect(shelfMode("unavailable", 5)).toBe("unavailable");
    expect(shelfMode("ready", 0)).toBe("empty");
    expect(shelfMode("ready", 1)).toBe("list");
  });

  const items = [
    item(1, { platform: "gba", userTitle: "B", lastPlayedAt: 10 }),
    item(2, { platform: "nes", userTitle: "A", lastPlayedAt: 30 }),
    item(3, { platform: "gbc", userTitle: "C", lastPlayedAt: 20 }),
  ];

  it("filters and sorts what is visible, and falls back to everything for a console with none left", () => {
    expect(visibleItems(items, "all", "recent").map((i) => i.userTitle)).toEqual(["A", "C", "B"]);
    expect(visibleItems(items, "gb", "name").map((i) => i.userTitle)).toEqual(["C"]);
    expect(resolveFilter(items, "snes")).toBe("all");
    expect(visibleItems(items, "snes", "name")).toHaveLength(3);
    expect(resolveFilter(items, "gba")).toBe("gba");
    expect(resolveFilter([], "nes")).toBe("all");
  });

  it("makes a chip for Tudo and for each console that has a cartridge, with its count", () => {
    expect(chipModels(items, "Tudo")).toEqual([
      { id: "all", label: "Tudo", count: 3 },
      { id: "nes", label: "NES", count: 1 },
      { id: "gb", label: "Game Boy", count: 1 },
      { id: "gba", label: "GBA", count: 1 },
    ]);
    expect(chipModels([], "Tudo")).toEqual([{ id: "all", label: "Tudo", count: 0 }]);
  });

  it("sends focus to the next box after a removal, else the previous, else nowhere", () => {
    expect(neighbourAfterRemoval(["a", "b", "c"], "b")).toBe("c");
    expect(neighbourAfterRemoval(["a", "b", "c"], "c")).toBe("b");
    expect(neighbourAfterRemoval(["a"], "a")).toBeUndefined();
    expect(neighbourAfterRemoval(["a", "b"], "zz")).toBeUndefined();
  });
});

describe("the boxes, the Ficha and the Continuar line, in each language", () => {
  for (const locale of ["pt-BR", "en", "es"] as const) {
    const t = STRINGS[locale];

    it(`${locale}: stickers count the person's own saves, or say it is new`, () => {
      expect(stickerFor(item(1), t)).toBe(t["box.new"]);
      expect(stickerFor(item(1, { lastPlayedAt: 5 }), t)).toBeUndefined();
      expect(stickerFor(item(1, { lastPlayedAt: 5, slots: [{ slot: "1", at: 1 }] }), t)).toBe(t["box.saves.one"].replace("{n}", "1"));
      const three = [{ slot: "1", at: 1 }, { slot: "2", at: 1 }, { slot: "4", at: 1 }, { slot: "auto", at: 1 }];
      // the autosave is not one of the person's saves
      expect(stickerFor(item(1, { lastPlayedAt: 5, slots: three }), t)).toBe(t["box.saves.other"].replace("{n}", "3"));
    });

    it(`${locale}: a box with no game file says so, and that wins over new and saves`, () => {
      expect(stickerFor(item(1, { hasFile: false }), t)).toBe(t["box.missing"]);
      expect(stickerFor(item(1, { hasFile: false, lastPlayedAt: 5, slots: [{ slot: "1", at: 1 }] }), t)).toBe(t["box.missing"]);
      expect(boxLabel(item(1, { userTitle: "Minha Fita", hasFile: false, lastPlayedAt: 9 }), t)).toBe(`Minha Fita, NES, ${t["box.missing"]}`);
      expect(t["box.missing"].length).toBeGreaterThan(0);
      expect(t["attach.mismatch"].length).toBeGreaterThan(0);
    });

    it(`${locale}: a box is named from its metadata: title, console, sticker`, () => {
      const label = boxLabel(item(1, { userTitle: "Minha Fita", platform: "gba", lastPlayedAt: 9, slots: [{ slot: "1", at: 1 }] }), t);
      expect(label).toBe(`Minha Fita, Game Boy Advance, ${t["box.saves.one"].replace("{n}", "1")}`);
      expect(boxLabel(item(2, { userTitle: "", headerTitle: "", platform: "snes", lastPlayedAt: 9 }), t)).toBe("SNES, SNES");
    });

    it(`${locale}: the Ficha says when it was played and how big it is`, () => {
      const now = 10_000_000;
      expect(fichaFacts(item(1, { bytes: 24 * 1024 }), now, t)).toEqual(["NES", t["ficha.never"], "24 KB"]);
      const played = fichaFacts(item(1, { platform: "gb", lastPlayedAt: now - 2 * 3_600_000, playSeconds: 90 * 60, bytes: 2048 }), now, t);
      expect(played).toEqual([
        "Game Boy",
        t["ficha.played"].replace("{ago}", "2 h"),
        "2 KB",
        t["ficha.playtime"].replace("{time}", "1 h 30 min"),
      ]);
      // a few seconds is not a play time worth a pill
      expect(fichaFacts(item(1, { playSeconds: 20 }), now, t)).toHaveLength(3);
    });

    it(`${locale}: the Continuar line lists the parts that exist`, () => {
      const now = 10_000_000;
      const it1 = item(1, { platform: "gba", lastPlayedAt: 5, slots: [{ slot: "1", at: 1 }, { slot: "2", at: 1 }] });
      expect(continueLine(it1, undefined, now, t)).toBe(`Game Boy Advance · ${t["box.saves.other"].replace("{n}", "2")}`);
      expect(continueLine(it1, { at: now - 2 * 3_600_000 }, now, t)).toBe(
        `Game Boy Advance · ${t["continue.saved"].replace("{ago}", "2 h")} · ${t["box.saves.other"].replace("{n}", "2")}`,
      );
      expect(continueLine(item(2, { lastPlayedAt: 5 }), undefined, now, t)).toBe("NES");
    });
  }

  it("a rename that is blank or unchanged is no rename", () => {
    const it1 = item(1, { userTitle: "Nome" });
    expect(renameOutcome(it1, "   ")).toBeNull();
    expect(renameOutcome(it1, " Nome ")).toBeNull();
    expect(renameOutcome(it1, "  Novo   nome ")).toBe("Novo nome");
    expect(renameOutcome(item(2, { userTitle: "", headerTitle: "HDR" }), "HDR")).toBeNull();
  });
});

describe("the sign and the N shortcut", () => {
  beforeEach(() => resetPowerOn());

  it("powers on the first time in a session only", () => {
    expect(consumePowerOn()).toBe(true);
    expect(consumePowerOn()).toBe(false);
    expect(consumePowerOn()).toBe(false);
    resetPowerOn();
    expect(consumePowerOn()).toBe(true);
  });

  it("N picks a cartridge unless a modifier is held or a field has the keys", () => {
    const key = (k: string, extra: Record<string, unknown> = {}, tag = "BODY") =>
      isPickShortcut({ key: k, ctrlKey: false, metaKey: false, altKey: false, target: { tagName: tag } as unknown as EventTarget, ...extra });
    expect(key("n")).toBe(true);
    expect(key("N")).toBe(true);
    expect(key("n", { ctrlKey: true })).toBe(false);
    expect(key("n", { metaKey: true })).toBe(false);
    expect(key("n", { altKey: true })).toBe(false);
    expect(key("m")).toBe(false);
    expect(key("n", {}, "INPUT")).toBe(false);
    expect(key("n", {}, "TEXTAREA")).toBe(false);
    expect(key("n", {}, "SELECT")).toBe(false);
    expect(key("n", {}, "BUTTON")).toBe(true);
  });
});

describe("the balcao's copy", () => {
  const keys = [
    "rules.stamp", "shelf.filter", "shelf.filter.all", "shelf.sort", "shelf.sort.recent", "shelf.sort.name", "shelf.sort.console",
    "shelf.pickAnother", "shelf.hint", "box.new", "box.saves.one", "box.saves.other", "ficha.selected", "ficha.play", "ficha.rename",
    "ficha.remove", "ficha.remove.yes", "ficha.remove.no", "ficha.never", "ficha.played", "ficha.playtime", "name.save", "name.skip",
    "continue.badge", "shelf.empty", "shelf.noStorage", "shelf.full", "shelf.remove.confirm", "name.ask", "name.default",
  ] as const;

  it("has every key in pt-BR, en and es, with the slots its code fills, and follows the copy rules", () => {
    for (const locale of ["pt-BR", "en", "es"] as const) {
      for (const key of keys) {
        const value: string = STRINGS[locale][key];
        expect(value.length, `${locale}.${key}`).toBeGreaterThan(0);
        expect(value.includes(EM_DASH), `${locale}.${key}`).toBe(false);
        expect(/\p{Extended_Pictographic}/u.test(value), `${locale}.${key}`).toBe(false);
        expect(/\b(roms?|download|baix|descarg|grátis|gratis|free|torrent)/i.test(value), `${locale}.${key}`).toBe(false);
      }
      expect(STRINGS[locale]["ficha.played"]).toContain("{ago}");
      expect(STRINGS[locale]["ficha.playtime"]).toContain("{time}");
      expect(STRINGS[locale]["box.saves.one"]).toContain("{n}");
      expect(STRINGS[locale]["box.saves.other"]).toContain("{n}");
      expect(STRINGS[locale]["continue.badge"]).toContain("{ago}");
      expect(STRINGS[locale]["name.default"]).toContain("{n}");
    }
    // tu, never the formal pronoun
    for (const key of keys) expect(/voc[eê]/i.test(STRINGS["pt-BR"][key])).toBe(false);
  });
});

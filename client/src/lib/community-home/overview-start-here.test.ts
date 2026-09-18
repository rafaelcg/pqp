import { describe, expect, it } from "vitest";
import {
  foldChannelName,
  loadOverviewStartHereIds,
  OVERVIEW_START_HERE_MAX,
  overviewStartHereHint,
  pickDefaultOverviewStartHereChannels,
  resolveOverviewStartHereChannels,
  saveOverviewStartHereIds,
  toggleOverviewStartHereId,
  type OverviewStartHereChannel,
} from "./overview-start-here";

function channel(
  overrides: Partial<OverviewStartHereChannel> &
    Pick<OverviewStartHereChannel, "id" | "name" | "type">,
): OverviewStartHereChannel {
  return {
    position: 0,
    isPrivate: false,
    topic: null,
    imageUrl: null,
    ...overrides,
  };
}

const avisos = channel({
  id: "c-avisos",
  name: "avisos",
  type: "text",
  position: 2,
});
const ajuda = channel({
  id: "c-ajuda",
  name: "ajuda",
  type: "text",
  position: 3,
});
const geral = channel({
  id: "c-geral",
  name: "geral",
  type: "text",
  position: 1,
});
const lobby = channel({
  id: "c-lobby",
  name: "Lobby",
  type: "voice",
  position: 4,
});
const staff = channel({
  id: "c-staff",
  name: "staff",
  type: "text",
  isPrivate: true,
  position: 0,
});
const category = channel({
  id: "c-cat",
  name: "texto",
  type: "category",
  position: 0,
});

describe("foldChannelName", () => {
  it("folds accents and punctuation", () => {
    expect(foldChannelName("Anúncios")).toBe("anuncios");
    expect(foldChannelName("Ajuda!")).toBe("ajuda");
  });
});

describe("overviewStartHereHint", () => {
  it("maps the QG names and voice", () => {
    expect(overviewStartHereHint(avisos)).toBe("avisos");
    expect(overviewStartHereHint(ajuda)).toBe("ajuda");
    expect(overviewStartHereHint(geral)).toBe("geral");
    expect(overviewStartHereHint(lobby)).toBe("voice");
    expect(
      overviewStartHereHint(channel({ id: "x", name: "random", type: "text" })),
    ).toBeNull();
  });
});

describe("pickDefaultOverviewStartHereChannels", () => {
  it("picks avisos, ajuda, geral, then lobby, and skips private and categories", () => {
    expect(
      pickDefaultOverviewStartHereChannels([
        category,
        staff,
        lobby,
        geral,
        ajuda,
        avisos,
      ]).map((row) => row.id),
    ).toEqual(["c-avisos", "c-ajuda", "c-geral", "c-lobby"]);
  });

  it("does not dump leftover channels onto the page", () => {
    const extra = channel({
      id: "c-off",
      name: "off-topic",
      type: "text",
      position: 9,
    });
    expect(
      pickDefaultOverviewStartHereChannels([geral, extra]).map((row) => row.id),
    ).toEqual(["c-geral"]);
  });
});

describe("resolveOverviewStartHereChannels", () => {
  it("uses stored order and drops ids that are gone", () => {
    expect(
      resolveOverviewStartHereChannels([geral, ajuda, avisos], [
        "c-ajuda",
        "missing",
        "c-geral",
      ]).map((row) => row.id),
    ).toEqual(["c-ajuda", "c-geral"]);
  });

  it("falls back to the name heuristics when nothing is stored", () => {
    expect(
      resolveOverviewStartHereChannels([geral, ajuda], null).map(
        (row) => row.id,
      ),
    ).toEqual(["c-ajuda", "c-geral"]);
  });

  it("honours an explicit empty pick", () => {
    expect(resolveOverviewStartHereChannels([geral, ajuda], [])).toEqual([]);
  });
});

describe("toggleOverviewStartHereId", () => {
  it("starts from the default pick, then removes and refuses a fifth", () => {
    const pool = [
      avisos,
      ajuda,
      geral,
      lobby,
      channel({ id: "c-extra", name: "extra", type: "text", position: 8 }),
    ];
    const withoutAjuda = toggleOverviewStartHereId(pool, null, "c-ajuda");
    expect(withoutAjuda).toEqual(["c-avisos", "c-geral", "c-lobby"]);
    expect(withoutAjuda).toHaveLength(OVERVIEW_START_HERE_MAX - 1);
    const full = ["c-avisos", "c-ajuda", "c-geral", "c-lobby"];
    expect(toggleOverviewStartHereId(pool, full, "c-extra")).toEqual(full);
  });
});

describe("overview start-here storage", () => {
  it("round-trips ids and treats junk as unset", () => {
    const storage = new Map<string, string>();
    const adapter = {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => {
        storage.set(key, value);
      },
      removeItem: (key: string) => {
        storage.delete(key);
      },
    };
    expect(loadOverviewStartHereIds("s1", adapter)).toBeNull();
    saveOverviewStartHereIds("s1", ["a", "b"], adapter);
    expect(loadOverviewStartHereIds("s1", adapter)).toEqual(["a", "b"]);
    adapter.setItem("pqp:overview-start-here:s1", "{");
    expect(loadOverviewStartHereIds("s1", adapter)).toBeNull();
  });
});

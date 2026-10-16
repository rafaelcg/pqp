// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/config-refresh", () => ({ onConfigRefresh: () => () => {} }));
vi.mock("@/lib/api", () => ({ apiFetch: vi.fn() }));

const {
  NOTICE_MAX_CHANNELS,
  NOTICE_MAX_MEMBERS,
  NOTICE_MAX_SERVER_AGE_MS,
  NOTICE_REAPPEAR_AFTER_MS,
  clickedRecord,
  closedRecord,
  discordImportNoticeVisible,
  isDiscordImportNoticeOn,
  isSmallAndNew,
  loadDiscordImportNoticeConfig,
  mergeNoticeRecords,
  noticeAllowedByHistory,
  noticeFromConfig,
  noticeKey,
  parseNoticeRecord,
  readNoticeRecord,
  resetNoticeSessionForTests,
  setDiscordImportNoticeForTests,
  useDiscordImportNoticeRecord,
  writeNoticeRecord,
} = await import("./discord-import-notice");
type Facts = Parameters<typeof discordImportNoticeVisible>[0];

const NOW = Date.parse("2026-10-16T12:00:00.000Z");
const DAY = 24 * 60 * 60 * 1000;
const iso = (agoMs: number) => new Date(NOW - agoMs).toISOString();

const FRESH: Facts = {
  flagOn: true,
  canManage: true,
  serverCreatedAt: iso(2 * DAY),
  memberCount: 3,
  channelCount: 2,
  imported: false,
  onMainTextChannel: true,
  partyLive: false,
  inCall: false,
  otherCardUp: false,
  record: { closes: 0, lastClosedAt: 0, clicked: false },
  recordReadable: true,
};

function fakeStorage(initial: Record<string, string> = {}) {
  const map = new Map(Object.entries(initial));
  return {
    map,
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => void map.set(key, value),
  };
}

describe("discordImportNoticeVisible", () => {
  it("shows to a manager of a small, new server that was not imported", () => {
    expect(discordImportNoticeVisible(FRESH, NOW)).toBe(true);
  });

  it.each([
    ["the flag is off", { flagOn: false }],
    ["the reader cannot manage the server", { canManage: false }],
    ["the server came from an import", { imported: true }],
    ["whether it was imported is not known yet", { imported: undefined }],
    ["it is not the main text channel", { onMainTextChannel: false }],
    ["a watch party is live", { partyLive: true }],
    ["the reader is in a call", { inCall: true }],
    ["another card or strip holds the screen", { otherCardUp: true }],
    ["the stored history cannot be read", { recordReadable: false }],
  ] as const)("hides when %s", (_label, patch) => {
    expect(discordImportNoticeVisible({ ...FRESH, ...patch }, NOW)).toBe(false);
  });

  it("hides once the person pressed the button", () => {
    const record = clickedRecord(FRESH.record, NOW - DAY);
    expect(discordImportNoticeVisible({ ...FRESH, record }, NOW)).toBe(false);
    expect(
      discordImportNoticeVisible({ ...FRESH, record }, NOW + 365 * DAY),
    ).toBe(false);
  });
});

describe("isSmallAndNew", () => {
  const base = { serverCreatedAt: iso(DAY), memberCount: 5, channelCount: 3 };

  it("accepts a server under every limit", () => {
    expect(isSmallAndNew(base, NOW)).toBe(true);
    expect(
      isSmallAndNew(
        {
          serverCreatedAt: iso(NOTICE_MAX_SERVER_AGE_MS - 1),
          memberCount: NOTICE_MAX_MEMBERS,
          channelCount: NOTICE_MAX_CHANNELS,
        },
        NOW,
      ),
    ).toBe(true);
  });

  it("rejects a server created a month ago or more", () => {
    expect(
      isSmallAndNew({ ...base, serverCreatedAt: iso(NOTICE_MAX_SERVER_AGE_MS) }, NOW),
    ).toBe(false);
  });

  it("rejects a crowd and a built-out layout", () => {
    expect(isSmallAndNew({ ...base, memberCount: NOTICE_MAX_MEMBERS + 1 }, NOW)).toBe(false);
    expect(isSmallAndNew({ ...base, channelCount: NOTICE_MAX_CHANNELS + 1 }, NOW)).toBe(false);
  });

  it("waits for the member list: zero means not loaded", () => {
    expect(isSmallAndNew({ ...base, memberCount: 0 }, NOW)).toBe(false);
  });

  it("reads a missing, unparseable or future creation date as not new", () => {
    expect(isSmallAndNew({ ...base, serverCreatedAt: null }, NOW)).toBe(false);
    expect(isSmallAndNew({ ...base, serverCreatedAt: undefined }, NOW)).toBe(false);
    expect(isSmallAndNew({ ...base, serverCreatedAt: "soon" }, NOW)).toBe(false);
    expect(isSmallAndNew({ ...base, serverCreatedAt: iso(-3 * DAY) }, NOW)).toBe(false);
  });
});

describe("the dismissal history", () => {
  const never = { closes: 0, lastClosedAt: 0, clicked: false };

  it("a card never closed may show", () => {
    expect(noticeAllowedByHistory(never, NOW)).toBe(true);
  });

  it("closed once: hidden for the wait, then once more", () => {
    const once = closedRecord(never, NOW);
    expect(noticeAllowedByHistory(once, NOW + 1)).toBe(false);
    expect(noticeAllowedByHistory(once, NOW + NOTICE_REAPPEAR_AFTER_MS - 1)).toBe(false);
    expect(noticeAllowedByHistory(once, NOW + NOTICE_REAPPEAR_AFTER_MS)).toBe(true);
  });

  it("closed twice: never again, however long it has been", () => {
    const twice = closedRecord(closedRecord(never, NOW - 30 * DAY), NOW - 15 * DAY);
    expect(twice.closes).toBe(2);
    expect(noticeAllowedByHistory(twice, NOW + 365 * DAY)).toBe(false);
  });

  it("a click ends it even if it was never closed", () => {
    expect(noticeAllowedByHistory(clickedRecord(never, NOW), NOW + 365 * DAY)).toBe(false);
  });

  it("a clock set back cannot bring it back early", () => {
    const once = closedRecord(never, NOW);
    expect(noticeAllowedByHistory(once, NOW - 20 * DAY)).toBe(false);
  });
});

describe("the dismissal store", () => {
  it("is keyed by user and server", () => {
    expect(noticeKey("u1", "s1")).not.toBe(noticeKey("u2", "s1"));
    expect(noticeKey("u1", "s1")).not.toBe(noticeKey("u1", "s2"));
  });

  it("round-trips a record", () => {
    // `shouldPersistHints` is false on localhost (the jsdom default host), so
    // go through the pure parse/serialise halves the persisting hosts use.
    const record = closedRecord({ closes: 0, lastClosedAt: 0, clicked: false }, NOW);
    expect(parseNoticeRecord(JSON.stringify(record))).toEqual(record);
  });

  it.each([null, "", "nope", "{", "null", '{"closes":"x"}', '{"closes":-4,"lastClosedAt":-1}'])(
    "reads garbage (%j) as an empty record",
    (raw) => {
      expect(parseNoticeRecord(raw)).toEqual({ closes: 0, lastClosedAt: 0, clicked: false });
    },
  );

  it("does not persist on a host the hints store keeps clean (localhost), and says it is readable", () => {
    const storage = fakeStorage();
    writeNoticeRecord("u", "s", closedRecord({ closes: 0, lastClosedAt: 0, clicked: false }, NOW), storage);
    expect(storage.map.size).toBe(0);
    expect(readNoticeRecord("u", "s", storage)).toEqual({
      record: { closes: 0, lastClosedAt: 0, clicked: false },
      readable: true,
    });
  });

  it("persists where hints persist (the localhost override), per user and server", () => {
    window.localStorage.setItem("pqp:hints-persist", "1");
    try {
      const closed = closedRecord({ closes: 0, lastClosedAt: 0, clicked: false }, NOW);
      writeNoticeRecord("u1", "s1", closed);
      expect(readNoticeRecord("u1", "s1")).toEqual({ record: closed, readable: true });
      expect(readNoticeRecord("u2", "s1").record.closes).toBe(0);
      expect(readNoticeRecord("u1", "s2").record.closes).toBe(0);
    } finally {
      window.localStorage.clear();
    }
  });

  it("storage that throws or is missing reads as unreadable, which hides the card", () => {
    window.localStorage.setItem("pqp:hints-persist", "1");
    try {
      expect(readNoticeRecord("u", "s", null).readable).toBe(false);
      const hostile = {
        getItem: () => {
          throw new Error("denied");
        },
      };
      expect(readNoticeRecord("u", "s", hostile).readable).toBe(false);
    } finally {
      window.localStorage.clear();
    }
  });
});

describe("the config answer", () => {
  beforeEach(() => setDiscordImportNoticeForTests(false));

  it("only an explicit true is on", () => {
    expect(noticeFromConfig({ discordImportNotice: true })).toBe(true);
    expect(noticeFromConfig({ discordImportNotice: "true" })).toBe(false);
    expect(noticeFromConfig({})).toBe(false);
  });

  it("an answer that fails keeps the last one", async () => {
    await loadDiscordImportNoticeConfig(async () => ({ discordImportNotice: true }));
    expect(isDiscordImportNoticeOn()).toBe(true);
    await loadDiscordImportNoticeConfig(async () => {
      throw new Error("offline");
    });
    expect(isDiscordImportNoticeOn()).toBe(true);
    await loadDiscordImportNoticeConfig(async () => ({ discordImportNotice: false }));
    expect(isDiscordImportNoticeOn()).toBe(false);
  });
});

describe("useDiscordImportNoticeRecord", () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  type Api = ReturnType<typeof useDiscordImportNoticeRecord>;
  let root: Root | null = null;
  let host: HTMLElement | null = null;
  let api: Api;

  function Probe({ user, server }: { user: string; server: string }) {
    api = useDiscordImportNoticeRecord(user, server);
    return null;
  }

  async function show(user: string, server: string) {
    if (!host) {
      host = document.createElement("div");
      document.body.append(host);
      root = createRoot(host);
    }
    await act(async () => {
      root!.render(createElement(Probe, { user, server }));
    });
  }

  beforeEach(() => {
    resetNoticeSessionForTests();
    window.localStorage.clear();
  });

  afterEach(() => {
    act(() => root?.unmount());
    host?.remove();
    root = null;
    host = null;
    window.localStorage.clear();
  });

  it("a close on a host that keeps nothing still holds when the person switches servers and back", async () => {
    // jsdom is localhost: the hints store persists nothing here.
    await show("u", "a");
    await act(async () => api.close());
    expect(api.record.closes).toBe(1);
    await show("u", "b");
    expect(api.record.closes).toBe(0);
    await show("u", "a");
    expect(api.record.closes).toBe(1);
    expect(window.localStorage.length).toBe(0);
  });

  it("a stale tab closing cannot undo a click another tab recorded", async () => {
    window.localStorage.setItem("pqp:hints-persist", "1");
    await show("u", "a");
    expect(api.record.clicked).toBe(false);
    // Another tab presses the button while this one still holds the old copy.
    window.localStorage.setItem(
      noticeKey("u", "a"),
      JSON.stringify({ closes: 0, lastClosedAt: NOW, clicked: true }),
    );
    await act(async () => api.close());
    expect(api.record.clicked).toBe(true);
    expect(readNoticeRecord("u", "a").record).toMatchObject({ clicked: true, closes: 1 });
  });
});

describe("mergeNoticeRecords", () => {
  it("keeps the furthest of every field", () => {
    expect(
      mergeNoticeRecords(
        { closes: 1, lastClosedAt: 10, clicked: false },
        { closes: 0, lastClosedAt: 20, clicked: true },
      ),
    ).toEqual({ closes: 1, lastClosedAt: 20, clicked: true });
  });
});

import { beforeEach, describe, expect, it, vi } from "vitest";

const apiFetch = vi.fn();
vi.mock("@/lib/api", () => ({ apiFetch: (...args: unknown[]) => apiFetch(...args) }));

import { fetchServerAppSessions } from "./api";

const SERVER = "00000000-0000-4000-8000-0000000000a1";
const CH1 = "00000000-0000-4000-8000-0000000000c1";
const S1 = "00000000-0000-4000-8000-0000000000d1";
const BIA = "00000000-0000-4000-8000-0000000000b2";

function row(channelId: string, id: string) {
  return {
    channelId,
    session: {
      id,
      appId: "pqp-eco",
      appVersion: "1.0.0",
      startedBy: BIA,
      hostUserId: BIA,
      startedAt: "2026-10-19T10:00:00.000Z",
      participants: [],
      players: 0,
      spectators: 0,
      handoff: null,
    },
  };
}

describe("fetchServerAppSessions", () => {
  beforeEach(() => apiFetch.mockReset());

  it("returns every readable row", async () => {
    apiFetch.mockResolvedValue({ sessions: [row(CH1, S1)] });
    const out = await fetchServerAppSessions(SERVER);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ channelId: CH1, session: { id: S1 } });
  });

  it("returns an empty list for an honest empty answer", async () => {
    apiFetch.mockResolvedValue({ sessions: [] });
    await expect(fetchServerAppSessions(SERVER)).resolves.toEqual([]);
  });

  it("throws on a 200 without a sessions array, never an empty list", async () => {
    for (const body of [{}, null, { sessions: null }, { sessions: "nope" }, []]) {
      apiFetch.mockResolvedValue(body);
      await expect(fetchServerAppSessions(SERVER)).rejects.toThrow();
    }
  });

  it("throws when one row cannot be read, so the read counts as incomplete", async () => {
    const bad = { channelId: CH1, session: { id: "not-a-uuid" } };
    apiFetch.mockResolvedValue({ sessions: [row(CH1, S1), bad] });
    await expect(fetchServerAppSessions(SERVER)).rejects.toThrow();
    apiFetch.mockResolvedValue({ sessions: [{ session: row(CH1, S1).session }] });
    await expect(fetchServerAppSessions(SERVER)).rejects.toThrow();
  });
});

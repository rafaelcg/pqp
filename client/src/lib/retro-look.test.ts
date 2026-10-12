import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./preferences", () => ({
  queuePreferenceSync: vi.fn(),
}));

const apiFetch = vi.fn();
vi.mock("./api", async () => {
  const actual = await vi.importActual<typeof import("./api")>("./api");
  return { ...actual, apiFetch: (...args: unknown[]) => apiFetch(...args) };
});

import { ApiError } from "./api";
import { getLook, reloadRetroLookForTests, setRetroLook, setRetroLookAvailable } from "./appearance";
import { queuePreferenceSync } from "./preferences";
import {
  RETRO_FOUND_KEY,
  getRetroState,
  isRetroNew,
  isRetroOffered,
  resetRetroLookForTests,
  setRetroChunkLoaderForTests,
  startRetroLookFlag,
  toggleRetroLook,
} from "./retro-look";
import { requestConfigRefresh } from "./config-refresh";
import { executeSlashCommand, listSlashCommands } from "./slash-commands";

const store = new Map<string, string>();

function slashCtx() {
  return {
    sendMessage: vi.fn(),
    updateDisplayName: vi.fn(),
    openInvite: vi.fn(),
    joinByCode: vi.fn(),
    setMuted: vi.fn(),
    isInVoice: false,
    isMuted: false,
    openGifPicker: vi.fn(),
    isGifSearchEnabled: true,
    sendChance: vi.fn(),
    sendPoll: vi.fn(),
    openPollComposer: vi.fn(),
    canPurgeMessages: false,
    openPurgeDialog: vi.fn(),
  };
}

beforeEach(() => {
  store.clear();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => void store.set(key, value),
    removeItem: (key: string) => void store.delete(key),
  });
  apiFetch.mockReset();
  vi.mocked(queuePreferenceSync).mockClear();
  setRetroChunkLoaderForTests(async () => undefined);
  reloadRetroLookForTests();
  resetRetroLookForTests();
});

afterEach(() => {
  setRetroLook(false);
  setRetroLookAvailable(true);
  vi.unstubAllGlobals();
});

describe("discovery", () => {
  it("is hidden from the slash menu until found", async () => {
    expect(listSlashCommands().map((c) => c.name)).not.toContain("2005");
    expect(isRetroOffered()).toBe(false);

    apiFetch.mockRejectedValue(new ApiError(404, "Not found"));
    await toggleRetroLook();

    expect(listSlashCommands().map((c) => c.name)).toContain("2005");
    expect(isRetroOffered()).toBe(true);
  });

  it("/2005 never sends: the first time finds the look, the second turns it off", async () => {
    apiFetch.mockResolvedValue({ retroLook: true });
    const ctx = slashCtx();

    const found = await executeSlashCommand("/2005", ctx);
    expect(found).toEqual({ kind: "ok", feedback: undefined, clearComposer: true });
    expect(getLook()).toBe("retro");
    expect(getRetroState().foundCardPending).toBe(true);
    expect(store.get(RETRO_FOUND_KEY)).toMatch(/^\d{4}-/);

    const off = await executeSlashCommand("/2005", ctx);
    expect(off.kind).toBe("ok");
    expect(off.feedback?.tone).toBe("info");
    expect(getLook()).not.toBe("retro");

    const again = await toggleRetroLook();
    expect(again).toBe("on");
    expect(getRetroState().foundCardPending).toBe(false);

    expect(ctx.sendMessage).not.toHaveBeenCalled();
    // A local look: nothing is written to the account.
    expect(queuePreferenceSync).not.toHaveBeenCalled();
  });

  it("the kill switch refuses it and the command answers like an unknown one", async () => {
    apiFetch.mockResolvedValue({ retroLook: false });
    const ctx = slashCtx();

    const result = await executeSlashCommand("/2005", ctx);

    expect(result.kind).toBe("error");
    expect(getLook()).not.toBe("retro");
    expect(store.has(RETRO_FOUND_KEY)).toBe(false);
    expect(ctx.sendMessage).not.toHaveBeenCalled();
  });

  it("two quick toggles land on and then off, not on twice", async () => {
    apiFetch.mockResolvedValue({ retroLook: true });
    let release: () => void = () => {};
    setRetroChunkLoaderForTests(
      () => new Promise<void>((resolve) => (release = resolve)),
    );
    const first = toggleRetroLook();
    const second = toggleRetroLook();
    await vi.waitFor(() => expect(apiFetch).toHaveBeenCalled());
    release();
    expect(await first).toBe("found");
    expect(await second).toBe("off");
    expect(getLook()).not.toBe("retro");
  });

  it("an older kill-switch answer never overrides a newer one", async () => {
    store.set(RETRO_FOUND_KEY, "2026-10-01T00:00:00.000Z");
    let answerOld: (value: unknown) => void = () => {};
    apiFetch
      .mockImplementationOnce(() => new Promise((resolve) => (answerOld = resolve)))
      .mockResolvedValueOnce({ retroLook: false });
    const stop = startRetroLookFlag();
    requestConfigRefresh({ force: true });
    await vi.waitFor(() => expect(getRetroState().available).toBe(false));
    answerOld({ retroLook: true });
    await Promise.resolve();
    await Promise.resolve();
    expect(getRetroState().available).toBe(false);
    stop();
  });

  it("a server without the route counts as switched on", async () => {
    apiFetch.mockRejectedValue(new ApiError(404, "Not found"));
    expect(await toggleRetroLook()).toBe("found");
  });

  it("the tile is new for two weeks after the find", () => {
    const state = { ...getRetroState(), foundAt: "2026-10-01T00:00:00.000Z" };
    expect(isRetroNew(state, Date.parse("2026-10-05T00:00:00.000Z"))).toBe(true);
    expect(isRetroNew(state, Date.parse("2026-10-20T00:00:00.000Z"))).toBe(false);
  });
});

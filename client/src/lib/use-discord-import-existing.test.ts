import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/api", () => ({ fetchDiscordImportConfig: vi.fn() }));

const { loadDiscordImportExisting, resetDiscordImportExistingForTests } = await import(
  "./use-discord-import-existing"
);

describe("loadDiscordImportExisting", () => {
  beforeEach(() => resetDiscordImportExistingForTests());

  it("is true only for an explicit enabled: true", async () => {
    expect(await loadDiscordImportExisting("a", async () => ({ enabled: true }))).toBe(true);
    expect(await loadDiscordImportExisting("b", async () => ({ enabled: false }))).toBe(false);
  });

  it("reads a failed answer (a 403, a 404, the network) as the create-new import", async () => {
    const failing = async () => {
      throw new Error("404");
    };
    expect(await loadDiscordImportExisting("a", failing)).toBe(false);
  });

  it("asks once per server, even when asked twice at the same time", async () => {
    const fetcher = vi.fn(async () => ({ enabled: true }));
    const [first, second] = await Promise.all([
      loadDiscordImportExisting("a", fetcher),
      loadDiscordImportExisting("a", fetcher),
    ]);
    expect([first, second]).toEqual([true, true]);
    await loadDiscordImportExisting("a", fetcher);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("keeps one answer per server", async () => {
    await loadDiscordImportExisting("a", async () => ({ enabled: true }));
    expect(await loadDiscordImportExisting("b", async () => ({ enabled: false }))).toBe(false);
    expect(await loadDiscordImportExisting("a", async () => ({ enabled: false }))).toBe(true);
  });
});

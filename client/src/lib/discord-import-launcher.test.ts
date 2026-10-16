import { afterEach, describe, expect, it, vi } from "vitest";
import {
  openDiscordImport,
  resetDiscordImportLauncherForTests,
  subscribeDiscordImport,
} from "./discord-import-launcher";

afterEach(() => resetDiscordImportLauncherForTests());

describe("openDiscordImport", () => {
  it("hands a serverId request to the host", () => {
    const listener = vi.fn();
    subscribeDiscordImport(listener);
    openDiscordImport({ serverId: "srv-1" });
    expect(listener).toHaveBeenCalledWith({ serverId: "srv-1", source: null });
  });

  it("with no serverId asks for the create dialog, and carries a pre-filled source", () => {
    const listener = vi.fn();
    subscribeDiscordImport(listener);
    openDiscordImport();
    openDiscordImport({ source: "discord.new/abcd1234" });
    expect(listener).toHaveBeenNthCalledWith(1, { serverId: null, source: null });
    expect(listener).toHaveBeenNthCalledWith(2, {
      serverId: null,
      source: "discord.new/abcd1234",
    });
  });

  it("keeps a call made before the host mounted and gives it to the first listener only", () => {
    openDiscordImport({ serverId: "early" });
    const first = vi.fn();
    subscribeDiscordImport(first);
    expect(first).toHaveBeenCalledWith({ serverId: "early", source: null });
    const second = vi.fn();
    subscribeDiscordImport(second);
    expect(second).not.toHaveBeenCalled();
  });

  it("stops calling a listener once it unsubscribes", () => {
    const listener = vi.fn();
    const off = subscribeDiscordImport(listener);
    off();
    openDiscordImport({ serverId: "srv-1" });
    expect(listener).not.toHaveBeenCalled();
  });
});

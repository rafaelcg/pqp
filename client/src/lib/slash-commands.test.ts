import { describe, expect, it, vi } from "vitest";
import { executeSlashCommand } from "./slash-commands.js";

function ctx(overrides: Record<string, unknown> = {}) {
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
    ...overrides,
  };
}

describe("chance slash commands", () => {
  it("sends a roll request, not a pre-rolled total", async () => {
    const sendChance = vi.fn();
    const result = await executeSlashCommand("/roll 2d6+3", ctx({ sendChance }));
    expect(result.kind).toBe("ok");
    expect(sendChance).toHaveBeenCalledWith({
      type: "roll",
      notation: "2d6+3",
    });
    expect(result.kind === "ok" && result.feedback?.message).toContain("2d6+3");
    expect(result.kind === "ok" && result.feedback?.message).not.toMatch(/\d+ = \d+/);
  });

  it("defaults /roll to 1d20", async () => {
    const sendChance = vi.fn();
    await executeSlashCommand("/roll", ctx({ sendChance }));
    expect(sendChance).toHaveBeenCalledWith({ type: "roll", notation: "1d20" });
  });

  it("refuses a d7", async () => {
    const sendChance = vi.fn();
    const result = await executeSlashCommand("/roll 1d7", ctx({ sendChance }));
    expect(result.kind).toBe("error");
    expect(sendChance).not.toHaveBeenCalled();
  });

  it("sends /flip without args", async () => {
    const sendChance = vi.fn();
    await executeSlashCommand("/flip", ctx({ sendChance }));
    expect(sendChance).toHaveBeenCalledWith({ type: "flip" });
  });

  it("needs two options for /choose", async () => {
    const sendChance = vi.fn();
    const result = await executeSlashCommand("/choose only", ctx({ sendChance }));
    expect(result.kind).toBe("error");
    expect(sendChance).not.toHaveBeenCalled();
  });

  it("sends /choose options", async () => {
    const sendChance = vi.fn();
    await executeSlashCommand("/choose pizza burguer", ctx({ sendChance }));
    expect(sendChance).toHaveBeenCalledWith({
      type: "choose",
      options: ["pizza", "burguer"],
    });
  });

  it("sends /draw with a count", async () => {
    const sendChance = vi.fn();
    await executeSlashCommand("/draw 3", ctx({ sendChance }));
    expect(sendChance).toHaveBeenCalledWith({ type: "draw", count: 3 });
  });

  it("opens the poll sheet when /poll has no args", async () => {
    const openPollComposer = vi.fn();
    const sendPoll = vi.fn();
    await executeSlashCommand("/poll", ctx({ openPollComposer, sendPoll }));
    expect(openPollComposer).toHaveBeenCalled();
    expect(sendPoll).not.toHaveBeenCalled();
  });

  it("posts /poll question | a | b", async () => {
    const sendPoll = vi.fn();
    await executeSlashCommand(
      "/poll Saturday? | yes | no",
      ctx({ sendPoll }),
    );
    expect(sendPoll).toHaveBeenCalledWith(
      expect.objectContaining({
        question: "Saturday?",
        options: ["yes", "no"],
      }),
    );
  });
});

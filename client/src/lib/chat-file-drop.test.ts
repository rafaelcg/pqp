import { describe, expect, it } from "vitest";
import { chatDropVerdict } from "./chat-file-drop";

/**
 * Which conversations take a dropped file, and what the rest say.
 *
 * This is the table behind "dragging a file onto a voice channel did nothing":
 * the old rule was `channel.type === "text"`, which left out every voice room's
 * own chat, so the drop was neither taken nor refused.
 */

const ok = {
  attachmentsEnabled: true as boolean | null,
  streamChat: false,
  canSend: true,
};

describe("chatDropVerdict", () => {
  it("accepts text channels, voice channels and watch party rooms with the ordinary composer", () => {
    for (const channelType of ["text", "voice", "watch_party"]) {
      expect(chatDropVerdict({ ...ok, channelType })).toEqual({ mode: "accept" });
    }
  });

  it("is off for what has no chat at all", () => {
    expect(chatDropVerdict({ ...ok, channelType: "category" })).toEqual({ mode: "off" });
    expect(chatDropVerdict({ ...ok, channelType: "" })).toEqual({ mode: "off" });
  });

  it("is off over a watch party's stream chat, which has no attach control by design", () => {
    expect(
      chatDropVerdict({ ...ok, channelType: "watch_party", streamChat: true }),
    ).toEqual({ mode: "off" });
  });

  it("does not claim uploads are off before the config has answered", () => {
    expect(
      chatDropVerdict({ ...ok, channelType: "text", attachmentsEnabled: null }),
    ).toEqual({ mode: "off" });
  });

  it("refuses, with the reason, when this deployment has nowhere to put the bytes", () => {
    expect(
      chatDropVerdict({ ...ok, channelType: "text", attachmentsEnabled: false }),
    ).toEqual({ mode: "refuse", reason: "attachmentsOff" });
    expect(
      chatDropVerdict({ ...ok, channelType: "voice", attachmentsEnabled: false }),
    ).toEqual({ mode: "refuse", reason: "attachmentsOff" });
  });

  it("refuses when the person may not post in the channel", () => {
    expect(chatDropVerdict({ ...ok, channelType: "text", canSend: false })).toEqual({
      mode: "refuse",
      reason: "cannotSend",
    });
  });

  it("says uploads are off before it says you cannot post", () => {
    expect(
      chatDropVerdict({
        ...ok,
        channelType: "text",
        attachmentsEnabled: false,
        canSend: false,
      }),
    ).toEqual({ mode: "refuse", reason: "attachmentsOff" });
  });
});

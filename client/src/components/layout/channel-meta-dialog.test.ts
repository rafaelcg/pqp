import { describe, expect, it } from "vitest";
import {
  VOICE_ROOM_SIZE_OPTIONS,
  fromVoiceRoomSizeOption,
  showsVoiceRoomSize,
  toVoiceRoomSizeOption,
  validateChannelIconInput,
} from "./channel-meta-dialog";

describe("validateChannelIconInput", () => {
  it("accepts an empty value — clearing the icon", () => {
    expect(validateChannelIconInput("")).toBeNull();
    expect(validateChannelIconInput("   ")).toBeNull();
  });

  it("accepts an emoji or short label untouched", () => {
    expect(validateChannelIconInput("📡")).toBeNull();
    expect(validateChannelIconInput("chat")).toBeNull();
  });

  it("accepts an https URL", () => {
    expect(
      validateChannelIconInput("https://cdn.example.com/icon.png"),
    ).toBeNull();
  });

  // The channel image renders to every member of the server, so a plain
  // http:// link — unencrypted, and broken outright when the app itself is
  // served over https — is refused rather than silently accepted.
  it("rejects an http URL", () => {
    expect(
      validateChannelIconInput("http://cdn.example.com/icon.png"),
    ).toBe("channel.meta.image.error.httpsOnly");
  });

  it("rejects a non-http(s) scheme", () => {
    expect(validateChannelIconInput("ftp://cdn.example.com/icon.png")).toBe(
      "channel.meta.image.error.httpsOnly",
    );
    expect(validateChannelIconInput("javascript://alert(1)")).toBe(
      "channel.meta.image.error.httpsOnly",
    );
  });

  it("rejects a malformed URL", () => {
    expect(validateChannelIconInput("https://")).toBe(
      "channel.meta.image.error.invalid",
    );
  });
});

describe("voice room size", () => {
  // The control only exists where there is a room to size. A text channel has
  // no voice room, and a DM call is always small (the server pins it to mesh),
  // so offering the select there would promise a choice that changes nothing.
  it("shows only for a server voice channel", () => {
    expect(showsVoiceRoomSize({ kind: "server", type: "voice" })).toBe(true);
    expect(showsVoiceRoomSize({ kind: "server", type: "text" })).toBe(false);
    expect(showsVoiceRoomSize({ kind: "dm", type: "voice" })).toBe(false);
    expect(showsVoiceRoomSize(null)).toBe(false);
  });

  // A <select> only speaks strings, so "auto" stands in for the wire's null.
  // Saving must send an explicit null back (absent would mean "not changing"),
  // otherwise an owner could never return a channel to automatic.
  it("round-trips null as automatic and the two transports as themselves", () => {
    expect(toVoiceRoomSizeOption(null)).toBe("auto");
    expect(toVoiceRoomSizeOption(undefined)).toBe("auto");
    expect(toVoiceRoomSizeOption("mesh")).toBe("mesh");
    expect(toVoiceRoomSizeOption("livekit")).toBe("livekit");

    expect(fromVoiceRoomSizeOption("auto")).toBeNull();
    expect(fromVoiceRoomSizeOption("mesh")).toBe("mesh");
    expect(fromVoiceRoomSizeOption("livekit")).toBe("livekit");
    for (const option of VOICE_ROOM_SIZE_OPTIONS) {
      expect(toVoiceRoomSizeOption(fromVoiceRoomSizeOption(option))).toBe(
        option,
      );
    }
  });
});

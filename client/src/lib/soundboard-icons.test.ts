import { describe, expect, it } from "vitest";
import { soundboardIcon } from "./soundboard-icons";

describe("soundboardIcon", () => {
  it("gives each builtin its own picture", () => {
    const palmas = soundboardIcon("builtin:palmas");
    const buzina = soundboardIcon("builtin:buzina");
    expect(palmas).not.toBe(buzina);
    expect(soundboardIcon("builtin:ba-dum-tss")).not.toBe(palmas);
  });

  it("uses one plain mark for a custom clip", () => {
    const custom = soundboardIcon("aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee");
    expect(soundboardIcon("bbbbbbbb-cccc-dddd-eeee-ffffffffffff")).toBe(custom);
    expect(custom).not.toBe(soundboardIcon("builtin:palmas"));
  });
});

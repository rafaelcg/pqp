import { describe, expect, it } from "vitest";
import { AudioLines, Hand, Siren } from "lucide-react";
import { soundboardIcon } from "./soundboard-icons";

describe("soundboardIcon", () => {
  it("maps a builtin id to a Lucide icon", () => {
    expect(soundboardIcon("builtin:palmas")).toBe(Hand);
    expect(soundboardIcon("builtin:buzina")).toBe(Siren);
  });

  it("uses AudioLines for a custom clip", () => {
    expect(soundboardIcon("aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee")).toBe(
      AudioLines,
    );
  });
});

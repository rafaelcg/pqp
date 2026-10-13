import { describe, expect, it } from "vitest";
import {
  BOT_BASE_FACES,
  BOT_COLORS,
  BOT_FACES,
  botFaceAvatarPath,
  botFaceSvg,
  parseBotFaceAvatar,
} from "./bot-face.js";

describe("botFaceSvg", () => {
  it("draws every colour, face and variant without a hole", () => {
    for (const color of BOT_COLORS) {
      for (const face of BOT_FACES) {
        for (const variant of ["full", "avatar"] as const) {
          const svg = botFaceSvg({ color, face, variant });
          expect(svg.startsWith("<svg")).toBe(true);
          expect(svg).not.toMatch(/undefined|NaN/);
          expect(svg).toContain('class="bf-eyes"');
        }
      }
    }
  });

  it("is decorative unless given a name, and keeps markup out of the name", () => {
    expect(botFaceSvg({ color: "lime", face: "oi", variant: "avatar" })).toContain('aria-hidden="true"');
    const named = botFaceSvg({ color: "lime", face: "oi", variant: "avatar", title: 'Tico "<b>"' });
    expect(named).toContain('aria-label="Tico b"');
  });
});

describe("bot face avatar paths", () => {
  it("round-trips every colour and base face", () => {
    for (const color of BOT_COLORS) {
      for (const face of BOT_BASE_FACES) {
        expect(parseBotFaceAvatar(botFaceAvatarPath(color, face))).toEqual({ color, face });
        expect(parseBotFaceAvatar(`https://api.pqp.gg${botFaceAvatarPath(color, face)}`)).toEqual({
          color,
          face,
        });
      }
    }
  });

  it("refuses anything else", () => {
    expect(parseBotFaceAvatar(null)).toBeNull();
    expect(parseBotFaceAvatar("/api/avatars/123?v=1")).toBeNull();
    expect(parseBotFaceAvatar("/api/bot-faces/red/oi.png")).toBeNull();
    expect(parseBotFaceAvatar("/api/bot-faces/lime/dormindo.png")).toBeNull();
  });
});

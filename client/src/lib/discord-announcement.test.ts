import { describe, expect, it } from "vitest";
import {
  ANNOUNCEMENT_LANGS,
  announcementUrl,
  defaultAnnouncementLang,
  discordAnnouncement,
} from "./discord-announcement";

const url = announcementUrl("https://pqp.gg", "AbC123");

describe("discordAnnouncement", () => {
  it("links the import's invite, tagged so the joins are counted", () => {
    expect(url).toBe("https://pqp.gg/app/invite/AbC123?ref=discord");
  });

  for (const lang of ANNOUNCEMENT_LANGS) {
    it(`${lang}: short, names what is free, carries the link`, () => {
      const text = discordAnnouncement(lang, "Mesa do RPG", url);
      const lines = text.split("\n");
      expect(lines.length).toBeLessThanOrEqual(4);
      expect(lines[0]).toMatch(/^\*\*Mesa do RPG .*\*\* 🎉$/);
      expect(text).toContain("1080p60");
      expect(text.toLowerCase()).toMatch(/watch part(y|ies)/);
      expect(text).toContain(url);
      // The link on a line of its own words, so Discord unfurls it.
      expect(lines.some((line) => line.endsWith(url))).toBe(true);
      // House rules: no em dash, no mass ping.
      expect(text).not.toContain("\u2014");
      expect(text).not.toContain("@everyone");
      expect(text.length).toBeLessThan(400);
    });
  }

  it("pt-BR talks like the owner (tu), never você", () => {
    const text = discordAnnouncement("pt-BR", "Mesa", url);
    expect(text).not.toMatch(/\bvocê\b/i);
  });

  it("keeps a server name with Discord markdown from breaking the bold", () => {
    const text = discordAnnouncement("en", "**Bold** _guild_", url);
    expect(text.split("\n")[0]).toBe("**Bold guild is on pqp now too** 🎉");
  });

  it("picks the chip from the app's language", () => {
    expect(defaultAnnouncementLang("pt-BR")).toBe("pt-BR");
    expect(defaultAnnouncementLang("es")).toBe("es");
    expect(defaultAnnouncementLang("en")).toBe("en");
    expect(defaultAnnouncementLang("fr")).toBe("en");
  });
});

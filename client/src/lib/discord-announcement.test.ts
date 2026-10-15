import { describe, expect, it } from "vitest";
import {
  ANNOUNCEMENT_LANGS,
  announcementServerName,
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

  it("drops pings and links a crafted template name would smuggle in", () => {
    const text = discordAnnouncement(
      "pt-BR",
      "@everyone [clica](https://evil.example) <@&123> https://x.example",
      url,
    );
    expect(text).not.toContain("@");
    expect(text).not.toContain("evil.example");
    expect(text).not.toContain("x.example");
    expect(text.match(/https?:\/\//g)).toHaveLength(1);
  });

  it("drops bare Discord invites and any other domain a name carries", () => {
    const names = [
      "Mesa discord.gg/freenitro",
      "Mesa discord.com/invite/freenitro",
      "Mesa discordapp.com/invite/freenitro",
      "Mesa DISCORD.GG/freenitro",
      "Mesa Discord.Com/Invite/freenitro",
      "Mesa https://discord.gg/freenitro",
      "Mesa HTTP://DISCORD.GG/freenitro",
      "Mesa evil.example",
      "Mesa evil.example/path?x=1",
      "Mesa www.evil.xyz",
      "Mesa disc\u200bord.gg/freenitro",
      "Mesa <discord.gg/freenitro>",
      "Mesa [discord.gg/freenitro](x)",
      "Mesa dis*cord.gg/freenitro",
    ];
    for (const name of names) {
      const bare = announcementServerName(name);
      expect(bare, name).toBe("Mesa");
      const text = discordAnnouncement("en", name, url);
      expect(text, name).not.toMatch(/discord\.(gg|com)/i);
      expect(text, name).not.toContain("evil");
      expect(text, name).not.toContain("freenitro");
    }
  });

  it("falls back to pqp when the whole name was a link", () => {
    expect(announcementServerName("discord.gg/freenitro")).toBe("pqp");
    expect(announcementServerName("https://x.example")).toBe("pqp");
  });

  it("keeps an ordinary name with dots and digits", () => {
    expect(announcementServerName("Mesa do RPG v2.0")).toBe("Mesa do RPG v2.0");
    expect(announcementServerName("Galera 2.5 & amigos")).toBe(
      "Galera 2.5 & amigos",
    );
  });

  it("picks the chip from the app's language", () => {
    expect(defaultAnnouncementLang("pt-BR")).toBe("pt-BR");
    expect(defaultAnnouncementLang("es")).toBe("es");
    expect(defaultAnnouncementLang("en")).toBe("en");
    expect(defaultAnnouncementLang("fr")).toBe("en");
  });
});

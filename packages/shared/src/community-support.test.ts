import { describe, expect, it } from "vitest";
import {
  COMMUNITY_LINKS_MAX,
  communityLinkSchema,
  communityLinksWithoutSupport,
  communitySupportOf,
  mergeCommunityLinks,
  normalizeCommunityLinks,
  parseCommunitySupport,
  parseStoredCommunityLinks,
  type CommunityLink,
} from "./communities.js";
import {
  COMMUNITY_SUPPORT_HOSTS,
  COMMUNITY_SUPPORT_PIX_MAX_LENGTH,
  isCommunitySupportHost,
  isPixCopiaECola,
  parseCommunitySupportUrl,
  parsePixSupport,
  pixCrc16,
} from "./community-support.js";

/** A static BR Code the way a bank app writes it, with its real CRC. */
function brCode(key = "rafa@pqp.gg", name = "RAFA"): string {
  const gui = `0014BR.GOV.BCB.PIX01${String(key.length).padStart(2, "0")}${key}`;
  const body =
    "000201" +
    `26${String(gui.length).padStart(2, "0")}${gui}` +
    "52040000" +
    "5303986" +
    "5802BR" +
    `59${String(name.length).padStart(2, "0")}${name}` +
    "6009SAO PAULO" +
    "62070503***" +
    "6304";
  return body + pixCrc16(body);
}

describe("the support host allowlist", () => {
  it("accepts every listed host, bare, with www and as a subdomain", () => {
    for (const host of COMMUNITY_SUPPORT_HOSTS) {
      expect(isCommunitySupportHost(host)).toBe(true);
      expect(isCommunitySupportHost(`www.${host}`)).toBe(true);
      expect(isCommunitySupportHost(`creator.${host}`)).toBe(true);
    }
  });

  it("names the rails creators actually use", () => {
    for (const host of [
      "livepix.gg",
      "apoia.se",
      "patreon.com",
      "ko-fi.com",
      "buymeacoffee.com",
      "cafecito.app",
      "catarse.me",
      "kick.com",
      "twitch.tv",
      "youtube.com",
      "paypal.me",
      "mercadopago.com.br",
    ]) {
      expect(COMMUNITY_SUPPORT_HOSTS).toContain(host);
    }
  });

  it("refuses look-alikes, paypal.com and anything unlisted", () => {
    for (const host of [
      "apoia.se.evil.com",
      "evilapoia.se",
      "patreon.com.br",
      "paypal.com",
      "example.com",
      "livepix.gg.example",
      "xko-fi.com",
    ]) {
      expect(isCommunitySupportHost(host)).toBe(false);
    }
  });

  it("holds only bare lower-case hosts, so the matcher stays honest", () => {
    for (const host of COMMUNITY_SUPPORT_HOSTS) {
      expect(host).toBe(host.toLowerCase());
      expect(host).not.toMatch(/^www\.|\/|:/);
    }
  });
});

describe("parseCommunitySupportUrl", () => {
  it("normalises an allowlisted https link", () => {
    expect(parseCommunitySupportUrl("https://livepix.gg/rafa")).toBe(
      "https://livepix.gg/rafa",
    );
    expect(parseCommunitySupportUrl("  https://www.apoia.se/rafa ")).toBe(
      "https://www.apoia.se/rafa",
    );
  });

  it("refuses open redirects on an allowed host and a URL that grows past the cap", () => {
    for (const raw of [
      "https://www.youtube.com/redirect?q=https%3A%2F%2Fattacker.example",
      "https://youtube.com/attribution_link?u=/x",
      "https://livepix.gg/rafa?next=https://attacker.example",
      "https://livepix.gg/rafa?next=//attacker.example",
      "https://livepix.gg/rafa#https://attacker.example",
    ]) {
      expect(parseCommunitySupportUrl(raw)).toBeNull();
    }
    // Ordinary query strings stay fine.
    expect(parseCommunitySupportUrl("https://youtube.com/@rafa/join?x=1")).not.toBeNull();
    // 100 accented letters are 100 characters typed and 600 once percent-encoded.
    expect(parseCommunitySupportUrl(`https://livepix.gg/${"é".repeat(100)}`)).toBeNull();
  });

  it("refuses http, credentials, other schemes and unlisted hosts", () => {
    expect(parseCommunitySupportUrl("http://livepix.gg/rafa")).toBeNull();
    expect(parseCommunitySupportUrl("https://u:p@livepix.gg/rafa")).toBeNull();
    expect(parseCommunitySupportUrl("javascript:alert(1)")).toBeNull();
    expect(parseCommunitySupportUrl("data:text/html,<b>x</b>")).toBeNull();
    expect(parseCommunitySupportUrl("https://example.com/rafa")).toBeNull();
    expect(parseCommunitySupportUrl("https://livepix.gg.evil.com/")).toBeNull();
    expect(parseCommunitySupportUrl("")).toBeNull();
    expect(
      parseCommunitySupportUrl(`https://livepix.gg/${"a".repeat(500)}`),
    ).toBeNull();
  });
});

describe("Pix", () => {
  it("checks the copia e cola CRC and the scheme", () => {
    const good = brCode();
    expect(isPixCopiaECola(good)).toBe(true);
    expect(parsePixSupport(` ${good}\n`)).toBe(good);
    // The classic mistake: the paste lost its last characters.
    expect(isPixCopiaECola(good.slice(0, -2))).toBe(false);
    // One changed character breaks the CRC.
    expect(isPixCopiaECola(good.replace("RAFA", "RAFE"))).toBe(false);
    // Not the Pix scheme, even with a matching CRC.
    const other = good.replace("BR.GOV.BCB.PIX", "BR.GOV.BCB.XXX");
    expect(isPixCopiaECola(other.slice(0, -4) + pixCrc16(other.slice(0, -4)))).toBe(
      false,
    );
  });

  it("computes the reference CRC16/CCITT-FALSE", () => {
    expect(pixCrc16("123456789")).toBe("29B1");
  });

  it("refuses an oversize or non-printable string", () => {
    expect(isPixCopiaECola(brCode("a".repeat(COMMUNITY_SUPPORT_PIX_MAX_LENGTH)))).toBe(
      false,
    );
    expect(parsePixSupport(`${brCode()}‮`)).toBeNull();
    expect(parsePixSupport(brCode().replace("SAO", "S\nO"))).toBeNull();
  });

  it("accepts the five key shapes", () => {
    expect(parsePixSupport("rafa@pqp.gg")).toBe("rafa@pqp.gg");
    expect(parsePixSupport("123.456.789-09")).toBe("123.456.789-09");
    expect(parsePixSupport("12345678909")).toBe("12345678909");
    expect(parsePixSupport("12.345.678/0001-95")).toBe("12.345.678/0001-95");
    expect(parsePixSupport("e8c2b7a4-1b2f-4c3d-8a9e-0123456789ab")).toBe(
      "e8c2b7a4-1b2f-4c3d-8a9e-0123456789ab",
    );
    expect(parsePixSupport("+55 (11) 99999-8888")).toBe("+5511999998888");
  });

  it("refuses things that are not a key, never mind how they look", () => {
    for (const raw of [
      "",
      "   ",
      "oi pessoal",
      "https://livepix.gg/rafa",
      "javascript:alert(1)",
      "<script>alert(1)</script>",
      "rafa@",
      "123",
      "+1 555 0100",
      "a".repeat(COMMUNITY_SUPPORT_PIX_MAX_LENGTH + 1),
    ]) {
      expect(parsePixSupport(raw)).toBeNull();
    }
  });
});

describe("parseCommunitySupport", () => {
  it("reads a page, a bare host path, a key and a copia e cola", () => {
    expect(parseCommunitySupport("https://livepix.gg/rafa")).toEqual({
      kind: "support",
      url: "https://livepix.gg/rafa",
    });
    expect(parseCommunitySupport("apoia.se/rafa")).toEqual({
      kind: "support",
      url: "https://apoia.se/rafa",
    });
    expect(parseCommunitySupport("rafa@pqp.gg")).toEqual({
      kind: "support",
      pix: "rafa@pqp.gg",
    });
    const code = brCode();
    expect(parseCommunitySupport(code)).toEqual({ kind: "support", pix: code });
  });

  it("takes a CNPJ for a Pix key and not for a host and a path", () => {
    expect(parseCommunitySupport("12.345.678/0001-95")).toEqual({
      kind: "support",
      pix: "12.345.678/0001-95",
    });
  });

  it("refuses everything else", () => {
    expect(parseCommunitySupport("")).toBeNull();
    expect(parseCommunitySupport("https://example.com/pay")).toBeNull();
    expect(parseCommunitySupport("http://livepix.gg/rafa")).toBeNull();
    expect(parseCommunitySupport("javascript:alert(1)")).toBeNull();
  });
});

describe("support in the stored list", () => {
  const url: CommunityLink = { kind: "support", url: "https://livepix.gg/rafa" };
  const pix: CommunityLink = { kind: "support", pix: "rafa@pqp.gg" };
  const twitch: CommunityLink = { kind: "twitch", url: "https://twitch.tv/rafa" };

  it("validates both shapes and refuses the broken ones", () => {
    expect(communityLinkSchema.safeParse(url).success).toBe(true);
    expect(communityLinkSchema.safeParse(pix).success).toBe(true);
    expect(communityLinkSchema.safeParse(twitch).success).toBe(true);
    // Both, neither, a pix on a chip, a url off the list, a bad key.
    expect(communityLinkSchema.safeParse({ ...url, pix: "rafa@pqp.gg" }).success).toBe(
      false,
    );
    expect(communityLinkSchema.safeParse({ kind: "support" }).success).toBe(false);
    expect(
      communityLinkSchema.safeParse({ kind: "site", pix: "rafa@pqp.gg" }).success,
    ).toBe(false);
    expect(
      communityLinkSchema.safeParse({
        kind: "support",
        url: "https://example.com/x",
      }).success,
    ).toBe(false);
    expect(
      communityLinkSchema.safeParse({ kind: "support", pix: "oi" }).success,
    ).toBe(false);
  });

  it("never lets the ordinary list create a support link", () => {
    const parsed = normalizeCommunityLinks([{ url: "https://livepix.gg/rafa" }]);
    expect(parsed?.map((l) => l.kind)).toEqual(["site"]);
  });

  it("keeps at most one support link and puts it last", () => {
    const stored = parseStoredCommunityLinks([url, twitch, pix]);
    expect(stored).toEqual([twitch, url]);
    expect(communitySupportOf(stored)).toEqual(url);
    expect(communityLinksWithoutSupport(stored)).toEqual([twitch]);
  });

  it("caps the ordinary links at eight and still keeps the support one", () => {
    const many = Array.from({ length: COMMUNITY_LINKS_MAX + 3 }, (_, i) => ({
      kind: "site" as const,
      url: `https://example.com/${i}`,
    }));
    const stored = parseStoredCommunityLinks([...many, pix]);
    expect(stored).toHaveLength(COMMUNITY_LINKS_MAX + 1);
    expect(stored.at(-1)).toEqual(pix);
  });

  it("drops one bad entry instead of blanking the list", () => {
    const stored = parseStoredCommunityLinks([
      twitch,
      { kind: "support", url: "https://example.com/x" },
      { kind: "bogus", url: "https://example.com/y" },
    ]);
    expect(stored).toEqual([twitch]);
    expect(parseStoredCommunityLinks("nope")).toEqual([]);
    expect(parseStoredCommunityLinks(null)).toEqual([]);
  });

  it("merges: a support URL that is also an ordinary chip appears once", () => {
    const dupe: CommunityLink = { kind: "site", url: "https://livepix.gg/rafa" };
    expect(mergeCommunityLinks([twitch, dupe], url)).toEqual([twitch, url]);
    expect(mergeCommunityLinks([twitch], null)).toEqual([twitch]);
  });
});

import { describe, expect, it } from "vitest";
import {
  canRenameHandle,
  claimHandleSchema,
  handleFromPath,
  handleRenameAvailableAt,
  HANDLE_PATTERN,
  HANDLE_PATTERN_SQL,
  HANDLE_RENAME_COOLDOWN_DAYS,
  monthStamp,
  monthStampToDate,
  normalizeHandle,
  publicDepoimentoSchema,
  publicProfileDisplayUrl,
  publicProfilePath,
  publicProfileSchema,
  publicProfileUrl,
  RESERVED_HANDLES,
  validateHandle,
} from "./profiles.js";

describe("normalizeHandle", () => {
  it("strips the @ people copy off the page", () => {
    expect(normalizeHandle("@rafa")).toBe("rafa");
    expect(normalizeHandle("@@rafa")).toBe("rafa");
  });

  it("lowercases, so one name is one person", () => {
    expect(normalizeHandle("RaFa")).toBe("rafa");
  });

  it("folds the accents a Brazilian keyboard produces", () => {
    expect(normalizeHandle("joão")).toBe("joao");
    expect(normalizeHandle("gonçalves")).toBe("goncalves");
    expect(normalizeHandle("münchen")).toBe("munchen");
  });

  it("turns whitespace into an underscore rather than dropping it", () => {
    expect(normalizeHandle("  rafa  cg ")).toBe("rafa_cg");
  });

  it("drops what the character set cannot hold", () => {
    expect(normalizeHandle("ra!fa#$%")).toBe("rafa");
  });

  it("caps at the maximum length", () => {
    expect(normalizeHandle("a".repeat(60))).toHaveLength(20);
  });

  it("is idempotent", () => {
    for (const raw of ["@João Silva!!", "RAFA__", "a".repeat(40), "..x.."]) {
      expect(normalizeHandle(normalizeHandle(raw))).toBe(normalizeHandle(raw));
    }
  });
});

describe("validateHandle", () => {
  it("accepts ordinary handles", () => {
    for (const ok of ["rafa", "rafa_cg", "rafa.cg", "rafa-cg", "abc", "x1y"]) {
      expect(validateHandle(ok)).toBeNull();
    }
  });

  it("refuses anything shorter than three or longer than twenty", () => {
    expect(validateHandle("ab")).toBe("length");
    expect(validateHandle("a".repeat(21))).toBe("length");
    expect(validateHandle("a".repeat(20))).toBeNull();
  });

  it("refuses leading or trailing punctuation", () => {
    expect(validateHandle(".rafa")).toBe("format");
    expect(validateHandle("rafa.")).toBe("format");
    expect(validateHandle("_rafa")).toBe("format");
    expect(validateHandle("-rafa")).toBe("format");
  });

  it("refuses uppercase and non-ascii — normalisation is the caller's job", () => {
    expect(validateHandle("Rafa")).toBe("format");
    expect(validateHandle("joão")).toBe("format");
  });

  it("refuses the reserved list, including the phishing-shaped words", () => {
    for (const word of ["app", "api", "admin", "pqp", "suporte", "legal", "www", "ajuda", "oficial", "seguranca"]) {
      expect(RESERVED_HANDLES.has(word)).toBe(true);
      expect(validateHandle(word)).toBe("reserved");
    }
  });

  it("reserves the claim landing's own paths", () => {
    expect(validateHandle("garanta")).toBe("reserved");
    expect(validateHandle("claim")).toBe("reserved");
  });

  it("reserves the screen-share landing's path", () => {
    expect(validateHandle("tela")).toBe("reserved");
  });

  it("refuses slurs, and refuses them through leetspeak and padding", () => {
    expect(validateHandle("viado")).toBe("blocked");
    expect(validateHandle("v1ado_oficial2")).toBe("blocked");
    expect(validateHandle("v.i.a.d.o")).toBe("blocked");
    expect(validateHandle("n1gg3r")).toBe("blocked");
    expect(validateHandle("pedofilo123")).toBe("blocked");
  });

  it("refuses the ambiguous slurs only when they stand alone", () => {
    expect(validateHandle("macaco")).toBe("blocked");
    expect(validateHandle("macacos_fc")).toBeNull();
    expect(validateHandle("bicha")).toBe("blocked");
    expect(validateHandle("bichano")).toBeNull();
  });

  it("does not moralise about swearing — the product is named after an expletive", () => {
    for (const swear of ["porra", "caralho", "merda", "putaria", "foda"]) {
      expect(validateHandle(swear)).toBeNull();
    }
  });

  it("lets Brazilian laughter through, which a naive kkk block would not", () => {
    expect(validateHandle("kkkkk")).toBeNull();
    expect(validateHandle("rindo_kkk")).toBeNull();
  });
});

describe("HANDLE_PATTERN_SQL", () => {
  it("is the same expression the JavaScript pattern carries", () => {
    // The database CHECK is the last line of defence and is written by hand in
    // schema.sql; if these drift, one of the two stops defending anything.
    expect(HANDLE_PATTERN.source).toBe(HANDLE_PATTERN_SQL);
  });
});

describe("claimHandleSchema", () => {
  it("normalises before validating, so @Rafa is a valid claim for rafa", () => {
    expect(claimHandleSchema.parse({ handle: "@Rafa" })).toEqual({
      handle: "rafa",
    });
  });

  it("rejects a claim that normalises to something unusable", () => {
    expect(claimHandleSchema.safeParse({ handle: "!!" }).success).toBe(false);
    expect(claimHandleSchema.safeParse({ handle: "admin" }).success).toBe(false);
  });

  it("refuses a body long enough to be an attack rather than a typo", () => {
    expect(
      claimHandleSchema.safeParse({ handle: "a".repeat(500) }).success,
    ).toBe(false);
  });
});

describe("the rename cooldown", () => {
  const claimed = "2026-01-01T00:00:00.000Z";

  it("does not apply to an account that has never claimed one", () => {
    expect(canRenameHandle(null, null)).toBe(true);
    expect(handleRenameAvailableAt(null, null)).toBeNull();
  });

  it("blocks a second change inside the window", () => {
    const day = new Date("2026-01-20T00:00:00.000Z");
    expect(canRenameHandle(claimed, "rafa", day)).toBe(false);
  });

  it("opens again once the window has passed", () => {
    const after = new Date("2026-02-05T00:00:00.000Z");
    expect(canRenameHandle(claimed, "rafa", after)).toBe(true);
  });

  it("reports exactly when the next change is allowed", () => {
    const at = handleRenameAvailableAt(claimed, "rafa");
    expect(at?.toISOString()).toBe("2026-01-31T00:00:00.000Z");
    expect(HANDLE_RENAME_COOLDOWN_DAYS).toBe(30);
  });

  it("treats an unparseable timestamp as no cooldown rather than a permanent one", () => {
    expect(canRenameHandle("not a date", "rafa")).toBe(true);
  });
});

describe("profile URLs", () => {
  it("puts the @ in exactly one place", () => {
    expect(publicProfilePath("rafa")).toBe("/@rafa");
    expect(publicProfileUrl("rafa")).toBe("https://pqp.gg/@rafa");
    expect(publicProfileDisplayUrl("rafa")).toBe("pqp.gg/@rafa");
  });

  it("takes an origin so a preview deploy links to itself", () => {
    expect(publicProfileUrl("rafa", "https://pqp-3yr.pages.dev")).toBe(
      "https://pqp-3yr.pages.dev/@rafa",
    );
  });
});

describe("handleFromPath", () => {
  it("reads the handle out of a profile path", () => {
    expect(handleFromPath("/@rafa")).toBe("rafa");
    expect(handleFromPath("/@rafa/")).toBe("rafa");
    expect(handleFromPath("/@Rafa")).toBe("rafa");
  });

  it("answers null for every other path the SPA serves", () => {
    for (const path of ["/", "/app", "/privacy", "/garanta", "/@", "/@rafa/x", "/rafa"]) {
      expect(handleFromPath(path)).toBeNull();
    }
  });

  it("answers null for a path no handle could ever have", () => {
    expect(handleFromPath("/@ab")).toBeNull();
    expect(handleFromPath("/@" + "a".repeat(40))).toBeNull();
    expect(handleFromPath("/@" + encodeURIComponent("joão"))).toBeNull();
  });

  it("does NOT truncate — a long path is no profile, not a shorter one", () => {
    // Lossy normalisation would make `/@rafaelcammaranoguglielmi` resolve to
    // whoever holds `rafaelcammaranogugl`, which is somebody else's page.
    expect(handleFromPath("/@rafaelcammaranoguglielmi")).toBeNull();
  });

  it("still answers for a reserved word — shape is not the claim rule", () => {
    // `/@admin` is a well-formed profile URL that nobody holds. The API 404s it
    // like any other unclaimed name, and the page says so; treating it as a
    // malformed path here would make two identical outcomes look different.
    expect(handleFromPath("/@admin")).toBe("admin");
    expect(validateHandle("admin")).toBe("reserved");
  });
});

describe("publicProfileSchema", () => {
  it("parses the thin shape the public endpoint answers", () => {
    const parsed = publicProfileSchema.parse({
      handle: "rafa",
      displayName: "Rafa",
      avatarUrl: null,
      badges: [
        {
          id: "11111111-1111-4111-8111-111111111111",
          name: "Futebol",
          category: "futebol",
        },
      ],
      depoimentoCount: 3,
    });
    expect(parsed.badges).toHaveLength(1);
  });

  it("has no field that identifies the account behind it", () => {
    // The point of the shape. If somebody adds `id`, `tag` or `email` here,
    // this is the test that should stop them and make them argue for it.
    //
    // Fields added since the first cut each had to argue: `bannerUrl` is an
    // image the account holder uploaded for this page, `depoimentos` are words
    // two people published to it, `memberSince` is a MONTH, `achievements`
    // carry only a badge slug, and `connections` is an opt-in list of Steam /
    // Battle.net / Twitch nicks — never a provider user id.
    const keys = Object.keys(publicProfileSchema.shape).sort();
    expect(keys).toEqual([
      "achievements",
      "avatarUrl",
      "badges",
      "bannerUrl",
      "connections",
      "depoimentoCount",
      "depoimentos",
      "displayName",
      "handle",
      "memberSince",
    ]);
  });

  it("defaults every field a payload from an older API omits", () => {
    // The three new fields are `.default()`ed rather than required, so a client
    // built against this schema still parses a response from a deployment that
    // predates banners, rendered depoimentos and the join month. That is not
    // politeness — Cloudflare Pages and Railway deploy independently, so an
    // older API answering a newer bundle is an ordinary Tuesday.
    const parsed = publicProfileSchema.parse({
      handle: "rafa",
      displayName: "Rafa",
      avatarUrl: null,
      badges: [],
      depoimentoCount: 0,
    });
    expect(parsed.bannerUrl).toBeNull();
    expect(parsed.depoimentos).toEqual([]);
    expect(parsed.memberSince).toBeNull();
    expect(parsed.connections).toEqual([]);
  });

  it("refuses a memberSince carrying a day", () => {
    // Month granularity is the whole reason this field was allowed onto a page
    // served to the open internet. A schema that accepted `2026-07-14` would
    // make that a server-side convention rather than a contract.
    expect(() =>
      publicProfileSchema.parse({
        handle: "rafa",
        displayName: "Rafa",
        avatarUrl: null,
        badges: [],
        depoimentoCount: 0,
        memberSince: "2026-07-14",
      }),
    ).toThrow();
  });
});

describe("publicDepoimentoSchema", () => {
  it("carries the author as a name and a face, never as an identity", () => {
    // A depoimento must not become a way to enumerate the people who know
    // somebody. No id, no tag — and the handle only when the author claimed
    // one, which is a page they chose to have.
    const keys = Object.keys(publicDepoimentoSchema.shape).sort();
    expect(keys).toEqual(["author", "body", "id"]);
    const parsed = publicDepoimentoSchema.parse({
      id: "11111111-1111-4111-8111-111111111111",
      body: "conheci essa mulher jogando valorant às 3 da manhã",
      author: { displayName: "Bia", handle: null, avatarUrl: null },
    });
    expect(parsed.author.handle).toBeNull();
  });
});

describe("month stamps", () => {
  it("truncates to the month in UTC", () => {
    // UTC deliberately: an account created at 23:30 on the 31st must not read
    // as a different month depending on who is looking at the page.
    expect(monthStamp(new Date("2026-07-31T23:30:00.000Z"))).toBe("2026-07");
    expect(monthStamp("2026-01-01T00:00:00.000Z")).toBe("2026-01");
    expect(monthStamp(null)).toBeNull();
    expect(monthStamp("not a date")).toBeNull();
  });

  it("round-trips into a Date pinned inside that month", () => {
    // Noon rather than midnight, because midnight UTC is the previous day in
    // Brazil and a "member since" a month early for the whole audience is the
    // exact bug this helper exists to prevent.
    const date = monthStampToDate("2026-07")!;
    expect(date.getUTCFullYear()).toBe(2026);
    expect(date.getUTCMonth()).toBe(6);
    expect(
      date.toLocaleDateString("pt-BR", {
        month: "long",
        year: "numeric",
        timeZone: "America/Sao_Paulo",
      }),
    ).toContain("julho");
  });

  it("refuses anything that is not a month stamp", () => {
    expect(monthStampToDate("2026")).toBeNull();
    expect(monthStampToDate("2026-13")).toBeNull();
    expect(monthStampToDate(null)).toBeNull();
  });
});

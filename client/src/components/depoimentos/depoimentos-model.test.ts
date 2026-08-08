import { describe, expect, it } from "vitest";
import type { Server } from "@pqp/shared";
import {
  canSubmitDepoimento,
  canWriteDepoimento,
  communityOverflow,
  DEPOIMENTO_MAX_LENGTH,
  depoimentoDate,
  depoimentoRemaining,
  offersProfileVisibility,
  waitingOnYou,
} from "./depoimentos-model";

const SERVER: Server = {
  id: "11111111-1111-1111-1111-111111111111",
  name: "Eu odeio acordar cedo",
  ownerId: "22222222-2222-2222-2222-222222222222",
  createdAt: "2026-07-01T00:00:00.000Z",
  messageRetentionDays: null,
  ssoEmailDomain: null,
  iconUrl: null,
  bannerUrl: null,
  isCommunity: true,
  showOnProfile: true,
};

describe("canWriteDepoimento", () => {
  it("offers the composer to a friend and to nobody else", () => {
    expect(canWriteDepoimento("friends")).toBe(true);
    for (const state of [
      "none",
      "self",
      "blocked",
      "pendingIncoming",
      "pendingOutgoing",
    ] as const) {
      expect(canWriteDepoimento(state)).toBe(false);
    }
  });

  /**
   * The one worth naming: half a handshake is not a friendship. Drawing
   * "escrever depoimento" while a request is still unanswered earns the author
   * a 403 they have no way to explain.
   */
  it("refuses a half-finished handshake in both directions", () => {
    expect(canWriteDepoimento("pendingIncoming")).toBe(false);
    expect(canWriteDepoimento("pendingOutgoing")).toBe(false);
  });
});

describe("the composer's counter", () => {
  it("counts what the server counts, which is the trimmed text", () => {
    expect(depoimentoRemaining("  oi  ")).toBe(DEPOIMENTO_MAX_LENGTH - 2);
  });

  it("goes negative so the counter can turn red before the request fails", () => {
    expect(depoimentoRemaining("a".repeat(DEPOIMENTO_MAX_LENGTH + 3))).toBe(-3);
  });

  it("holds submit closed on empty, whitespace and overlong", () => {
    expect(canSubmitDepoimento("")).toBe(false);
    expect(canSubmitDepoimento("   \n ")).toBe(false);
    expect(canSubmitDepoimento("a".repeat(DEPOIMENTO_MAX_LENGTH + 1))).toBe(
      false,
    );
    expect(canSubmitDepoimento("a".repeat(DEPOIMENTO_MAX_LENGTH))).toBe(true);
  });
});

describe("depoimentoDate", () => {
  /**
   * A profile is ordered by `approved_at`, so the date drawn has to be the one
   * the order is in — otherwise the list reads as shuffled.
   */
  it("shows the published date once there is one", () => {
    expect(
      depoimentoDate(
        {
          createdAt: "2026-03-02T00:00:00.000Z",
          approvedAt: "2026-07-02T00:00:00.000Z",
        },
        "en-US",
      ),
    ).toBe("July 2026");
  });

  it("falls back to when it was written while it is still pending", () => {
    expect(
      depoimentoDate(
        { createdAt: "2026-03-02T00:00:00.000Z", approvedAt: null },
        "en-US",
      ),
    ).toBe("March 2026");
  });

  /** Month precision: a keepsake, not a log entry. */
  it("never shows a day", () => {
    expect(
      depoimentoDate(
        { createdAt: "2026-03-02T00:00:00.000Z", approvedAt: null },
        "pt-BR",
      ),
    ).not.toMatch(/\b2\b/);
  });
});

describe("communityOverflow", () => {
  const chip = { id: SERVER.id, name: SERVER.name };

  it("is null when everything fits, so no +0 is ever drawn", () => {
    expect(communityOverflow({ communities: [chip], total: 1 })).toBeNull();
    expect(communityOverflow({ communities: [], total: 0 })).toBeNull();
  });

  it("counts what the cap left out", () => {
    expect(
      communityOverflow({ communities: [chip, chip, chip], total: 11 }),
    ).toBe(8);
  });
});

describe("offersProfileVisibility", () => {
  it("offers the switch on a listed community", () => {
    expect(offersProfileVisibility(SERVER)).toBe(true);
  });

  /**
   * Not on a private server — the switch would be a no-op there, and worse, it
   * would imply private servers are shown by default.
   */
  it("stays off a private server", () => {
    expect(offersProfileVisibility({ ...SERVER, isCommunity: false })).toBe(
      false,
    );
  });
});

describe("waitingOnYou", () => {
  it("adds the two errands that are answered from the same screen", () => {
    expect(waitingOnYou({ friendRequests: 2, pendingDepoimentos: 3 })).toBe(5);
  });

  it("is zero when nothing is waiting, so the badge does not render", () => {
    expect(waitingOnYou({ friendRequests: 0, pendingDepoimentos: 0 })).toBe(0);
  });
});

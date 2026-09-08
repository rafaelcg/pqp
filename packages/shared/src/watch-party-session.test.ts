import { describe, expect, it } from "vitest";
import {
  canPerformWatchPartyAction,
  canTransitionWatchParty,
  isWatchPartyHostGraceOpen,
  isWatchPartyPreLive,
  isWatchPartyTerminal,
  PERMISSION_DEFAULT_EVERYONE,
  PERMISSION_DEFAULT_MANAGER,
  PERMISSION_DEFAULT_MODERATOR,
  Permission,
  resolveWatchPartyHost,
  WATCH_PARTY_ACTIONS,
  WATCH_PARTY_HOST_GRACE_MS,
  WATCH_PARTY_PHASES,
  watchPartyOptionsSchema,
  watchPartyRole,
  type WatchPartyAction,
  type WatchPartyRole,
  type WatchPartyPhase,
} from "./index.js";

const HOST = "11111111-1111-4111-8111-111111111111";
const COHOST = "22222222-2222-4222-8222-222222222222";
const RANDOM = "33333333-3333-4333-8333-333333333333";
const MOD = "44444444-4444-4444-8444-444444444444";

const everyone = PERMISSION_DEFAULT_EVERYONE;
/** Gerente: every bit but Administrator, so this is what buys MANAGE_CHANNELS. */
const manager = PERMISSION_DEFAULT_MANAGER;

function roleOf(userId: string, permissions = everyone): WatchPartyRole {
  return watchPartyRole({
    userId,
    hostUserId: HOST,
    cohostUserIds: [COHOST],
    permissions,
  });
}

describe("watchPartyRole", () => {
  it("ranks host over co-host over manager over viewer", () => {
    expect(roleOf(HOST)).toBe("host");
    expect(roleOf(COHOST)).toBe("cohost");
    expect(roleOf(MOD, manager)).toBe("manager");
    expect(roleOf(RANDOM)).toBe("viewer");
  });

  it("does not make a Moderador a manager: they start parties, they do not stop them", () => {
    // `PERMISSION_DEFAULT_MODERATOR` carries START_WATCH_PARTY and NOT
    // MANAGE_CHANNELS, so a mod may run their own party and has no authority
    // over anyone else's. If that ever changes, this is the test that says so.
    expect(roleOf(MOD, everyone | PERMISSION_DEFAULT_MODERATOR)).toBe("viewer");
  });

  it("keeps the host as host even when they also hold MANAGE_CHANNELS", () => {
    expect(roleOf(HOST, manager)).toBe("host");
  });

  it("keeps a co-host as co-host even when they also hold MANAGE_CHANNELS", () => {
    // Otherwise a moderator who was promoted to co-host would silently lose
    // `claimHost`, which only co-hosts have.
    expect(roleOf(COHOST, manager)).toBe("cohost");
  });

  it("needs MANAGE_CHANNELS specifically, not any elevated bit", () => {
    expect(
      watchPartyRole({
        userId: RANDOM,
        hostUserId: HOST,
        cohostUserIds: [],
        permissions: everyone | Permission.START_WATCH_PARTY,
      }),
    ).toBe("viewer");
  });
});

describe("the state machine", () => {
  it("only allows the moves in the table", () => {
    const legal = new Set([
      "draft>scheduled",
      "draft>live",
      "draft>cancelled",
      "scheduled>draft",
      "scheduled>live",
      "scheduled>ended",
      "scheduled>cancelled",
      "live>ended",
    ]);
    for (const from of WATCH_PARTY_PHASES) {
      for (const to of WATCH_PARTY_PHASES) {
        expect([from, to, canTransitionWatchParty(from, to)]).toEqual([
          from,
          to,
          legal.has(`${from}>${to}`),
        ]);
      }
    }
  });

  it("never leaves a terminal state, including back to itself", () => {
    for (const from of ["ended", "cancelled"] as const) {
      expect(isWatchPartyTerminal(from)).toBe(true);
      for (const to of WATCH_PARTY_PHASES) {
        expect(canTransitionWatchParty(from, to)).toBe(false);
      }
    }
  });

  it("does not let a live party be cancelled, only ended", () => {
    expect(canTransitionWatchParty("live", "cancelled")).toBe(false);
    expect(canTransitionWatchParty("live", "ended")).toBe(true);
  });

  it("does not let a draft be ended, because nobody was promised it", () => {
    expect(canTransitionWatchParty("draft", "ended")).toBe(false);
    expect(canTransitionWatchParty("draft", "cancelled")).toBe(true);
  });

  it("lets a scheduled party be pulled back to a draft, and not the reverse of a live one", () => {
    expect(canTransitionWatchParty("scheduled", "draft")).toBe(true);
    expect(canTransitionWatchParty("live", "draft")).toBe(false);
    expect(canTransitionWatchParty("live", "scheduled")).toBe(false);
  });

  it("agrees with isWatchPartyPreLive about what has not been broadcast", () => {
    expect(WATCH_PARTY_PHASES.filter(isWatchPartyPreLive)).toEqual([
      "draft",
      "scheduled",
    ]);
  });
});

describe("who may do what", () => {
  const allow = (
    action: WatchPartyAction,
    role: WatchPartyRole,
    state: WatchPartyPhase,
  ) => canPerformWatchPartyAction({ action, role, state });

  it("hides a draft from everyone but the host and co-hosts", () => {
    expect(allow("view", "host", "draft")).toBe(true);
    expect(allow("view", "cohost", "draft")).toBe(true);
    expect(allow("view", "manager", "draft")).toBe(false);
    expect(allow("view", "viewer", "draft")).toBe(false);
  });

  it("shows every other state to everyone who can view the channel", () => {
    for (const state of ["scheduled", "live", "ended", "cancelled"] as const) {
      expect(allow("view", "viewer", state)).toBe(true);
    }
  });

  it("lets the host and a co-host go live, and nobody else", () => {
    for (const state of ["draft", "scheduled"] as const) {
      expect(allow("goLive", "host", state)).toBe(true);
      expect(allow("goLive", "cohost", state)).toBe(true);
      expect(allow("goLive", "manager", state)).toBe(false);
      expect(allow("goLive", "viewer", state)).toBe(false);
    }
  });

  it("never lets anyone go live twice, or go live on a finished party", () => {
    for (const state of ["live", "ended", "cancelled"] as const) {
      expect(allow("goLive", "host", state)).toBe(false);
    }
  });

  it("lets a manager end and edit a live party but never start one", () => {
    expect(allow("end", "manager", "live")).toBe(true);
    expect(allow("edit", "manager", "live")).toBe(true);
    expect(allow("goLive", "manager", "draft")).toBe(false);
    expect(allow("schedule", "manager", "draft")).toBe(false);
  });

  it("does not let a viewer touch anything", () => {
    for (const action of WATCH_PARTY_ACTIONS) {
      for (const state of WATCH_PARTY_PHASES) {
        if (action === "view") {
          continue;
        }
        expect([action, state, allow(action, "viewer", state)]).toEqual([
          action,
          state,
          false,
        ]);
      }
    }
  });

  it("keeps the co-host out of the roster: no promote, demote or transfer", () => {
    for (const action of [
      "promoteCohost",
      "demoteCohost",
      "transferHost",
    ] as const) {
      expect(allow(action, "host", "live")).toBe(true);
      expect(allow(action, "cohost", "live")).toBe(false);
      expect(allow(action, "manager", "live")).toBe(false);
    }
  });

  it("only offers claimHost to a co-host, and only while the host is gone", () => {
    const now = 1_000_000;
    const base = {
      action: "claimHost" as const,
      state: "live" as const,
      now,
    };
    expect(
      canPerformWatchPartyAction({
        ...base,
        role: "cohost",
        hostDisconnectedAt: null,
      }),
    ).toBe(false);
    expect(
      canPerformWatchPartyAction({
        ...base,
        role: "cohost",
        hostDisconnectedAt: now - 1000,
      }),
    ).toBe(true);
    expect(
      canPerformWatchPartyAction({
        ...base,
        role: "manager",
        hostDisconnectedAt: now - 1000,
      }),
    ).toBe(false);
    expect(
      canPerformWatchPartyAction({
        ...base,
        role: "host",
        hostDisconnectedAt: now - 1000,
      }),
    ).toBe(false);
  });

  it("closes claimHost once the grace window has expired", () => {
    const now = 1_000_000;
    expect(
      canPerformWatchPartyAction({
        action: "claimHost",
        role: "cohost",
        state: "live",
        now,
        hostDisconnectedAt: now - WATCH_PARTY_HOST_GRACE_MS - 1,
      }),
    ).toBe(false);
  });

  it("does not offer claimHost on a party that is not live", () => {
    const now = 1_000_000;
    for (const state of ["draft", "scheduled", "ended", "cancelled"] as const) {
      expect(
        canPerformWatchPartyAction({
          action: "claimHost",
          role: "cohost",
          state,
          now,
          hostDisconnectedAt: now - 1000,
        }),
      ).toBe(false);
    }
  });

  it("only cancels a party that has not gone live", () => {
    expect(allow("cancel", "host", "draft")).toBe(true);
    expect(allow("cancel", "host", "scheduled")).toBe(true);
    expect(allow("cancel", "host", "live")).toBe(false);
    expect(allow("cancel", "host", "ended")).toBe(false);
  });

  it("only ends a party that is live", () => {
    expect(allow("end", "host", "live")).toBe(true);
    expect(allow("end", "host", "draft")).toBe(false);
    expect(allow("end", "host", "ended")).toBe(false);
  });

  it("never allows anything but view on a terminal party", () => {
    for (const action of WATCH_PARTY_ACTIONS) {
      for (const role of ["host", "cohost", "manager"] as const) {
        for (const state of ["ended", "cancelled"] as const) {
          expect([action, role, state, allow(action, role, state)]).toEqual([
            action,
            role,
            state,
            action === "view",
          ]);
        }
      }
    }
  });
});

describe("the host disconnect", () => {
  const now = 10_000_000;

  it("does nothing while the host is connected", () => {
    expect(
      resolveWatchPartyHost({ state: "live", hostDisconnectedAt: null, now }),
    ).toBe("hold");
  });

  it("holds the party through the grace window", () => {
    expect(
      resolveWatchPartyHost({
        state: "live",
        hostDisconnectedAt: now - WATCH_PARTY_HOST_GRACE_MS + 1,
        now,
      }),
    ).toBe("grace");
  });

  it("ends the party the moment the window closes", () => {
    expect(
      resolveWatchPartyHost({
        state: "live",
        hostDisconnectedAt: now - WATCH_PARTY_HOST_GRACE_MS,
        now,
      }),
    ).toBe("end");
  });

  it("never ends a party that is not live", () => {
    for (const state of ["draft", "scheduled", "ended", "cancelled"] as const) {
      expect(
        resolveWatchPartyHost({
          state,
          hostDisconnectedAt: now - WATCH_PARTY_HOST_GRACE_MS - 1,
          now,
        }),
      ).toBe("hold");
    }
  });

  it("treats the grace window as open at the instant of the drop", () => {
    expect(isWatchPartyHostGraceOpen({ hostDisconnectedAt: now, now })).toBe(
      true,
    );
  });

  it("takes a grace override, so a test does not wait five minutes", () => {
    expect(
      resolveWatchPartyHost({
        state: "live",
        hostDisconnectedAt: now - 50,
        now,
        graceMs: 40,
      }),
    ).toBe("end");
  });
});

describe("the options", () => {
  it("defaults to open, reactions on, slow mode off", () => {
    expect(watchPartyOptionsSchema.parse({})).toEqual({
      slowModeSeconds: 0,
      reactionsEnabled: true,
      stageMode: "open",
    });
  });

  it("refuses a slow mode longer than six hours, the channel settings ceiling", () => {
    expect(watchPartyOptionsSchema.safeParse({ slowModeSeconds: 21600 }).success)
      .toBe(true);
    expect(watchPartyOptionsSchema.safeParse({ slowModeSeconds: 21601 }).success)
      .toBe(false);
    expect(watchPartyOptionsSchema.safeParse({ slowModeSeconds: -1 }).success)
      .toBe(false);
  });

  it("refuses a stage mode it does not know", () => {
    expect(watchPartyOptionsSchema.safeParse({ stageMode: "invite" }).success)
      .toBe(false);
  });
});

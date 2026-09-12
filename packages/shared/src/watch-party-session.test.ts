import { describe, expect, it } from "vitest";
import {
  isLiveWatchPartySurface,
  watchPartySurface,
  WATCH_PARTY_SURFACES,
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
  mayTakeWatchPartySeat,
  stageModeClosesTheFloor,
  watchPartyFloorIsClosed,
  watchPartyOptionsSchema,
  watchPartyRole,
  watchPartySpeakAffordance,
  withLegacyWatchPartyVoice,
  type WatchPartyAction,
  type WatchPartyOptions,
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

  it("lets a manager edit a live party but never start, end or cancel one", () => {
    // 2026-09-12: `end` used to be true here too, and a server admin who was
    // only watching a live party ended the host's show with it. Ending and
    // cancelling are now host/cohost-only, same as goLive.
    expect(allow("edit", "manager", "live")).toBe(true);
    expect(allow("end", "manager", "live")).toBe(false);
    expect(allow("cancel", "manager", "draft")).toBe(false);
    expect(allow("cancel", "manager", "scheduled")).toBe(false);
    expect(allow("goLive", "manager", "draft")).toBe(false);
    expect(allow("schedule", "manager", "draft")).toBe(false);
  });

  it("still lets the host and a co-host end and cancel", () => {
    expect(allow("end", "host", "live")).toBe(true);
    expect(allow("end", "cohost", "live")).toBe(true);
    expect(allow("cancel", "host", "draft")).toBe(true);
    expect(allow("cancel", "cohost", "scheduled")).toBe(true);
  });

  it("lets the host and a co-host rename while the party is live", () => {
    expect(allow("edit", "host", "live")).toBe(true);
    expect(allow("edit", "cohost", "live")).toBe(true);
    expect(allow("edit", "viewer", "live")).toBe(false);
    expect(allow("edit", "host", "ended")).toBe(false);
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
  it("gives a party no voice at all by default, and closes the stage under it", () => {
    // THE WHOLE OBJECT, because a default that drifts has no symptom until a
    // room is full. `voiceEnabled: false` is the one that decides whether
    // this party ever touches the channel's permissions; `hosts_only` is the
    // floor it would close if somebody turned voice on without picking one.
    expect(watchPartyOptionsSchema.parse({})).toEqual({
      voiceEnabled: false,
      stageMode: "hosts_only",
      raiseHand: true,
      slowModeSeconds: 0,
      reactionsEnabled: true,
    });
  });

  it("closes the floor only when voice is actually on", () => {
    // THE ONE QUESTION EVERY OVERWRITE WRITE IS GATED ON. A stored stage mode
    // on a party with no voice is a preference nobody activated, not a rule,
    // and it must not reach `channel_overwrites`: a rule that is never
    // written cannot be left behind.
    const options = (over: Partial<WatchPartyOptions>) =>
      watchPartyOptionsSchema.parse(over);
    expect(
      watchPartyFloorIsClosed(options({ voiceEnabled: false, stageMode: "hosts_only" })),
    ).toBe(false);
    expect(
      watchPartyFloorIsClosed(options({ voiceEnabled: false, stageMode: "invited" })),
    ).toBe(false);
    expect(
      watchPartyFloorIsClosed(options({ voiceEnabled: true, stageMode: "hosts_only" })),
    ).toBe(true);
    expect(
      watchPartyFloorIsClosed(options({ voiceEnabled: true, stageMode: "invited" })),
    ).toBe(true);
    // Voice on with an open floor still writes nothing: there is no floor to
    // close, which is what it always meant.
    expect(
      watchPartyFloorIsClosed(options({ voiceEnabled: true, stageMode: "everyone" })),
    ).toBe(false);
  });

  it("reads a party stored before voiceEnabled existed as having voice", () => {
    // A row written by an older build has no key, and it was set up when
    // every watch party was a voice room. Taking voice away from a party that
    // is already running is the one thing this change must not do.
    const legacy = { stageMode: "hosts_only", raiseHand: true, slowModeSeconds: 0, reactionsEnabled: true };
    expect(
      watchPartyOptionsSchema.parse(withLegacyWatchPartyVoice(legacy)).voiceEnabled,
    ).toBe(true);

    // PRESENCE OF THE KEY IS THE TEST, so an explicit false written since is
    // untouched. Reading it as "falsy, therefore missing" would have made
    // every new party a voice party, which is the failure this whole change
    // exists to prevent and would have looked identical from the outside.
    expect(
      watchPartyOptionsSchema.parse(
        withLegacyWatchPartyVoice({ ...legacy, voiceEnabled: false }),
      ).voiceEnabled,
    ).toBe(false);

    // An empty object is a legacy row too: `parseOptions` hands `{}` in for a
    // NULL column, and a party with a NULL options column predates this.
    expect(
      watchPartyOptionsSchema.parse(withLegacyWatchPartyVoice({})).voiceEnabled,
    ).toBe(true);

    // Junk is left for the schema to reject rather than repaired into a
    // valid party.
    expect(withLegacyWatchPartyVoice(null)).toBeNull();
    expect(withLegacyWatchPartyVoice("nope")).toBe("nope");
  });

  it("knows which modes close the floor to everyone", () => {
    expect(stageModeClosesTheFloor("hosts_only")).toBe(true);
    expect(stageModeClosesTheFloor("invited")).toBe(true);
    expect(stageModeClosesTheFloor("everyone")).toBe(false);
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
    expect(watchPartyOptionsSchema.safeParse({ stageMode: "open" }).success)
      .toBe(false);
  });
});

describe("who may take a seat in a watch party's room", () => {
  const party = (over: Partial<{
    voiceEnabled: boolean;
    isHost: boolean;
    isCohost: boolean;
    isInvited: boolean;
  }> = {}) => ({
    voiceEnabled: false,
    isHost: false,
    isCohost: false,
    isInvited: false,
    ...over,
  });

  it("refuses the audience of a party with no voice", () => {
    // THE MODEL. Watching is a socket; a seat is a LiveKit participant and
    // forwarded streams against an envelope of about 600. At five hundred
    // viewers that difference is whether the media box holds.
    expect(
      mayTakeWatchPartySeat({ canStartWatchParty: false, party: party() }),
    ).toBe(false);
  });

  it("always lets the people running the party in", () => {
    // Each of these three separately, because they are three different
    // reasons and a co-host is the one that cannot be derived from a bit: the
    // host may promote any member, permission or not.
    expect(
      mayTakeWatchPartySeat({ canStartWatchParty: true, party: party() }),
    ).toBe(true);
    expect(
      mayTakeWatchPartySeat({
        canStartWatchParty: false,
        party: party({ isHost: true }),
      }),
    ).toBe(true);
    expect(
      mayTakeWatchPartySeat({
        canStartWatchParty: false,
        party: party({ isCohost: true }),
      }),
    ).toBe(true);
  });

  it("lets in somebody the host invited up, which is the point of inviting them", () => {
    expect(
      mayTakeWatchPartySeat({
        canStartWatchParty: false,
        party: party({ isInvited: true }),
      }),
    ).toBe(true);
  });

  it("lets everybody in once a host turns voice on", () => {
    // The film night. From here `stageMode` decides who may SPEAK, through
    // the ordinary overwrite, exactly as it did before.
    expect(
      mayTakeWatchPartySeat({
        canStartWatchParty: false,
        party: party({ voiceEnabled: true }),
      }),
    ).toBe(true);
  });

  it("leaves a channel with no party running alone", () => {
    // NOT A CLOSED ROOM. A `watch_party` channel with nothing running is an
    // ordinary voice room, which is exactly what a build with
    // `VITE_WATCH_PARTY_CHANNELS` off already promises. Refusing here would
    // break a deployment that has the channel type and not the feature.
    expect(
      mayTakeWatchPartySeat({ canStartWatchParty: false, party: null }),
    ).toBe(true);
  });
});

describe("which control a person is offered for speaking", () => {
  const opts = (over: Partial<WatchPartyOptions> = {}) =>
    watchPartyOptionsSchema.parse({ voiceEnabled: true, ...over });

  it("offers Falar to anyone the server already lets speak", () => {
    for (const role of ["host", "cohost", "manager", "viewer"] as const) {
      expect(
        watchPartySpeakAffordance({ options: opts(), role, canSpeak: true }),
      ).toBe("speak");
    }
  });

  it("offers a viewer nothing at all in a party with no voice", () => {
    // AND THE ORDER MATTERS. With voice off the server writes no overwrite,
    // so `canSpeak` is whatever the channel's everyday default says, which is
    // usually true. Asking that first would put a Falar button on every
    // viewer's screen in exactly the parties meant to have none.
    for (const canSpeak of [true, false]) {
      for (const stageMode of ["hosts_only", "invited", "everyone"] as const) {
        expect(
          watchPartySpeakAffordance({
            options: opts({ voiceEnabled: false, stageMode, raiseHand: true }),
            role: "viewer",
            canSpeak,
          }),
        ).toBe("none");
      }
    }
    // A manager is not running the party either: MANAGE_CHANNELS ends and
    // edits somebody else's show, it does not perform in it.
    expect(
      watchPartySpeakAffordance({
        options: opts({ voiceEnabled: false }),
        role: "manager",
        canSpeak: true,
      }),
    ).toBe("none");
  });

  it("still offers the people running a voiceless party the microphone", () => {
    // They have a seat and they are the ones who might present. Taking the
    // button off the host as well would mean a party nobody can talk in even
    // when the host wants to say one sentence over the film.
    for (const role of ["host", "cohost"] as const) {
      expect(
        watchPartySpeakAffordance({
          options: opts({ voiceEnabled: false }),
          role,
          canSpeak: true,
        }),
      ).toBe("speak");
    }
  });

  it("offers nothing to a viewer on a hosts-only stage", () => {
    // The whole point: no button, therefore no microphone prompt, therefore
    // none of the "you joined without a microphone" copy Rafael was shown.
    expect(
      watchPartySpeakAffordance({
        options: opts({ stageMode: "hosts_only" }),
        role: "viewer",
        canSpeak: false,
      }),
    ).toBe("none");
  });

  it("offers a raised hand only when the stage takes invitations and hands are on", () => {
    expect(
      watchPartySpeakAffordance({
        options: opts({ stageMode: "invited", raiseHand: true }),
        role: "viewer",
        canSpeak: false,
      }),
    ).toBe("raiseHand");
    expect(
      watchPartySpeakAffordance({
        options: opts({ stageMode: "invited", raiseHand: false }),
        role: "viewer",
        canSpeak: false,
      }),
    ).toBe("none");
    expect(
      watchPartySpeakAffordance({
        options: opts({ stageMode: "everyone", raiseHand: true }),
        role: "viewer",
        canSpeak: false,
      }),
    ).toBe("none");
  });

  it("always offers the host and co-hosts the microphone, grant lag or not", () => {
    for (const role of ["host", "cohost"] as const) {
      expect(
        watchPartySpeakAffordance({
          options: opts({ stageMode: "hosts_only" }),
          role,
          canSpeak: false,
        }),
      ).toBe("speak");
    }
    // A manager is not running the show and gets no shortcut onto the stage.
    expect(
      watchPartySpeakAffordance({
        options: opts({ stageMode: "hosts_only" }),
        role: "manager",
        canSpeak: false,
      }),
    ).toBe("none");
  });
});

describe("which surface a watch party channel shows", () => {
  const surface = (
    state: WatchPartyPhase | null,
    hasStream: boolean,
    inCall = false,
    canStart = true,
  ) => watchPartySurface({ state, hasStream, inCall, canStart });

  /**
   * THE BUG THIS WHOLE BLOCK EXISTS FOR. Rafael photographed a channel showing
   * "Nenhuma watch party rolando aqui" with a Criar watch party button, and
   * the live stage playing directly underneath it. The empty state asked the
   * party object and the stage asked the room, and both were right.
   */
  it("never offers to create a party while the channel is live", () => {
    for (const state of [null, "scheduled", "ended", "cancelled"] as const) {
      for (const inCall of [false, true]) {
        for (const canStart of [false, true]) {
          const answer = watchPartySurface({
            state,
            hasStream: true,
            inCall,
            canStart,
          });
          expect([state, inCall, canStart, answer]).toEqual([
            state,
            inCall,
            canStart,
            state === "scheduled" ? "live" : "liveUntitled",
          ]);
        }
      }
    }
  });

  it("never shows a live surface when nothing is live and no party is running", () => {
    for (const state of [null, "ended", "cancelled"] as const) {
      expect(isLiveWatchPartySurface(surface(state, false))).toBe(false);
    }
  });

  it("gives exactly one answer for every combination of inputs", () => {
    // A total function over the cross product is the property that makes two
    // surfaces impossible: the panel renders `surface` and nothing else.
    const states: (WatchPartyPhase | null)[] = [null, ...WATCH_PARTY_PHASES];
    for (const state of states) {
      for (const hasStream of [false, true]) {
        for (const inCall of [false, true]) {
          for (const canStart of [false, true]) {
            const answer = watchPartySurface({
              state,
              hasStream,
              inCall,
              canStart,
            });
            expect(WATCH_PARTY_SURFACES).toContain(answer);
          }
        }
      }
    }
  });

  it("shows the empty state only to someone who could actually start one", () => {
    expect(surface(null, false, false, true)).toBe("empty");
    expect(surface(null, false, false, false)).toBe("none");
  });

  it("does not offer to create a party over a quiet room you are sitting in", () => {
    expect(surface(null, false, true, true)).toBe("none");
  });

  it("keeps the setup surface for the host whatever the room is doing", () => {
    expect(surface("draft", false)).toBe("setup");
    expect(surface("draft", true)).toBe("setup");
  });

  it("does not draw a countdown over a moving picture", () => {
    expect(surface("scheduled", false)).toBe("scheduled");
    expect(surface("scheduled", true)).toBe("live");
  });

  it("treats a finished party with a stream still running as live, not empty", () => {
    // The reverse case: the party ended and the presenter kept sharing. The
    // stale answer would have been the create button over a live picture.
    expect(surface("ended", true)).toBe("liveUntitled");
    expect(surface("ended", false, false, true)).toBe("empty");
  });
});

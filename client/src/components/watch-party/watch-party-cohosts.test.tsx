import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { WatchParty } from "@pqp/shared";
import {
  canAppointCohosts,
  WatchPartyCohosts,
  type CohostCandidate,
} from "./watch-party-cohosts";

/**
 * The control that makes the co-host role reachable at all.
 *
 * WHY EVERY CASE HERE IS ABOUT WHO IS OFFERED WHAT.
 * `POST /api/watch-parties/:id/cohosts`, the `channel_session_cohosts` table
 * and `setWatchPartyCohost` in `lib/watch-parties-api.ts` all shipped and
 * nothing ever called them, so the feature was complete on both sides of the
 * wire and unreachable in the middle. Nothing catches that: not a type, not
 * the server suite, not a screenshot of a party running fine. A picker that
 * offers the wrong person is the same class of bug wearing a different hat, so
 * the assertions below are about the roster the host is shown rather than
 * about the markup around it.
 */

const HOST_ID = "44444444-4444-4444-8444-444444444444";

const PARTY: WatchParty = {
  id: "11111111-1111-4111-8111-111111111111",
  channelId: "22222222-2222-4222-8222-222222222222",
  serverId: "33333333-3333-4333-8333-333333333333",
  name: "Cinemoon",
  description: null,
  state: "live",
  startsAt: null,
  wentLiveAt: "2026-09-08T12:00:00.000Z",
  endedAt: null,
  hostUserId: HOST_ID,
  hostDisplayName: "Alice",
  hostAvatarUrl: null,
  hostDisconnectedAt: null,
  cohosts: [],
  options: {
    stageMode: "hosts_only",
    raiseHand: true,
    slowModeSeconds: 0,
    reactionsEnabled: true,
  },
  viewerRole: "host",
  reminding: false,
  stage: { invited: [], hands: [], handRaised: false },
};

function person(n: number, over: Partial<CohostCandidate> = {}): CohostCandidate {
  return {
    userId: `5555555${n}-5555-4555-8555-555555555555`,
    displayName: `Person ${n}`,
    avatarUrl: null,
    ...over,
  };
}

function render(
  over: Partial<WatchParty> = {},
  candidates: readonly CohostCandidate[] = [person(1), person(2)],
) {
  return renderToStaticMarkup(
    <WatchPartyCohosts
      party={{ ...PARTY, ...over }}
      candidates={candidates}
      onPromote={async () => {}}
      onDemote={async () => {}}
    />,
  );
}

/** Which people the host is offered a Promover button for. */
function promotable(html: string): string[] {
  return [...html.matchAll(/data-watch-party-cohost-promote="([^"]+)"/g)].map(
    (hit) => hit[1],
  );
}

/** Which people the host is offered a Tirar button for. */
function demotable(html: string): string[] {
  return [...html.matchAll(/data-watch-party-cohost-demote="([^"]+)"/g)].map(
    (hit) => hit[1],
  );
}

describe("the co-host list", () => {
  it("offers the host somebody to promote in every state a promotion is legal", () => {
    // `promoteCohost` is legal in draft, scheduled and live, and the reason
    // the draft matters most is that it is the only one where a host can
    // arrange a backup BEFORE their connection is the single point of failure.
    for (const state of ["draft", "scheduled", "live"] as const) {
      const html = render({ state });
      expect(promotable(html), state).toEqual([
        person(1).userId,
        person(2).userId,
      ]);
    }
  });

  it("draws nothing at all for a co-host, a manager or a viewer", () => {
    /**
     * A CO-HOST RUNS THE PARTY AND NOT THE ROSTER, and this is the surface
     * where that rule is either kept or broken. The moment a co-host can
     * promote, a co-host can demote the host and there is no chain of
     * authority left; succession is `claimHost`, gated on the host being gone.
     * A manager may end somebody's party and never staff it.
     */
    for (const role of ["cohost", "manager", "viewer"] as const) {
      expect(render({ viewerRole: role }), role).toBe("");
    }
  });

  it("draws nothing once the party is over", () => {
    // `ended` and `cancelled` are terminal. A roster control on a party that
    // has finished would write rows nothing will ever read or clean up.
    for (const state of ["ended", "cancelled"] as const) {
      expect(render({ state }), state).toBe("");
    }
  });

  it("never offers the host their own badge", () => {
    // `POST .../cohosts` answers 409 for the host's own id. Offering a button
    // whose only outcome is an error is worse than not drawing it.
    const html = render({}, [person(1), { ...person(2), userId: HOST_ID }]);
    expect(promotable(html)).toEqual([person(1).userId]);
  });

  it("moves somebody from the offer to the list once they hold the badge", () => {
    const cohost = person(1);
    const html = render(
      {
        cohosts: [
          {
            userId: cohost.userId,
            displayName: cohost.displayName,
            avatarUrl: null,
          },
        ],
      },
      [cohost, person(2)],
    );
    // One row per person, and never both: a name in the offer AND in the list
    // is a host being asked to promote somebody who already runs the party.
    expect(demotable(html)).toEqual([cohost.userId]);
    expect(promotable(html)).toEqual([person(2).userId]);
  });

  it("never offers a character account", () => {
    // The house cast has no browser to take a party over with. A bot in this
    // list is a promotion that looks like a safety net and is not one.
    const html = render({}, [person(1), person(2, { isCharacter: true })]);
    expect(promotable(html)).toEqual([person(1).userId]);
  });

  it("adds the filter only once the list stops being readable", () => {
    const eight = Array.from({ length: 8 }, (_, i) => person(i));
    expect(render({}, eight)).not.toContain("data-watch-party-cohost-filter");
    // Nine is where scanning a server's member list stops being realistic,
    // and a big server is exactly the case a watch party is for.
    const nine = Array.from({ length: 9 }, (_, i) => person(i));
    expect(render({}, nine)).toContain("data-watch-party-cohost-filter");
  });

  it("answers the framing surface the same question it answers itself", () => {
    /**
     * `canAppointCohosts` is what the panel asks before drawing the divider
     * above this section, and it has to agree with the component's own gate or
     * a co-host gets an empty bordered box under the options: a separator with
     * nothing to separate, which reads as a control that failed to load rather
     * than one they do not have. Two copies of the rule is how that happens,
     * so there is one and this is the case that says so.
     */
    for (const state of ["draft", "scheduled", "live"] as const) {
      const party = { ...PARTY, state };
      expect(canAppointCohosts(party), state).toBe(true);
      expect(render({ state }) !== "", state).toBe(true);
    }
    for (const role of ["cohost", "manager", "viewer"] as const) {
      const party = { ...PARTY, viewerRole: role };
      expect(canAppointCohosts(party), role).toBe(false);
      expect(render({ viewerRole: role }), role).toBe("");
    }
    for (const state of ["ended", "cancelled"] as const) {
      expect(canAppointCohosts({ ...PARTY, state }), state).toBe(false);
      expect(render({ state }), state).toBe("");
    }
  });

  it("says so when there is nobody to promote", () => {
    // A silent empty list reads as a control that failed to load. The whole
    // reason this component exists is that an absent surface is indisputable
    // to a person and invisible to everything else.
    const html = render({}, []);
    expect(promotable(html)).toEqual([]);
    expect(html).toContain("Nobody else in the server to promote");
  });
});

describe("the offer is a shortlist, not the membership", () => {
  /**
   * `candidates` is the SERVER'S MEMBER LIST, which on the QG is 2078 people.
   * Every one of them used to be rendered: an avatar, a name and a Promote
   * button each. Measured on the local sandbox on 12 Sep 2026 with 106
   * members, the options panel put 104 promote rows in the DOM and the
   * section pushed everything under it, including the go-live control on the
   * setup surface, off the bottom of the pane. `max-h-48` bounded what was
   * VISIBLE and not what was BUILT, which is the wrong half.
   */
  const crowd = Array.from({ length: 40 }, (_, i) => person(i));

  it("draws five and never the whole server", () => {
    const html = render({}, crowd);
    expect(promotable(html)).toHaveLength(5);
  });

  it("says how many it did not draw, so nothing is silently hidden", () => {
    // A cut list with no count reads as a list that ended, and a host looking
    // for somebody outside the first five would conclude they are not in the
    // server.
    const html = render({}, crowd);
    expect(html).toContain('data-watch-party-cohost-more="35"');
  });

  it("counts what the filter left, not what the server holds", () => {
    // The count is about this query. Filtering to six names says "1 more",
    // not "35 more", or it is describing a list nobody is looking at.
    const short = Array.from({ length: 5 }, (_, i) => person(i));
    expect(render({}, short)).not.toContain("data-watch-party-cohost-more");
  });
});

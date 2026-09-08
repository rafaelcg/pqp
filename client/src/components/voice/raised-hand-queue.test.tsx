import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";
import { RAISED_HAND_LIST_LIMIT, type VoiceParticipant } from "@pqp/shared";
import { TooltipProvider } from "@/components/ui/tooltip";
import { setActiveCatalogue } from "@/lib/i18n";
import { RaisedHandQueue } from "./raised-hand-queue";

/**
 * What the room sees. The ordering rule itself is pinned in
 * `packages/shared/src/raised-hands.test.ts`; this is about the panel actually
 * printing it, printing YOUR position however far back it is, and offering the
 * lower control only to somebody who may use it.
 */

afterEach(() => {
  setActiveCatalogue(undefined);
});

function person(
  userId: string,
  handRaisedAt: number | null,
): VoiceParticipant {
  return {
    peerId: `peer-${userId}`,
    userId,
    displayName: userId,
    avatarUrl: null,
    sharingScreen: false,
    muted: false,
    deafened: false,
    serverMuted: false,
    handRaisedAt,
  };
}

function render(
  participants: VoiceParticipant[],
  props: Partial<Parameters<typeof RaisedHandQueue>[0]> = {},
) {
  return renderToStaticMarkup(
    // The app mounts one of these at the root; the lower control's tooltip
    // needs it here for the same reason every other tooltip does.
    <TooltipProvider>
      <RaisedHandQueue
        participants={participants}
        selfUserId={null}
        {...props}
      />
    </TooltipProvider>,
  );
}

/** The names, in the order the panel actually printed them. */
function printed(html: string): string[] {
  return [...html.matchAll(/data-hand-queue-entry="([^"]+)"/g)].map(
    (match) => match[1]!,
  );
}

describe("RaisedHandQueue", () => {
  it("draws nothing when no hand is up", () => {
    expect(render([person("alice", null), person("bob", null)])).toBe("");
  });

  it("prints the queue oldest first, whatever order the roster arrived in", () => {
    const html = render([
      person("carol", 300),
      person("alice", 100),
      person("bob", 200),
    ]);
    expect(printed(html)).toEqual(["alice", "bob", "carol"]);
  });

  it("says where you are, and says next rather than a number at the front", () => {
    const room = [person("alice", 100), person("bob", 200), person("me", 300)];
    expect(render(room, { selfUserId: "me" })).toContain('data-hand-position="3"');

    const front = [person("me", 100), person("bob", 200)];
    const html = render(front, { selfUserId: "me" });
    expect(html).toContain('data-hand-position="1"');
    expect(html).toContain("You are next");
  });

  it("counts the tail instead of printing it, and still gives you your place", () => {
    const room = Array.from({ length: RAISED_HAND_LIST_LIMIT + 3 }, (_, i) =>
      person(`u${i}`, 100 + i),
    );
    const last = `u${RAISED_HAND_LIST_LIMIT + 2}`;
    const html = render(room, { selfUserId: last });
    expect(printed(html)).toHaveLength(RAISED_HAND_LIST_LIMIT);
    expect(html).toContain("+3");
    // The person in the tail is still told exactly where they stand, which is
    // the fact that stops them asking again.
    expect(html).toContain(
      `data-hand-position="${RAISED_HAND_LIST_LIMIT + 3}"`,
    );
  });

  it("offers the lower control only to somebody who holds the bit", () => {
    const room = [person("alice", 100)];
    expect(render(room)).not.toContain("data-hand-lower");
    expect(
      render(room, { canLowerHands: true, onLowerHand: () => {} }),
    ).toContain('data-hand-lower="alice"');
    // A handler with no permission is still no button: the server would
    // refuse it, and a control that always fails is worse than none.
    expect(render(room, { onLowerHand: () => {} })).not.toContain(
      "data-hand-lower",
    );
  });

  it("collapses to one line and a count for the call strip", () => {
    const room = [person("alice", 100), person("bob", 200), person("me", 300)];
    const html = render(room, { compact: true, selfUserId: "me" });
    // One name, the rest as a number, and your own place. No list, because
    // the strip is a line: the whole queue is on the sidebar rows.
    expect(printed(html)).toEqual(["alice"]);
    expect(html).toContain("+2");
    expect(html).toContain('data-hand-position="3"');
    // Never the lower control: a moderator uses the sidebar row's menu.
    expect(
      render(room, {
        compact: true,
        canLowerHands: true,
        onLowerHand: () => {},
      }),
    ).not.toContain("data-hand-lower");
  });

  it("speaks Portuguese when the catalogue is Portuguese", async () => {
    const pt = (
      await import("@/locales/pt-BR/translation.json", {
        with: { type: "json" },
      })
    ).default as Record<string, string>;
    setActiveCatalogue(pt);
    const html = render([person("me", 100), person("bob", 200)], {
      selfUserId: "bob",
    });
    expect(html).toContain("Fila pra falar");
    expect(html).toContain("Você é o 2º na fila");
  });
});

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";
import {
  CALL_SPLIT_DEFAULT,
  MIN_CHAT_HEIGHT_PX,
  MIN_STAGE_HEIGHT_PX,
  type CallSplitPreference,
  type CallStageShape,
} from "@/lib/call-split";
import { CallSplit } from "./call-split";

/**
 * THE INVARIANT THIS FILE EXISTS FOR.
 *
 * `lib/remote-video-delivery.ts` pauses an SFU publication a second after the
 * last `<video>` bound to it goes away. A layout that unmounted the stage —
 * to move it into a different branch for the side-by-side arrangement, say —
 * would therefore not merely re-render: the server would stop sending that
 * camera and the viewer would be looking at black a moment later, in a layout
 * that otherwise looks correct. So the tests below check where the stage IS in
 * the tree, not only that it rendered.
 *
 * A Node test cannot observe React reconciling, but it can observe the thing
 * reconciliation depends on: with the same element types in the same child
 * slots, React keeps the DOM node and the `<video>` with it. The structural
 * comparison here is that check, and it fails the moment a layout branches.
 */

/** Element openings and their markers, with class/style noise dropped. */
function shape(html: string): string[] {
  const tags = html.match(/<[a-z]+[^>]*>/g) ?? [];
  return tags.map((tag) => {
    const name = /^<([a-z]+)/.exec(tag)?.[1] ?? "?";
    const markers = (tag.match(/data-[a-z-]+(="[^"]*")?/g) ?? [])
      // The root's own label names the arrangement, so of course it differs.
      // Everything else about the tree must not.
      .filter((marker) => !marker.startsWith('data-call-split="'))
      .sort();
    const role = /role="[a-z]+"/.exec(tag)?.[0] ?? "";
    return [name, role, ...markers].join(" ").trim();
  });
}

function render(node: React.ReactElement) {
  return renderToStaticMarkup(<TooltipProvider>{node}</TooltipProvider>);
}

const TALL = { width: 1400, height: 900 };

/** Somebody has dragged. Until they have, the stage still sizes itself. */
const DRAGGED: CallSplitPreference = {
  ...CALL_SPLIT_DEFAULT,
  stacked: 0.68,
};

function split({
  shape: stageShape = "expanded" as CallStageShape,
  preference = DRAGGED as CallSplitPreference,
  paneSize = TALL,
}: {
  shape?: CallStageShape;
  preference?: CallSplitPreference;
  paneSize?: { width: number; height: number };
} = {}) {
  return render(
    <CallSplit
      shape={stageShape}
      preference={preference}
      onPreferenceChange={() => {}}
      paneSize={paneSize}
      stage={
        <div data-testid="stage">
          <video data-testid="stage-video" />
        </div>
      }
    >
      <div data-testid="chat" />
    </CallSplit>,
  );
}

describe("CallSplit keeps the stage mounted", () => {
  it("puts the same stage in the same slot in both orientations", () => {
    const stacked = split();
    const side = split({
      preference: { ...CALL_SPLIT_DEFAULT, orientation: "side-by-side" },
    });

    // Both really are the layout they claim to be, or the comparison below
    // would be comparing one layout with itself.
    expect(stacked).toContain('data-call-split="stacked"');
    expect(side).toContain('data-call-split="side-by-side"');

    // Same elements, same order, same markers. Only classes differ, which is
    // what React reconciles in place rather than remounting.
    expect(shape(side)).toEqual(shape(stacked));
  });

  it("mounts a video on the stage in every layout it can draw", () => {
    for (const html of [
      split(),
      split({ preference: { ...CALL_SPLIT_DEFAULT, orientation: "side-by-side" } }),
      split({ shape: "compact" }),
      split({ shape: "fullscreen" }),
      // Too short to split: the un-split fallback, which is a phone sideways.
      split({ paneSize: { width: 780, height: 300 } }),
    ]) {
      expect(html).toContain('data-testid="stage-video"');
      expect(html).toContain('data-testid="chat"');
    }
  });

  it("keeps the stage ahead of the transcript in the DOM, both ways round", () => {
    for (const html of [
      split(),
      split({ preference: { ...CALL_SPLIT_DEFAULT, orientation: "side-by-side" } }),
    ]) {
      expect(html.indexOf('data-call-split-stage')).toBeLessThan(
        html.indexOf('data-testid="call-split-divider"'),
      );
      expect(html.indexOf('data-testid="call-split-divider"')).toBeLessThan(
        html.indexOf('data-testid="chat"'),
      );
    }
  });
});

describe("CallSplit draws a divider only where one can move", () => {
  it("offers it on an expanded stage", () => {
    expect(split()).toContain('data-testid="call-split-divider"');
  });

  it("offers none on a slim bar, a fullscreen stage, or no call at all", () => {
    for (const stageShape of ["compact", "fullscreen", "none"] as const) {
      expect(split({ shape: stageShape })).not.toContain(
        'data-testid="call-split-divider"',
      );
    }
  });

  it("offers none where the pane cannot hold both minimums", () => {
    const short = split({ paneSize: { width: 900, height: 300 } });
    expect(short).not.toContain('data-testid="call-split-divider"');
    // And the stage is left to size itself, as it did before any of this.
    expect(short).not.toMatch(/data-call-split-stage[^>]*style/);
  });

  it("leaves the stage sizing itself until somebody moves the divider", () => {
    // The whole point of the null: shipping this must not move anybody's
    // first render. The handle is there to be grabbed, and nothing else has
    // changed about the layout until it is.
    const untouched = split({ preference: CALL_SPLIT_DEFAULT });
    expect(untouched).toContain('data-testid="call-split-divider"');
    expect(untouched).not.toMatch(/data-call-split-stage[^>]*style=/);
    expect(untouched).not.toContain("data-call-split-sized");
  });

  it("takes the size over as soon as there is a stored fraction", () => {
    expect(split()).toContain("data-call-split-sized");
  });

  it("sizes side by side straight away, having no older layout to keep", () => {
    const side = split({
      preference: { ...CALL_SPLIT_DEFAULT, orientation: "side-by-side" },
    });
    expect(side).toContain('data-call-split="side-by-side"');
    expect(side).toMatch(/data-call-split-stage[^>]*style="width:\s*\d+px/);
  });

  it("sizes the stage in the axis it is being split on", () => {
    expect(split()).toMatch(/data-call-split-stage[^>]*style="height:\s*\d+px/);
    expect(
      split({
        preference: { ...CALL_SPLIT_DEFAULT, orientation: "side-by-side" },
      }),
    ).toMatch(/data-call-split-stage[^>]*style="width:\s*\d+px/);
  });

  it("falls back to stacked when the pane is too narrow for two columns", () => {
    const narrow = split({
      preference: { ...DRAGGED, orientation: "side-by-side" },
      paneSize: { width: 560, height: 900 },
    });
    expect(narrow).toContain('data-call-split="stacked"');
    // And on the stacked fraction, not the side-by-side one: the pane is a
    // column now, so the column's number is the one that applies.
    expect(narrow).toMatch(/data-call-split-stage[^>]*style="height:/);
  });
});

describe("CallSplit's divider", () => {
  it("is a focusable separator that says where it is", () => {
    const html = split();
    expect(html).toContain('role="separator"');
    expect(html).toContain('tabindex="0"');
    expect(html).toContain('aria-orientation="horizontal"');
    expect(html).toContain('aria-valuenow="68"');
  });

  it("turns with the layout, so the arrow keys point the right way", () => {
    expect(
      split({
        preference: { ...CALL_SPLIT_DEFAULT, orientation: "side-by-side" },
      }),
    ).toContain('aria-orientation="vertical"');
  });

  it("reports the ends it will actually stop at", () => {
    const html = split({ paneSize: { width: 1400, height: 908 } });
    const min = Math.round((MIN_STAGE_HEIGHT_PX / 900) * 100);
    const max = Math.round(((900 - MIN_CHAT_HEIGHT_PX) / 900) * 100);
    expect(html).toContain(`aria-valuemin="${min}"`);
    expect(html).toContain(`aria-valuemax="${max}"`);
  });

  it("clamps a stored fraction that would starve the transcript", () => {
    const html = split({
      preference: { ...CALL_SPLIT_DEFAULT, stacked: 1 },
      paneSize: { width: 1400, height: 908 },
    });
    expect(html).toMatch(
      new RegExp(`style="height:\\s*${900 - MIN_CHAT_HEIGHT_PX}px`),
    );
  });
});

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";
import { CameraTile, RoomView, type StagePerson } from "./call-stage";

/**
 * A stage tile MOUNTS A `<video>`, and that is not a cosmetic detail.
 *
 * `lib/remote-video-delivery.ts` pauses an SFU publication a second after the
 * last `<video>` bound to it goes away, and `bindRemoteVideo` is what does the
 * binding — from inside `StageVideo`, on mount. So a tile that renders a
 * placeholder instead of a video element is not merely a missing picture: the
 * server stops sending that camera, and what the viewer eventually sees is
 * black. The old rail parked tiles deliberately for exactly this saving; the
 * stage must never park one, because everything on the stage is by definition
 * being looked at.
 */

function person(overrides: Partial<StagePerson> = {}): StagePerson {
  return {
    key: "peer-1",
    name: "Ana",
    avatarUrl: null,
    stream: null,
    speaking: false,
    muted: false,
    serverMuted: false,
    connecting: false,
    isSelf: false,
    ...overrides,
  };
}

/** A stand-in: the element never reaches a DOM here, only the markup does. */
const fakeStream = {} as unknown as MediaStream;

function render(node: React.ReactElement) {
  return renderToStaticMarkup(<TooltipProvider>{node}</TooltipProvider>);
}

describe("CameraTile", () => {
  it("mounts a video for a publisher, labelled with whose camera it is", () => {
    const html = render(
      <CameraTile person={person({ stream: fakeStream })} youLabel="(you)" />,
    );
    expect(html).toContain("<video");
    expect(html).toContain('aria-label="Ana&#x27;s camera"');
  });

  it("falls back to the avatar only when there is no picture at all", () => {
    const html = render(<CameraTile person={person()} youLabel="(you)" />);
    expect(html).not.toContain("<video");
  });

  it("carries the fullscreen control and the name badge", () => {
    const html = render(
      <CameraTile
        person={person({ stream: fakeStream })}
        youLabel="(you)"
        onToggleFullscreen={() => {}}
      />,
    );
    expect(html).toContain('data-testid="camera-fullscreen"');
    expect(html).toContain('data-call-tile="Ana"');
  });

  it("keeps the pin control reachable, which is what makes a tile the wide one", () => {
    const html = render(
      <CameraTile
        person={person({ stream: fakeStream })}
        youLabel="(you)"
        onPin={() => {}}
        pinned
      />,
    );
    expect(html).toContain('aria-label="Unpin"');
  });

  it("answers a click on the picture once the stage holds more than one tile", () => {
    const alone = render(
      <CameraTile
        person={person({ stream: fakeStream })}
        youLabel="(you)"
        onToggleFullscreen={() => {}}
      />,
    );
    expect(alone).not.toContain('data-testid="tile-click-target"');

    const shared = render(
      <CameraTile
        person={person({ stream: fakeStream })}
        youLabel="(you)"
        clickToFullscreen
        onToggleFullscreen={() => {}}
      />,
    );
    expect(shared).toContain('data-testid="tile-click-target"');
    expect(shared).toContain('aria-label="View Ana fullscreen"');
  });
});

/**
 * Nobody publishing. The stage is only ever expanded here for a beat — the
 * last camera going off collapses it — but a beat of an empty black box is
 * what "the call broke" looks like, so it draws the room instead.
 */
describe("RoomView", () => {
  it("draws the people who are here, and says why there is no picture", () => {
    const html = render(
      <RoomView
        people={[
          person({ key: "a", name: "Ana" }),
          person({ key: "b", name: "Bia" }),
        ]}
        youLabel="(you)"
      />,
    );
    expect(html).toContain('data-call-listener="Ana"');
    expect(html).toContain('data-call-listener="Bia"');
    expect(html).toContain("Nobody has a camera or a screen on");
    expect(html).not.toContain("<video");
  });

  it("counts a room too big to draw, rather than drawing all of it", () => {
    const html = render(
      <RoomView
        people={Array.from({ length: 200 }, (_, i) =>
          person({ key: `p${i}`, name: `P${i}` }),
        )}
        youLabel="(you)"
      />,
    );
    expect(html.match(/data-call-listener=/g)).toHaveLength(12);
    expect(html).toContain("+188");
  });
});

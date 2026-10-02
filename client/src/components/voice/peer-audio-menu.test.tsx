import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { PeerAudioMenu, PictureVolume } from "./peer-audio-menu";

/**
 * The one panel that carries a person's sound.
 *
 * These assertions are the contract a real viewer depends on: two independent
 * sliders, named, with the level said out loud. Per-peer volume shipped and
 * then hid behind hover for months, so what is pinned here is that the control
 * EXISTS and SAYS WHAT IT IS, not merely that the component renders.
 */

function render(node: React.ReactElement) {
  return renderToStaticMarkup(node);
}

describe("PeerAudioMenu", () => {
  it("draws a voice slider named after the person", () => {
    const html = render(
      <PeerAudioMenu
        name="Ana"
        open
        voice={{ volume: 1, onSetVolume: () => {} }}
      />,
    );
    expect(html).toContain('data-testid="peer-audio-menu"');
    expect(html).toContain('data-testid="peer-audio-voice"');
    expect(html).toContain('type="range"');
    expect(html).toContain('aria-label="Volume for Ana"');
    expect(html).toContain("100%");
  });

  it("draws the screen share as its own slider, separate from the voice", () => {
    const html = render(
      <PeerAudioMenu
        name="Ana"
        open
        voice={{ volume: 1, onSetVolume: () => {} }}
        share={{ volume: 0.5, onSetVolume: () => {} }}
      />,
    );
    expect(html).toContain('data-testid="peer-audio-voice"');
    expect(html).toContain('data-testid="peer-audio-share"');
    expect(html).toContain('aria-label="Screen share volume for Ana"');
    // Two ranges, not one: turning the film down must not turn the person down.
    expect(html.match(/type="range"/g)).toHaveLength(2);
    expect(html).toContain("50%");
  });

  it("omits the share row for somebody who is not sharing sound", () => {
    const html = render(
      <PeerAudioMenu
        name="Ana"
        open
        voice={{ volume: 1, onSetVolume: () => {} }}
      />,
    );
    expect(html).not.toContain('data-testid="peer-audio-share"');
  });

  it("offers unmute rather than mute once a person is silenced", () => {
    const html = render(
      <PeerAudioMenu
        name="Ana"
        open
        voice={{ volume: 0, onSetVolume: () => {} }}
      />,
    );
    expect(html).toContain('aria-label="Unmute Ana"');
    expect(html).toContain('aria-pressed="true"');
    expect(html).toContain("0%");
  });

  it("keeps Retry reachable on a peer whose connection died", () => {
    const html = render(
      <PeerAudioMenu name="Ana" open failed onRetry={() => {}} />,
    );
    expect(html).toContain("Retry");
  });

  it("draws nothing while closed, and nothing when there is no knob at all", () => {
    expect(
      render(
        <PeerAudioMenu
          name="Ana"
          open={false}
          voice={{ volume: 1, onSetVolume: () => {} }}
        />,
      ),
    ).toBe("");
    expect(render(<PeerAudioMenu name="Ana" open />)).toBe("");
  });
});

describe("PictureVolume", () => {
  it("draws the slider on the picture, named for the sound it sets", () => {
    const html = render(
      <PictureVolume
        name="Ana"
        kind="share"
        track={{ volume: 0.4, onSetVolume: () => {} }}
      />,
    );
    expect(html).toContain('data-picture-volume="share"');
    expect(html).toContain('type="range"');
    expect(html).toContain("Screen share volume for Ana");
    expect(html).toContain("Mute Ana&#x27;s screen share");
  });

  it("shows a silenced person as silenced, and offers to bring them back", () => {
    const html = render(
      <PictureVolume
        name="Ana"
        kind="voice"
        track={{ volume: 0, onSetVolume: () => {} }}
      />,
    );
    expect(html).toContain("text-danger");
    expect(html).toContain('aria-pressed="true"');
  });
});

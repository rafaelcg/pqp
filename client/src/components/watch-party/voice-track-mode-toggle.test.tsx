import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { VoiceTrackModeToggle } from "./voice-track-mode-toggle";

/**
 * THE HOST'S OWN CHOICE, NAMED AND STATED. Two radios, one checked, the
 * explainer underneath — the contract a host depends on to know which mode
 * they are actually in, the same shape `peer-audio-menu.test.tsx` pins for
 * its own sliders.
 */
function render(node: React.ReactElement) {
  return renderToStaticMarkup(node);
}

describe("VoiceTrackModeToggle", () => {
  it("checks 'junto' by default", () => {
    const html = render(<VoiceTrackModeToggle mode="junto" onChange={() => {}} />);
    expect(html).toContain('data-testid="voice-track-mode-toggle"');
    expect(html).toContain('role="radiogroup"');
    expect(html).toContain('data-testid="voice-track-mode-junto"');
    expect(html).toContain('data-testid="voice-track-mode-separada"');
    // Exactly one radio checked, and it is the "junto" button.
    expect(html.match(/aria-checked="true"/g)).toHaveLength(1);
    expect(html).toMatch(
      /aria-checked="true"[^>]*data-testid="voice-track-mode-junto"/,
    );
  });

  it("checks 'separada' when that is the mode", () => {
    const html = render(<VoiceTrackModeToggle mode="separada" onChange={() => {}} />);
    expect(html).toMatch(
      /aria-checked="true"[^>]*data-testid="voice-track-mode-separada"/,
    );
    expect(html.match(/aria-checked="true"/g)).toHaveLength(1);
  });

  it("names both options and explains the choice", () => {
    const html = render(<VoiceTrackModeToggle mode="junto" onChange={() => {}} />);
    expect(html).toContain("With the film");
    expect(html).toContain("Separate");
  });
});

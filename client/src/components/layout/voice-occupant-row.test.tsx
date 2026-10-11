// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { VoiceParticipant } from "@pqp/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";
import {
  resetSoundboardMarksForTests,
  setSoundboardUserMuted,
  showSoundboardMark,
} from "@/lib/soundboard";
import { VoiceOccupantRow } from "./voice-occupant-row";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

const ANA = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

let root: Root | null = null;
let host: HTMLElement | null = null;

const ana = {
  userId: ANA,
  displayName: "Ana",
  avatarUrl: null,
  muted: false,
  deafened: false,
} as unknown as VoiceParticipant;

function mount() {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  act(() => {
    root!.render(
      <TooltipProvider>
        <ul>
          <VoiceOccupantRow
            person={ana}
            channelId="c1"
            isSpeaking={false}
            canDrag={false}
            items={[]}
            audio={{ voice: { volume: 1, onSetVolume: vi.fn() } }}
            onDragStart={() => {}}
            onDragEnd={() => {}}
          />
        </ul>
      </TooltipProvider>,
    );
  });
}

beforeEach(() => localStorage.clear());

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  resetSoundboardMarksForTests();
  setSoundboardUserMuted(ANA, false);
});

const row = () => host!.querySelector<HTMLElement>(`[data-voice-occupant="${ANA}"]`)!;
const menu = () => document.querySelector<HTMLElement>('[data-testid="peer-audio-menu"]');

describe("VoiceOccupantRow soundboard", () => {
  it("shows a quiet muted glyph, named, only while their soundboard is muted", () => {
    mount();
    expect(row().querySelector("[data-soundboard-muted-mark]")).toBeNull();
    act(() => setSoundboardUserMuted(ANA, true));
    const mark = row().querySelector("[data-soundboard-muted-mark]")!;
    expect(mark.getAttribute("role")).toBe("img");
    expect(row().getAttribute("aria-label")).toContain("soundboard sounds are muted");
  });

  it("returns the focus to the row when Escape closes its menu", () => {
    mount();
    act(() => row().click());
    expect(menu()).not.toBeNull();
    expect(menu()!.contains(document.activeElement)).toBe(true);
    act(() => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    expect(menu()).toBeNull();
    expect(document.activeElement).toBe(row());
  });

  it("carries no dead tooltip on the playing mark", () => {
    mount();
    act(() => {
      showSoundboardMark({
        userId: ANA,
        displayName: "Ana",
        emoji: "x",
        soundId: "builtin:buzina",
      });
    });
    const mark = row().querySelector("[data-soundboard-mark]")!;
    expect(mark.hasAttribute("title")).toBe(false);
    expect(row().getAttribute("aria-label")).toContain("Airhorn");
  });
});

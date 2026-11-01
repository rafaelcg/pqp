import { beforeEach, describe, expect, it } from "vitest";
import {
  ATTACHED_FEATURE_HINT_ORDER,
  FEATURE_HINT_IDS,
  FEATURE_HINT_STORAGE_KEYS,
  isFeatureHintSeen,
  rememberFeatureHint,
  shouldOfferVoiceNoteTranscriptionNotice,
  shouldOfferWatchPartyHostHint,
  shouldOfferWatchPartyViewerHint,
  resetFeatureHintsForTests,
  spendFeatureHintForLoad,
  winningFeatureHint,
} from "./feature-hints";

function memory(seed: Record<string, string> = {}) {
  const map = new Map(Object.entries(seed));
  return {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => {
      map.set(k, v);
    },
  };
}

describe("the coach marks that are left", () => {
  it("are the two watch party hints and the voice note notice", () => {
    expect([...FEATURE_HINT_IDS]).toEqual([
      "watchPartyHost",
      "watchPartyViewer",
      "voiceNoteTranscription",
    ]);
    // The notice is drawn by the composer, so it is not in the queue.
    expect([...ATTACHED_FEATURE_HINT_ORDER]).toEqual([
      "watchPartyHost",
      "watchPartyViewer",
    ]);
  });
});

describe("winningFeatureHint", () => {
  beforeEach(() => resetFeatureHintsForTests());

  it("returns null when nobody wants a bubble", () => {
    expect(winningFeatureHint({})).toBeNull();
    expect(
      winningFeatureHint({ watchPartyHost: false, watchPartyViewer: false }),
    ).toBeNull();
  });

  it("lets the host's hint beat the viewer's", () => {
    expect(
      winningFeatureHint({ watchPartyHost: true, watchPartyViewer: true }),
    ).toBe("watchPartyHost");
    expect(winningFeatureHint({ watchPartyViewer: true })).toBe(
      "watchPartyViewer",
    );
  });
});

describe("a hint that has had its turn stops holding the slot", () => {
  /*
   * The queue hands the slot to the first id that wants it, and `wanting`
   * is computed from standing conditions. None of them changes when somebody
   * presses Entendi, so the card that has already been seen would go on
   * winning for the rest of the page load and every tip behind it would wait
   * for good. On a developer's machine, where `lib/hints.ts` deliberately
   * remembers nothing so every card can be seen again, that is forever.
   */
  beforeEach(() => resetFeatureHintsForTests());

  it("passes the slot on once the winner is spent", () => {
    expect(
      winningFeatureHint({ watchPartyHost: true, watchPartyViewer: true }),
    ).toBe("watchPartyHost");
    spendFeatureHintForLoad("watchPartyHost");
    expect(
      winningFeatureHint({ watchPartyHost: true, watchPartyViewer: true }),
    ).toBe("watchPartyViewer");
  });

  it("says nothing is wanted once every wanter has had its turn", () => {
    spendFeatureHintForLoad("watchPartyViewer");
    expect(winningFeatureHint({ watchPartyViewer: true })).toBeNull();
  });
});

describe("remember / seen", () => {
  it("records each id under its own key", () => {
    const storage = memory();
    expect(isFeatureHintSeen("watchPartyViewer", storage, true)).toBe(false);
    rememberFeatureHint("watchPartyViewer", storage, true);
    expect(storage.getItem(FEATURE_HINT_STORAGE_KEYS.watchPartyViewer)).toBe(
      "1",
    );
    expect(isFeatureHintSeen("watchPartyViewer", storage, true)).toBe(true);
    expect(isFeatureHintSeen("watchPartyHost", storage, true)).toBe(false);
  });

  it("writes nothing when persist is off", () => {
    const storage = memory();
    rememberFeatureHint("watchPartyHost", storage, false);
    expect(storage.getItem(FEATURE_HINT_STORAGE_KEYS.watchPartyHost)).toBeNull();
    expect(isFeatureHintSeen("watchPartyHost", storage, false)).toBe(false);
  });
});

describe("the watch party hints", () => {
  it("the host's shows once, on the setup surface", () => {
    const base = { seen: false, automated: false, settingUp: true };
    expect(shouldOfferWatchPartyHostHint(base)).toBe(true);
    expect(shouldOfferWatchPartyHostHint({ ...base, seen: true })).toBe(false);
    expect(shouldOfferWatchPartyHostHint({ ...base, automated: true })).toBe(
      false,
    );
    expect(shouldOfferWatchPartyHostHint({ ...base, settingUp: false })).toBe(
      false,
    );
  });

  it("the viewer's shows once, to somebody watching without a seat", () => {
    const base = { seen: false, automated: false, watching: true };
    expect(shouldOfferWatchPartyViewerHint(base)).toBe(true);
    expect(shouldOfferWatchPartyViewerHint({ ...base, seen: true })).toBe(false);
    expect(shouldOfferWatchPartyViewerHint({ ...base, automated: true })).toBe(
      false,
    );
    expect(shouldOfferWatchPartyViewerHint({ ...base, watching: false })).toBe(
      false,
    );
  });
});

describe("shouldOfferVoiceNoteTranscriptionNotice", () => {
  it("needs a recording, transcripts where it is going, and consent still on", () => {
    const on = { recording: true, transcriptionOn: true, mine: true };
    expect(shouldOfferVoiceNoteTranscriptionNotice(on)).toBe(true);
    expect(shouldOfferVoiceNoteTranscriptionNotice({ ...on, recording: false })).toBe(false);
    expect(shouldOfferVoiceNoteTranscriptionNotice({ ...on, transcriptionOn: false })).toBe(false);
    expect(shouldOfferVoiceNoteTranscriptionNotice({ ...on, mine: false })).toBe(false);
  });

  it("is remembered under its own key", () => {
    const storage = memory();
    expect(isFeatureHintSeen("voiceNoteTranscription", storage, true)).toBe(false);
    rememberFeatureHint("voiceNoteTranscription", storage, true);
    expect(isFeatureHintSeen("voiceNoteTranscription", storage, true)).toBe(true);
    expect(isFeatureHintSeen("watchPartyViewer", storage, true)).toBe(false);
  });
});

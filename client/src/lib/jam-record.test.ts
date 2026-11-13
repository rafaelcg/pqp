import { describe, expect, it } from "vitest";
import { cannotRecordReason, pickInstrument } from "./jam-record";
import { song } from "./jam-test-fixtures";

describe("the instrument the studio pre-selects", () => {
  it("takes the one the song is looking for", () => {
    const s = song({ joinMode: "wanted", wantedInstruments: ["vocals", "bass"], instruments: ["guitar"] });
    expect(pickInstrument(s, ["vocals", "bass"])).toBe("vocals");
  });

  it("takes the first wanted one the viewer may add when the first is not theirs", () => {
    const s = song({ joinMode: "wanted", wantedInstruments: ["vocals", "bass"], instruments: ["guitar"] });
    expect(pickInstrument(s, ["bass"])).toBe("bass");
  });

  it("takes something the song does not have yet on an open song", () => {
    const s = song({ joinMode: "open", instruments: ["guitar", "vocals"] });
    expect(pickInstrument(s, ["guitar", "bass", "drums", "vocals", "keys", "other"])).toBe("bass");
  });

  it("avoids an instrument the viewer already recorded when something else is open", () => {
    const s = song({ joinMode: "open", instruments: ["guitar", "bass", "drums", "vocals", "keys", "other"] });
    expect(pickInstrument(s, ["guitar", "bass"], [{ instrument: "bass" }])).toBe("guitar");
  });

  it("still answers when every instrument is taken by the viewer", () => {
    const s = song({ joinMode: "open", instruments: ["guitar"] });
    expect(pickInstrument(s, ["guitar"], [{ instrument: "guitar" }])).toBe("guitar");
  });

  it("answers nothing when the viewer may add nothing", () => {
    expect(pickInstrument(song(), [])).toBeNull();
  });
});

describe("why there is no record button", () => {
  const base = { enabled: true, uploads: true, addable: ["guitar" as const], joinMode: "open" as const };
  it("is none when the viewer may record", () => {
    expect(cannotRecordReason(base)).toBeNull();
  });
  it("says paused when the flag is off, before anything else", () => {
    expect(cannotRecordReason({ ...base, enabled: false, addable: [] })).toBe("off");
  });
  it("says there is no storage when uploads are off", () => {
    expect(cannotRecordReason({ ...base, uploads: false })).toBe("uploadsOff");
  });
  it("says closed for a closed song, other for anything else", () => {
    expect(cannotRecordReason({ ...base, addable: [], joinMode: "closed" })).toBe("closed");
    expect(cannotRecordReason({ ...base, addable: [], joinMode: "wanted" })).toBe("other");
  });
});

import { afterEach, describe, expect, it } from "vitest";
import {
  earlyShareQuality,
  recordShareFastStartQuality,
  resetShareFastStartForTests,
  setShareFastStartQuality,
  setShareFastStartServer,
  shareFastStartQualityActive,
} from "./share-fast-start";

const LOW = 0;
const MEDIUM = 1;
const HIGH = 2;

describe("earlyShareQuality: the layer a 720-line stage would ask for", () => {
  it("starts a small room's three layers on the 720p copy, not the top", () => {
    const layers = [
      { quality: LOW, height: 360 },
      { quality: MEDIUM, height: 720 },
      { quality: HIGH, height: 1080 },
    ];
    expect(earlyShareQuality(layers, HIGH)).toBe(MEDIUM);
  });

  it("starts a large room's two layers on the top, which is the 720p copy", () => {
    expect(
      earlyShareQuality(
        [
          { quality: LOW, height: 360 },
          { quality: MEDIUM, height: 720 },
        ],
        HIGH,
      ),
    ).toBe(MEDIUM);
  });

  it("takes the next layer up when nothing is close to 720 lines, never the 360p one", () => {
    // A presenter whose capture never came down: [360, 1080].
    expect(
      earlyShareQuality(
        [
          { quality: LOW, height: 360 },
          { quality: MEDIUM, height: 1080 },
        ],
        HIGH,
      ),
    ).toBe(MEDIUM);
  });

  it("counts a 1078-line window as a 1080p one and a 648-line copy as 720p, like the SFU", () => {
    expect(
      earlyShareQuality(
        [
          { quality: LOW, height: 324 },
          { quality: MEDIUM, height: 648 },
          { quality: HIGH, height: 1078 },
        ],
        HIGH,
      ),
    ).toBe(MEDIUM);
  });

  it("never asks above the viewer's own ceiling", () => {
    const layers = [
      { quality: LOW, height: 360 },
      { quality: MEDIUM, height: 720 },
      { quality: HIGH, height: 1080 },
    ];
    expect(earlyShareQuality(layers, LOW)).toBe(LOW);
  });

  it("asks for the tallest a small share has, and the ceiling when none are declared", () => {
    expect(earlyShareQuality([{ quality: LOW, height: 480 }], HIGH)).toBe(LOW);
    expect(earlyShareQuality(undefined, HIGH)).toBe(HIGH);
    expect(earlyShareQuality([], MEDIUM)).toBe(MEDIUM);
  });
});

describe("the per-server answer", () => {
  afterEach(() => resetShareFastStartForTests());

  it("is off until the call's server has answered yes", () => {
    expect(shareFastStartQualityActive()).toBe(false);
    setShareFastStartServer("s1");
    expect(shareFastStartQualityActive()).toBe(false);
    recordShareFastStartQuality("s1", true);
    expect(shareFastStartQualityActive()).toBe(true);
  });

  it("follows the server the call is in, not the last answer to arrive", () => {
    recordShareFastStartQuality("s1", true);
    recordShareFastStartQuality("s2", false);
    setShareFastStartServer("s2");
    expect(shareFastStartQualityActive()).toBe(false);
    setShareFastStartServer("s1");
    expect(shareFastStartQualityActive()).toBe(true);
  });

  it("reads a call without a server from the deployment-wide answer", () => {
    recordShareFastStartQuality(null, true);
    setShareFastStartServer(null);
    expect(shareFastStartQualityActive()).toBe(true);
  });

  it("can be forced for the measurement rig", () => {
    setShareFastStartQuality(true);
    expect(shareFastStartQualityActive()).toBe(true);
  });
});

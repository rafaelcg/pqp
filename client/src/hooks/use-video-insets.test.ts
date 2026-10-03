import { describe, expect, it } from "vitest";
import { computeVideoInsets } from "@/hooks/use-video-insets";

describe("computeVideoInsets", () => {
  it("puts a 16:9 share in a taller box between two black bands", () => {
    expect(
      computeVideoInsets({ boxWidth: 1000, boxHeight: 800, videoWidth: 1280, videoHeight: 720, fit: "contain" }),
    ).toEqual({ top: 119, bottom: 119, left: 0, right: 0 });
  });

  it("puts a tall picture in a wide box between two side bands", () => {
    expect(
      computeVideoInsets({ boxWidth: 1000, boxHeight: 500, videoWidth: 720, videoHeight: 1280, fit: "contain" }),
    ).toEqual({ top: 0, bottom: 0, left: 359, right: 359 });
  });

  it("answers zero for a cropped picture, which fills its box", () => {
    expect(
      computeVideoInsets({ boxWidth: 1000, boxHeight: 800, videoWidth: 1280, videoHeight: 720, fit: "cover" }),
    ).toEqual({ top: 0, bottom: 0, left: 0, right: 0 });
  });

  it("answers zero before the first frame says how big the picture is", () => {
    expect(
      computeVideoInsets({ boxWidth: 1000, boxHeight: 800, videoWidth: 0, videoHeight: 0, fit: "contain" }),
    ).toEqual({ top: 0, bottom: 0, left: 0, right: 0 });
  });
});

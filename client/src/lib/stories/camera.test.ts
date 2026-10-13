import { describe, expect, it } from "vitest";
import {
  cameraAvailability,
  classifyCameraError,
  coverCrop,
  nextDeviceId,
  pickRecorderType,
  shouldMirror,
  stillSize,
  videoConstraints,
} from "./camera";

describe("classifyCameraError", () => {
  it("tells a refusal from a missing camera from a busy one", () => {
    expect(classifyCameraError({ name: "NotAllowedError" })).toBe("denied");
    expect(classifyCameraError({ name: "SecurityError" })).toBe("denied");
    expect(classifyCameraError({ name: "NotFoundError" })).toBe("none");
    expect(classifyCameraError({ name: "NotReadableError" })).toBe("busy");
    expect(classifyCameraError({ name: "AbortError" })).toBe("busy");
    expect(classifyCameraError({ name: "TypeError" })).toBe("unsupported");
  });

  it("falls back to failed for anything it does not know", () => {
    expect(classifyCameraError(new Error("boom"))).toBe("failed");
    expect(classifyCameraError(null)).toBe("failed");
    expect(classifyCameraError({ name: "OverconstrainedError" })).toBe("failed");
  });
});

describe("cameraAvailability", () => {
  it("is fine when the API is there", () => {
    expect(cameraAvailability({ hasGetUserMedia: true, isSecureContext: true })).toBeNull();
  });

  it("blames the page, not the browser, on an insecure origin", () => {
    expect(cameraAvailability({ hasGetUserMedia: false, isSecureContext: false })).toBe("insecure");
    expect(cameraAvailability({ hasGetUserMedia: false, isSecureContext: true })).toBe("unsupported");
  });
});

describe("videoConstraints", () => {
  it("asks a phone for portrait and a laptop for landscape, softly", () => {
    const phone = videoConstraints({ facing: "user", deviceId: null, portrait: true });
    expect(phone).toMatchObject({ width: { ideal: 1080 }, height: { ideal: 1920 } });
    const laptop = videoConstraints({ facing: "user", deviceId: null, portrait: false });
    expect(laptop).toMatchObject({ width: { ideal: 1920 }, height: { ideal: 1080 } });
  });

  it("uses the facing mode as an ideal, never exact", () => {
    const back = videoConstraints({ facing: "environment", deviceId: null, portrait: true });
    expect(back.facingMode).toEqual({ ideal: "environment" });
  });

  it("pins a device by id when one is chosen from the list", () => {
    const pinned = videoConstraints({ facing: "user", deviceId: "cam-2", portrait: false });
    expect(pinned.deviceId).toEqual({ exact: "cam-2" });
    expect(pinned.facingMode).toBeUndefined();
  });
});

describe("shouldMirror", () => {
  it("mirrors a front camera and never the back one", () => {
    expect(shouldMirror({ facingMode: "user" })).toBe(true);
    expect(shouldMirror({ facingMode: "environment" })).toBe(false);
  });

  it("mirrors a webcam that reports no facing mode, unless its name says it is a rear one", () => {
    expect(shouldMirror({}, "FaceTime HD Camera")).toBe(true);
    expect(shouldMirror({}, "Back Camera")).toBe(false);
    expect(shouldMirror({}, "Câmera traseira")).toBe(false);
  });
});

describe("nextDeviceId", () => {
  const cameras = [{ deviceId: "a" }, { deviceId: "b" }, { deviceId: "c" }];

  it("walks the list and wraps", () => {
    expect(nextDeviceId(cameras, "a")).toBe("b");
    expect(nextDeviceId(cameras, "c")).toBe("a");
  });

  it("starts at the second when the current one is not on the list", () => {
    expect(nextDeviceId(cameras, null)).toBe("a");
  });

  it("has nothing to flip to with one camera", () => {
    expect(nextDeviceId([{ deviceId: "a" }], "a")).toBeNull();
    expect(nextDeviceId([], null)).toBeNull();
  });
});

describe("pickRecorderType", () => {
  it("prefers H.264 + AAC in MP4, the one container a story takes", () => {
    const supported = new Set(["video/mp4;codecs=avc1.42E01E,mp4a.40.2", "video/mp4"]);
    expect(pickRecorderType((type) => supported.has(type))).toBe("video/mp4;codecs=avc1.42E01E,mp4a.40.2");
  });

  it("falls back to plain mp4", () => {
    expect(pickRecorderType((type) => type === "video/mp4")).toBe("video/mp4");
  });

  it("is null in a browser that only records WebM", () => {
    expect(pickRecorderType((type) => type.startsWith("video/webm"))).toBeNull();
  });
});

describe("coverCrop", () => {
  it("keeps the middle of a landscape frame", () => {
    expect(coverCrop(1920, 1080)).toEqual({ sx: 656, sy: 0, sw: 608, sh: 1080 });
  });

  it("keeps all of a portrait frame that is already 9:16", () => {
    expect(coverCrop(1080, 1920)).toEqual({ sx: 0, sy: 0, sw: 1080, sh: 1920 });
  });

  it("trims height from a frame narrower than 9:16", () => {
    const crop = coverCrop(1000, 2400);
    expect(crop.sw).toBe(1000);
    expect(crop.sh).toBe(1778);
    expect(crop.sy).toBe(311);
  });
});

describe("stillSize", () => {
  it("caps the long side at the story image limit, keeping the aspect", () => {
    expect(stillSize(1080, 1920)).toEqual({ width: 810, height: 1440 });
  });

  it("never upscales", () => {
    expect(stillSize(500, 888)).toEqual({ width: 500, height: 888 });
  });
});

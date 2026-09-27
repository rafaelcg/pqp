import { describe, expect, it } from "vitest";
import {
  OBS_VIRTUAL_CAMERA_HINT_STORAGE_KEY,
  dismissObsVirtualCameraHint,
  isObsVirtualCameraHintDismissed,
  isObsVirtualCameraLabel,
} from "./obs-virtual-camera";

function fakeStorage(initial: Record<string, string> = {}) {
  const map = new Map(Object.entries(initial));
  return {
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => {
      map.set(key, value);
    },
  };
}

function hostileStorage() {
  return {
    getItem: () => {
      throw new Error("denied");
    },
    setItem: () => {
      throw new Error("QuotaExceededError");
    },
  };
}

describe("isObsVirtualCameraLabel", () => {
  it("matches the Windows/Linux label", () => {
    expect(isObsVirtualCameraLabel("OBS Virtual Camera")).toBe(true);
  });

  it("matches lowercase and reordered variants", () => {
    expect(isObsVirtualCameraLabel("obs virtual camera")).toBe(true);
    expect(isObsVirtualCameraLabel("Virtual Camera (OBS)")).toBe(false);
  });

  it("matches the macOS label", () => {
    expect(isObsVirtualCameraLabel("OBS-Camera")).toBe(true);
    expect(isObsVirtualCameraLabel("obs-camera")).toBe(true);
  });

  it("does not match an ordinary webcam", () => {
    expect(isObsVirtualCameraLabel("FaceTime HD Camera")).toBe(false);
    expect(isObsVirtualCameraLabel("Logitech BRIO")).toBe(false);
  });

  it("does not match a bare 'OBS' with no virtual/camera marker", () => {
    expect(isObsVirtualCameraLabel("OBS")).toBe(false);
  });

  it("handles empty or missing labels", () => {
    expect(isObsVirtualCameraLabel("")).toBe(false);
  });
});

describe("isObsVirtualCameraHintDismissed", () => {
  it("is false with nothing stored", () => {
    expect(isObsVirtualCameraHintDismissed(fakeStorage())).toBe(false);
  });

  it("is false with no storage at all", () => {
    expect(isObsVirtualCameraHintDismissed(null)).toBe(false);
  });

  it("is true once the dismiss is recorded", () => {
    expect(
      isObsVirtualCameraHintDismissed(
        fakeStorage({ [OBS_VIRTUAL_CAMERA_HINT_STORAGE_KEY]: "1" }),
      ),
    ).toBe(true);
  });

  it("ignores any other stored value", () => {
    expect(
      isObsVirtualCameraHintDismissed(
        fakeStorage({ [OBS_VIRTUAL_CAMERA_HINT_STORAGE_KEY]: "true" }),
      ),
    ).toBe(false);
  });

  it("does not throw when the store refuses the read", () => {
    expect(isObsVirtualCameraHintDismissed(hostileStorage())).toBe(false);
  });
});

describe("dismissObsVirtualCameraHint", () => {
  it("records the dismiss so the next read hides the tip", () => {
    const storage = fakeStorage();
    dismissObsVirtualCameraHint(storage);
    expect(isObsVirtualCameraHintDismissed(storage)).toBe(true);
  });

  it("does not throw when the store refuses the write", () => {
    expect(() => dismissObsVirtualCameraHint(hostileStorage())).not.toThrow();
    expect(() => dismissObsVirtualCameraHint(null)).not.toThrow();
  });
});

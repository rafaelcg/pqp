import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import en from "@/locales/en/translation.json";
import type { CameraControls, RecorderControls } from "@/lib/stories/use-camera";
import { audienceSummary } from "./composer-audience";
import { CameraControlsRow, CameraStage } from "./composer-camera";

function camera(patch: Partial<CameraControls> = {}): CameraControls {
  return {
    status: "live",
    stream: null,
    mirrored: true,
    canFlip: false,
    flip: () => {},
    torchAvailable: false,
    torchOn: false,
    toggleTorch: () => {},
    size: null,
    retry: () => {},
    ...patch,
  };
}

function recorder(patch: Partial<RecorderControls> = {}): RecorderControls {
  return {
    supported: true,
    recording: false,
    elapsedMs: 0,
    start: async () => true,
    stop: () => {},
    micMissing: false,
    ...patch,
  };
}

const noop = () => {};

describe("CameraStage", () => {
  it("says why there is no camera and still offers the file picker", () => {
    for (const status of ["denied", "none", "busy", "unsupported", "insecure", "failed"] as const) {
      const html = renderToStaticMarkup(
        <CameraStage camera={camera({ status })} recorder={recorder()} onChooseFile={noop} />,
      );
      expect(html).toContain(`data-story-camera-problem="${status}"`);
      expect(html).toContain(en["stories.compose.gallery"]);
    }
  });

  it("offers no retry where retrying cannot help (insecure page, no API)", () => {
    const html = renderToStaticMarkup(
      <CameraStage camera={camera({ status: "insecure" })} recorder={recorder()} onChooseFile={noop} />,
    );
    expect(html).not.toContain(en["stories.camera.retry"]);
    const denied = renderToStaticMarkup(
      <CameraStage camera={camera({ status: "denied" })} recorder={recorder()} onChooseFile={noop} />,
    );
    expect(denied).toContain(en["stories.camera.retry"]);
  });

  it("mirrors the front camera preview and not the back one", () => {
    const front = renderToStaticMarkup(
      <CameraStage camera={camera({ mirrored: true })} recorder={recorder()} onChooseFile={noop} />,
    );
    expect(front).toContain("scaleX(-1)");
    const back = renderToStaticMarkup(
      <CameraStage camera={camera({ mirrored: false })} recorder={recorder()} onChooseFile={noop} />,
    );
    expect(back).not.toContain("scaleX(-1)");
  });

  it("shows the running clock while recording", () => {
    const html = renderToStaticMarkup(
      <CameraStage
        camera={camera()}
        recorder={recorder({ recording: true, elapsedMs: 7400 })}
        onChooseFile={noop}
      />,
    );
    expect(html).toContain("0:07");
    expect(html).toContain("0:30");
  });
});

describe("CameraControlsRow", () => {
  const props = {
    shutterDisabled: false,
    onChooseFile: noop,
    onPhoto: noop,
    onRecordStart: noop,
    onRecordStop: noop,
  };

  it("hides the flip button on a one-camera device and shows it where there are two", () => {
    const one = renderToStaticMarkup(
      <CameraControlsRow camera={camera({ canFlip: false })} recorder={recorder()} {...props} />,
    );
    expect(one).not.toContain("data-story-flip");
    const two = renderToStaticMarkup(
      <CameraControlsRow camera={camera({ canFlip: true })} recorder={recorder()} {...props} />,
    );
    expect(two).toContain("data-story-flip");
  });

  it("offers the torch only where the camera has one", () => {
    const without = renderToStaticMarkup(
      <CameraControlsRow camera={camera()} recorder={recorder()} {...props} />,
    );
    expect(without).not.toContain(en["stories.camera.torch"]);
    const withTorch = renderToStaticMarkup(
      <CameraControlsRow camera={camera({ torchAvailable: true })} recorder={recorder()} {...props} />,
    );
    expect(withTorch).toContain(en["stories.camera.torch"]);
  });

  it("without video recording it is photo only and says how to post a video", () => {
    const html = renderToStaticMarkup(
      <CameraControlsRow camera={camera()} recorder={recorder({ supported: false })} {...props} />,
    );
    expect(html).not.toContain("data-story-record");
    expect(html).toContain(en["stories.camera.hintPhotoOnly"]);
  });

  it("locks the shutter until the camera is live", () => {
    const html = renderToStaticMarkup(
      <CameraControlsRow camera={camera({ status: "starting" })} recorder={recorder()} {...props} />,
    );
    expect(html).toMatch(/data-story-shutter=""[^>]*disabled/);
  });
});

describe("audienceSummary", () => {
  const options = {
    servers: [
      { serverId: "a", serverName: "QG do pqp", iconUrl: null, memberCount: 3, canPost: true, blockedReason: null },
      { serverId: "b", serverName: "Outro", iconUrl: null, memberCount: 3, canPost: true, blockedReason: null },
    ],
    friends: { enabled: true, canPost: true },
  };
  const t = (key: string, vars?: Record<string, string | number>) =>
    key === "stories.compose.audienceMany" ? `${vars?.count} places` : (en as Record<string, string>)[key] ?? key;

  it("is empty until somebody is picked", () => {
    expect(audienceSummary({ options, serverIds: [], friends: false }, t)).toEqual({
      text: en["stories.compose.audienceNone"],
      empty: true,
    });
  });

  it("names a single place and counts several", () => {
    expect(audienceSummary({ options, serverIds: ["a"], friends: false }, t).text).toBe("QG do pqp");
    expect(audienceSummary({ options, serverIds: [], friends: true }, t).text).toBe(en["stories.audience.friends"]);
    expect(audienceSummary({ options, serverIds: ["a", "b"], friends: true }, t).text).toBe("3 places");
  });
});

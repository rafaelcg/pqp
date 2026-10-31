// @vitest-environment jsdom
import type { PublicUser } from "@pqp/shared";
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const uploadHomeMedia = vi.fn();

vi.mock("@/lib/community-home", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/community-home")>()),
  uploadHomeMedia: (...args: unknown[]) => uploadHomeMedia(...args),
}));

const { ComposeCard, emptyCompose } = await import("./community-home-feed");

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

beforeAll(() => {
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
});

const me: PublicUser = {
  id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1",
  displayName: "Rafa",
  username: "rafa",
  tag: "rafa#0001",
  avatarUrl: null,
  customStatus: null,
};

function Harness() {
  const [state, setState] = useState(emptyCompose);
  return (
    <ComposeCard
      state={state}
      setState={setState}
      serverId="00000000-0000-4000-8000-000000000001"
      me={me}
      isOwner
      vipEnabled={false}
      mediaEnabled
      translationEnabled={false}
      mobileRenditionEnabled
      customCoverEnabled
      channels={[]}
      announceChannel={null}
      onDone={() => {}}
      onCancelEdit={() => {}}
    />
  );
}

let root: Root | null = null;
let host: HTMLElement | null = null;

async function pick(selector: string, file: File) {
  const input = host!.querySelector<HTMLInputElement>(selector)!;
  Object.defineProperty(input, "files", { value: [file], configurable: true });
  await act(async () => {
    input.dispatchEvent(new Event("change", { bubbles: true }));
  });
  // Let the mocked upload settle and its state updates land.
  await act(async () => {});
}

describe("ComposeCard: a video with both a phone cut and a cover", () => {
  let errors: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    uploadHomeMedia.mockReset();
    URL.createObjectURL = vi.fn(() => "blob:video");
    URL.revokeObjectURL = vi.fn();
    errors = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(async () => {
    errors.mockRestore();
    await act(async () => root?.unmount());
    host?.remove();
    root = null;
    host = null;
  });

  it("shows one phone-cut picker, then only the cut's own row, with no duplicate keys", async () => {
    uploadHomeMedia
      .mockResolvedValueOnce({
        uploadId: "main-1",
        kind: "video",
        name: "pqp-forum-16x9.mp4",
        contentType: "video/mp4",
        byteSize: 9_000_000,
      })
      .mockResolvedValueOnce({
        uploadId: "mobile-1",
        kind: "video",
        name: "pqp-forum-9x16.mp4",
        contentType: "video/mp4",
        byteSize: 6_600_000,
      });
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    await act(async () => {
      root!.render(<Harness />);
    });

    await pick(
      "[data-home-compose-file]",
      new File(["x"], "pqp-forum-16x9.mp4", { type: "video/mp4" }),
    );
    expect(host.querySelectorAll("[data-home-compose-mobile]")).toHaveLength(1);
    expect(host.querySelector("[data-home-compose-mobile-file]")).not.toBeNull();

    await pick(
      "[data-home-compose-mobile-file]",
      new File(["x"], "pqp-forum-9x16.mp4", { type: "video/mp4" }),
    );
    const blocks = host.querySelectorAll("[data-home-compose-mobile]");
    expect(blocks).toHaveLength(1);
    expect(host.querySelector("[data-home-compose-mobile-file]")).toBeNull();
    expect(host.querySelectorAll("[data-home-compose-mobile-label]")).toHaveLength(1);

    const duplicateKeys = errors.mock.calls.filter((call: unknown[]) =>
      String(call[0]).includes("two children with the same key"),
    );
    expect(duplicateKeys).toHaveLength(0);
  });
});

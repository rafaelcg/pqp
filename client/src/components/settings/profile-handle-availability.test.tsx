// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fetchPublicProfile = vi.hoisted(() => vi.fn());
vi.mock("@/lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/api")>()),
  fetchPublicProfile,
}));

const { useHandleAvailability } = await import("./profile-section");

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

let root: Root | null = null;
let host: HTMLElement | null = null;
const seen: string[] = [];

function Probe({ handle }: { handle: string }) {
  seen.push(useHandleAvailability(handle, null, true));
  return null;
}

beforeEach(() => {
  vi.useFakeTimers();
  seen.length = 0;
  fetchPublicProfile.mockReset();
  fetchPublicProfile.mockReturnValue(new Promise(() => undefined));
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  vi.useRealTimers();
});

describe("useHandleAvailability while typing", () => {
  it("stays on checking from one keystroke to the next instead of dropping to idle", () => {
    act(() => root!.render(<Probe handle="rafa" />));
    expect(seen.at(-1)).toBe("checking");
    const from = seen.length;
    for (const next of ["rafae", "rafael", "rafaelx"]) {
      act(() => root!.render(<Probe handle={next} />));
    }
    expect(seen.slice(from)).not.toContain("idle");
  });
});

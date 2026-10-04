// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

const signOut = vi.hoisted(() => vi.fn());
vi.mock("@clerk/clerk-react", () => ({ useClerk: () => ({ signOut }) }));
vi.mock("@/lib/dev-auth", () => ({ isDevAuthBypassEnabled: () => false }));

const { SignOutButton } = await import("./sign-out-button");
const { SettingsShellContext } = await import("@/components/settings/kit");

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

let root: Root | null = null;
let host: HTMLElement | null = null;

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  signOut.mockReset();
});

function mount(holdForDrafts: () => boolean) {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  act(() =>
    root!.render(
      <SettingsShellContext.Provider
        value={{
          profileDirty: false,
          openSection: () => undefined,
          headerActionsSlot: null,
          holdForDrafts,
        }}
      >
        <SignOutButton />
      </SettingsShellContext.Provider>,
    ),
  );
  return host.querySelector("button")!;
}

describe("SignOutButton inside Settings", () => {
  it("keeps the session while staged profile edits hold it", () => {
    const hold = vi.fn(() => true);
    const button = mount(hold);
    act(() => button.click());
    expect(hold).toHaveBeenCalledTimes(1);
    expect(signOut).not.toHaveBeenCalled();
  });

  it("signs out when nothing is staged", () => {
    const button = mount(() => false);
    act(() => button.click());
    expect(signOut).toHaveBeenCalledTimes(1);
  });
});

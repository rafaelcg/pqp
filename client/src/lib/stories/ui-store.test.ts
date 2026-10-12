import { afterEach, describe, expect, it, vi } from "vitest";
import {
  clearStoriesNotice,
  closeStoryViewer,
  getStoriesUi,
  resetStoriesUi,
  showStoriesNotice,
} from "./ui-store";

afterEach(() => resetStoriesUi());

describe("stories notice", () => {
  it("outlives the viewer, so Desfazer after a mute is still reachable", () => {
    const run = vi.fn();
    showStoriesNotice("Stories de Ana silenciados", { label: "Desfazer", run });
    closeStoryViewer();
    const notice = getStoriesUi().notice;
    expect(notice?.text).toBe("Stories de Ana silenciados");
    notice?.action?.run();
    expect(run).toHaveBeenCalledOnce();
  });

  it("an old timer never clears a newer notice", () => {
    showStoriesNotice("first");
    const first = getStoriesUi().notice!.key;
    vi.spyOn(Date, "now").mockReturnValue(first + 1);
    showStoriesNotice("second");
    clearStoriesNotice(first);
    expect(getStoriesUi().notice?.text).toBe("second");
    clearStoriesNotice();
    expect(getStoriesUi().notice).toBeNull();
    vi.restoreAllMocks();
  });
});

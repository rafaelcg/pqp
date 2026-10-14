import { fetchStories } from "./api";
import { assetsOfStory, rememberStories, rememberedStory, storyPreloader } from "./preload";

/**
 * While a strip is on screen, warm the first unseen story of its first three
 * rings, so opening one shows it with no wait (spec: tray preload).
 *
 * The stories are read in ONE request (`fetchStories` takes a list) and
 * remembered, so the viewer that opens a ring a moment later uses these very
 * objects: their presigned picture and clip URLs are the ones that were warmed.
 * Returns what to call when the strip goes away or its rings change, which
 * cancels whatever this had not finished downloading.
 */
export const TRAY_WARM_RINGS = 3;

export function warmTray(source: string, storyIds: readonly string[]): () => void {
  let cancelled = false;
  if (storyIds.length === 0) {
    storyPreloader.clearSource(source);
    return () => undefined;
  }
  const apply = () => {
    if (cancelled) {
      return;
    }
    const assets = storyIds.flatMap((id) => {
      const story = rememberedStory(id);
      return story ? assetsOfStory(story, { video: true }) : [];
    });
    storyPreloader.setSource(source, 10, assets);
  };
  const needed = storyIds.filter((id) => !rememberedStory(id));
  if (needed.length > 0) {
    fetchStories(needed)
      .then((found) => {
        rememberStories(found);
        apply();
      })
      .catch(() => undefined);
  }
  apply();
  return () => {
    cancelled = true;
    storyPreloader.clearSource(source);
  };
}

/** The story to warm for each of the first rings: the first the viewer has not seen, else the first. */
export function trayWarmIds(
  items: readonly { storyIds: readonly string[] }[],
  seen: ReadonlySet<string>,
): string[] {
  return items.slice(0, TRAY_WARM_RINGS).flatMap((item) => {
    const id = item.storyIds.find((candidate) => !seen.has(candidate)) ?? item.storyIds[0];
    return id ? [id] : [];
  });
}

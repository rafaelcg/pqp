import { useCallback, useEffect, useRef, useState } from "react";
import type { ForumSettings, ForumTag } from "@pqp/shared";
import {
  fetchForumSettings,
  fetchForumTags,
  type ForumTagsStatus,
} from "@/lib/forum-api";
import { subscribeForumFrames, subscribeForumReconnected } from "@/lib/forum-frames";

/** A failed tags read is tried this many times, the wait doubling from this. */
export const TAGS_READ_ATTEMPTS = 3;
export const TAGS_RETRY_MS = 800;

/**
 * A forum's tags and its two switches, as the pane holds them: what the
 * composer offers and the Edit tags dialog toggles.
 *
 * One read when the forum opens, then kept current three ways: the live
 * `forum-config-update` frame, a read again whenever the composer or the tag
 * editor opens (`refresh`), and a read again when the socket comes back,
 * because a frame sent while it was down is never replayed. A tab whose read
 * failed or went stale used to keep an empty list for good, and "require a
 * tag" over an empty list is a composer with nothing to pick and no way to
 * post.
 *
 * `status` is what keeps "no tags" honest: `error` is a read that failed
 * every try, `loading` one still going, and only `ready` may be read as the
 * forum having none.
 */
export function useForumRules(forumId: string) {
  const [tags, setTags] = useState<ForumTag[]>([]);
  const [status, setStatus] = useState<ForumTagsStatus>("loading");
  const [settings, setSettings] = useState<ForumSettings | null>(null);
  // Bumped by every newer read, every live frame and every forum change: a
  // read that finds it moved on is older than what the screen holds, and
  // applying it would put the list back.
  const epoch = useRef(0);

  /**
   * Read the tags again, retrying a failed read. `quiet` is a refresh over a
   * list already on screen: it never flips the status back to loading, and a
   * refresh that fails leaves the last good list in place.
   */
  const loadTags = useCallback(
    (quiet = false) => {
      epoch.current += 1;
      const mine = epoch.current;
      if (!quiet) {
        setStatus((current) => (current === "ready" ? current : "loading"));
      }
      let attempt = 0;
      const run = () => {
        fetchForumTags(forumId)
          .then(({ tags: next }) => {
            if (epoch.current === mine) {
              setTags(next);
              setStatus("ready");
            }
          })
          .catch(() => {
            if (epoch.current !== mine) {
              return;
            }
            attempt += 1;
            if (attempt < TAGS_READ_ATTEMPTS) {
              window.setTimeout(run, TAGS_RETRY_MS * 2 ** (attempt - 1));
            } else {
              setStatus((current) => (current === "ready" ? current : "error"));
            }
          });
      };
      run();
    },
    [forumId],
  );

  const loadSettings = useCallback(() => {
    fetchForumSettings(forumId)
      .then(({ settings: next }) => setSettings(next))
      .catch(() => {});
  }, [forumId]);

  useEffect(() => {
    setTags([]);
    setStatus("loading");
    setSettings(null);
    loadTags();
    loadSettings();
    return () => {
      epoch.current += 1;
    };
  }, [forumId, loadTags, loadSettings]);

  const refresh = useCallback(() => {
    loadTags(true);
    loadSettings();
  }, [loadTags, loadSettings]);
  const retryTags = useCallback(() => loadTags(), [loadTags]);

  /** A list this tab just saved itself (the starter tags). */
  const applyTags = useCallback((next: ForumTag[]) => {
    epoch.current += 1;
    setTags(next);
    setStatus("ready");
  }, []);

  useEffect(
    () =>
      subscribeForumFrames((frame) => {
        if (frame.forumId !== forumId || frame.type !== "forum-config-update") {
          return;
        }
        if (frame.tags) {
          applyTags(frame.tags);
        }
        if (frame.settings) {
          setSettings(frame.settings);
        }
      }),
    [forumId, applyTags],
  );

  useEffect(() => subscribeForumReconnected(refresh), [refresh]);

  return { tags, status, settings, setSettings, refresh, retryTags, applyTags };
}

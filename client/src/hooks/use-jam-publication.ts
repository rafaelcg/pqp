import type { JamPublication } from "@pqp/shared";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  fetchJamPublication,
  jamPublicErrorKind,
  publishJamSong,
  setJamShowOrigin,
  unpublishJamSong,
  type JamPublicErrorKind,
} from "@/lib/jam-public-api";
import { loadJamPublicWaiting } from "@/lib/jam-public-store";

/**
 * Where one song stands as a public jam, for the people who may see that: its
 * starter, a channel member, a person with a part in it
 * (`GET /api/jam-songs/:id/public`, `null` when it was never published).
 *
 * `active` false asks nothing: the panel only wants it once it knows the flag
 * is on and the viewer is somebody the answer is for. Every write answers with
 * the new state, which replaces what is held.
 */
export interface JamPublicationState {
  /** The first read is out. */
  loading: boolean;
  /** The song was never published, or the read said it could not be shown. */
  publication: JamPublication | null;
  busy: boolean;
  error: JamPublicErrorKind | null;
  refresh: () => Promise<void>;
  publish: (showOrigin?: boolean) => Promise<boolean>;
  setShowOrigin: (showOrigin: boolean) => Promise<boolean>;
  unpublish: () => Promise<boolean>;
}

export function useJamPublication(songId: string, active: boolean): JamPublicationState {
  const [publication, setPublication] = useState<JamPublication | null>(null);
  const [loading, setLoading] = useState(active);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<JamPublicErrorKind | null>(null);
  const live = useRef(true);
  const forSong = useRef(songId);
  forSong.current = songId;
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
    };
  }, []);

  const refresh = useCallback(async () => {
    if (!active) {
      return;
    }
    const asked = songId;
    try {
      const answer = await fetchJamPublication(songId);
      if (live.current && forSong.current === asked) {
        setPublication(answer.publication);
        setError(null);
      }
    } catch (failure) {
      // Not somebody the answer is for (404), or no answer: nothing to show.
      if (live.current && forSong.current === asked && jamPublicErrorKind(failure) === "gone") {
        setPublication(null);
      }
    } finally {
      if (live.current && forSong.current === asked) {
        setLoading(false);
      }
    }
  }, [songId, active]);

  useEffect(() => {
    setPublication(null);
    setError(null);
    setLoading(active);
    void refresh();
  }, [refresh, active]);

  const write = useCallback(
    async (run: () => Promise<{ publication: JamPublication | null }>): Promise<boolean> => {
      setBusy(true);
      setError(null);
      const asked = songId;
      try {
        const answer = await run();
        if (live.current && forSong.current === asked) {
          setPublication(answer.publication);
        }
        // A publish changes who is asked for what, an unpublish what is waiting.
        void loadJamPublicWaiting();
        return true;
      } catch (failure) {
        if (live.current && forSong.current === asked) {
          setError(jamPublicErrorKind(failure));
        }
        return false;
      } finally {
        if (live.current) {
          setBusy(false);
        }
      }
    },
    [songId],
  );

  return {
    loading,
    publication,
    busy,
    error,
    refresh,
    publish: (showOrigin) => write(() => publishJamSong(songId, showOrigin)),
    setShowOrigin: (showOrigin) => write(() => setJamShowOrigin(songId, showOrigin)),
    unpublish: () => write(() => unpublishJamSong(songId)),
  };
}

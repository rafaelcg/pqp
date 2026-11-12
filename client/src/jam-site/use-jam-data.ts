import type { PublicJamSong, PublicJamSongDetail } from "@pqp/shared";
import { useCallback, useEffect, useRef, useState } from "react";
import { fetchJam, fetchJamConfig, fetchJamList, JamApiError } from "./api";
import type { Instrument } from "./instruments";

/**
 * Reads of the public API, as hooks. Each ends in one of a few plain states so
 * a page never has to guess: loading, ready, empty (a list), error (retry),
 * notFound (a song). Aborted on unmount, so a fast click through the site
 * never paints an old answer over a new page.
 */

export type ConfigState = "loading" | "on" | "off" | "error";

export function useJamConfig(): { state: ConfigState; retry: () => void } {
  const [state, setState] = useState<ConfigState>("loading");
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setState("loading");
    fetchJamConfig(controller.signal).then(
      (config) => setState(config.enabled ? "on" : "off"),
      (error: unknown) => {
        if (!(error instanceof DOMException && error.name === "AbortError")) {
          setState("error");
        }
      },
    );
    return () => controller.abort();
  }, [attempt]);
  return { state, retry: () => setAttempt((n) => n + 1) };
}

export type JamTab = "top" | "needs" | "new" | "done";

export interface ListState {
  songs: PublicJamSong[];
  status: "loading" | "ready" | "error";
  /** More pages exist. */
  more: boolean;
  /** A further page is on its way. */
  loadingMore: boolean;
  loadMore: () => void;
  retry: () => void;
}

/** Songs a tab keeps, from the page the server answered. The server sorts; two tabs filter. */
export function tabKeeps(tab: JamTab, song: Pick<PublicJamSong, "needs">): boolean {
  if (tab === "done") return song.needs.length === 0;
  if (tab === "needs") return song.needs.length > 0;
  return true;
}

/** Pages one fill may read when a tab filters most of a page away. */
const FILL_PAGES = 4;
const WANT = 12;

/** An unfiltered tab is one server page at a time; a filtered one reads on until it has enough to show. */
const wantFor = (tab: JamTab): number => (tab === "needs" || tab === "done" ? WANT : 1);

export function useJamList(tab: JamTab, need: Instrument | null): ListState {
  const [songs, setSongs] = useState<PublicJamSong[]>([]);
  const [status, setStatus] = useState<ListState["status"]>("loading");
  const [cursor, setCursor] = useState<string | null>(null);
  const [more, setMore] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const generation = useRef(0);
  const controller = useRef<AbortController | null>(null);
  const cursorRef = useRef<string | null>(null);
  const busy = useRef(false);

  const sort = tab === "top" ? "top" : "new";
  const needsParam = tab === "needs" && need ? need : undefined;

  /** Read pages until at least `want` songs the tab keeps are in, or there are no more. */
  const fill = useCallback(
    async (start: string | null, want: number, mine: number, replace: boolean) => {
      busy.current = true;
      let next = start;
      let collected: PublicJamSong[] = [];
      try {
        for (let page = 0; page < FILL_PAGES; page++) {
          const result = await fetchJamList(
            { sort, needs: needsParam, cursor: next ?? undefined, limit: 24 },
            controller.current?.signal,
          );
          if (generation.current !== mine) return;
          collected = collected.concat(result.songs.filter((song) => tabKeeps(tab, song)));
          next = result.nextCursor;
          if (!next || collected.length >= want) break;
        }
        if (generation.current !== mine) return;
        cursorRef.current = next;
        setCursor(next);
        setMore(next !== null);
        setSongs((current) => {
          const base = replace ? [] : current;
          const seen = new Set(base.map((song) => song.id));
          return base.concat(collected.filter((song) => !seen.has(song.id)));
        });
        setStatus("ready");
      } catch (error) {
        if (error instanceof DOMException && error.name === "AbortError") return;
        if (generation.current === mine) {
          if (replace) setStatus("error");
          // A failed further page keeps what is there and offers the button again.
          else setMore(true);
        }
      } finally {
        if (generation.current === mine) {
          busy.current = false;
          setLoadingMore(false);
        }
      }
    },
    [sort, needsParam, tab],
  );

  useEffect(() => {
    generation.current += 1;
    const mine = generation.current;
    controller.current?.abort();
    controller.current = new AbortController();
    setSongs([]);
    setStatus("loading");
    setMore(false);
    setCursor(null);
    cursorRef.current = null;
    busy.current = false;
    void fill(null, wantFor(tab), mine, true);
    return () => controller.current?.abort();
  }, [fill, attempt, tab]);

  const loadMore = useCallback(() => {
    if (busy.current || !cursorRef.current) return;
    setLoadingMore(true);
    void fill(cursorRef.current, wantFor(tab), generation.current, false);
  }, [fill, tab]);

  // `cursor` is read through the ref; it is state too so the page re-renders on it.
  void cursor;
  return { songs, status, more, loadingMore, loadMore, retry: () => setAttempt((n) => n + 1) };
}

/** The featured song: the most liked one that has a part to show. */
export function useFeatured(): { song: PublicJamSong | null; status: "loading" | "ready" | "error" } {
  const [song, setSong] = useState<PublicJamSong | null>(null);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  useEffect(() => {
    const controller = new AbortController();
    fetchJamList({ sort: "top", limit: 6 }, controller.signal).then(
      (result) => {
        setSong(result.songs.find((candidate) => candidate.parts.length > 0) ?? null);
        setStatus("ready");
      },
      (error: unknown) => {
        if (!(error instanceof DOMException && error.name === "AbortError")) setStatus("error");
      },
    );
    return () => controller.abort();
  }, []);
  return { song, status };
}

export type SongState =
  | { status: "loading" }
  | { status: "error" }
  | { status: "notFound" }
  | { status: "ready"; detail: PublicJamSongDetail };

export function useJamSong(songId: string): { state: SongState; retry: () => void; refresh: () => Promise<PublicJamSongDetail | null> } {
  const [state, setState] = useState<SongState>({ status: "loading" });
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setState({ status: "loading" });
    fetchJam(songId, controller.signal).then(
      (detail) => setState({ status: "ready", detail }),
      (error: unknown) => {
        if (error instanceof DOMException && error.name === "AbortError") return;
        setState(error instanceof JamApiError && (error.status === 404 || error.status === 400) ? { status: "notFound" } : { status: "error" });
      },
    );
    return () => controller.abort();
  }, [songId, attempt]);
  const refresh = useCallback(async () => {
    try {
      return await fetchJam(songId);
    } catch {
      return null;
    }
  }, [songId]);
  return { state, retry: () => setAttempt((n) => n + 1), refresh };
}

import {
  ChevronLeft,
  ChevronRight,
  Eye,
  Flag,
  EyeOff,
  MoreHorizontal,
  Pause,
  Play,
  Send,
  ShieldMinus,
  Trash2,
  UserCog,
  Users,
  Volume2,
  VolumeX,
  X,
  Archive,
  Check,
} from "lucide-react";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import type { Story, StoryAuthor, StoryCallLive, StoryReaction } from "@pqp/shared";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Dialog } from "@/components/ui/dialog";
import { Menu } from "@/components/ui/menu";
import type { ContextMenuItemDef } from "@/components/ui/context-menu";
import { Textarea } from "@/components/ui/textarea";
import { useMediaQuery } from "@/components/ui/use-media-query";
import { UserAvatar } from "@/components/user/user-avatar";
import { ApiError } from "@/lib/api";
import { useTranslation } from "@/lib/i18n";
import {
  deleteStory,
  fetchStories,
  muteStoryAuthor,
  recordStoryViews,
  removeStoryFromServer,
  replyToStory,
  saveStoryToBau,
  setStoryReaction,
} from "@/lib/stories/api";
import { emitStoriesRefresh, onStoriesSignal } from "@/lib/stories/events";
import {
  STORY_REACTION_GLYPH,
  STORY_REACTION_ORDER,
  formatStoryAge,
} from "@/lib/stories/format";
import { commitSeenStories, noteStoriesSeen } from "@/lib/stories/seen-store";
import { ringAudienceKey, type ViewerRequest } from "@/lib/stories/ui-store";
import {
  createViewerState,
  currentPerson,
  currentStoryId,
  idsToPreload,
  isPaused,
  progressFraction,
  storyDisplayMs,
  viewerReducer,
} from "@/lib/stories/viewer-state";
import { cn } from "@/lib/utils";
import { StoryContent, type StoryDisplay } from "./story-content";
import { StoryReportDialog } from "./story-report-dialog";
import type { StoryViewerSelf } from "./story-strip";
import { StoryViewersSheet } from "./story-viewers-sheet";

/**
 * The story viewer: a modal over the app, never a route (design decision 32).
 *
 * Motion follows design §4 "Movimento": the card grows out of the ring that
 * opened it and goes back into it, people change as a deck (the next card
 * slides over, the current one recedes and dims), a story within one person
 * cuts with a 100 ms crossfade, the bars are linear, hold pauses at once and
 * fades the chrome after 250 ms, the reaction row rises, the emoji flies.
 * Under `prefers-reduced-motion` all of that becomes fades and the bars keep
 * running, because a progress bar is information, not decoration.
 *
 * The rules of what plays next live in `viewer-state.ts` and are tested
 * there; this file is the DOM around them.
 */

export function storyToDisplay(story: Story): StoryDisplay {
  return {
    id: story.id,
    kind: story.kind,
    text: story.text,
    background: story.background,
    caption: story.caption,
    mediaUrl: story.media?.url ?? null,
    posterUrl: story.media?.posterUrl ?? null,
    call: story.call,
  };
}

const SEEN_AFTER_MS = 1_000;
const VIEWS_FLUSH_MS = 1_500;
const DRAG_DECIDE_PX = 8;

function readToken(name: string, fallback: string): string {
  if (typeof document === "undefined") {
    return fallback;
  }
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback;
}

function prefersReducedMotion(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

interface StoryViewerProps {
  request: ViewerRequest;
  me: StoryViewerSelf;
  bauEnabled: boolean;
  onClosed: () => void;
  onJoinCall: (call: StoryCallLive) => void;
  onOpenRoles: (serverId: string) => void;
}

type Fx =
  | { kind: "fly"; key: number; glyph: string }
  | { kind: "pill"; key: number; text: string };

export function StoryViewer({
  request,
  me,
  bauEnabled,
  onClosed,
  onJoinCall,
  onOpenRoles,
}: StoryViewerProps) {
  const { t } = useTranslation();
  const wide = useMediaQuery("(min-width: 640px)", true);
  const [state, dispatch] = useReducer(viewerReducer, request, (req) =>
    createViewerState(req.people, { personIndex: req.startIndex }),
  );
  const [stories, setStories] = useState<ReadonlyMap<string, Story>>(new Map());
  const [missing, setMissing] = useState<ReadonlySet<string>>(new Set());
  const inflight = useRef(new Set<string>());
  const [now, setNow] = useState(() => Date.now());
  const [muted, setMuted] = useState(true);
  const [phase, setPhase] = useState<"opening" | "open" | "closing">("opening");
  const [held, setHeld] = useState(false);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [replyText, setReplyText] = useState("");
  const [replyFocused, setReplyFocused] = useState(false);
  const [replyState, setReplyState] = useState<"idle" | "sending" | "sent" | "error">("idle");
  const [fx, setFx] = useState<Fx | null>(null);
  const [toast, setToast] = useState<{ key: number; text: string } | null>(null);
  const [report, setReport] = useState<{ storyId: string; serverId: string | null } | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [modRemove, setModRemove] = useState<{ storyId: string; serverId: string; serverName: string } | null>(null);
  const [modReason, setModReason] = useState("");
  const [deck, setDeck] = useState<{ display: StoryDisplay; dir: "forward" | "back"; key: number } | null>(null);

  const rootRef = useRef<HTMLDivElement>(null);
  const cardRef = useRef<HTMLDivElement>(null);
  const deckRef = useRef<HTMLDivElement>(null);
  const replyRef = useRef<HTMLInputElement>(null);
  const restoreFocus = useRef<Element | null>(
    typeof document === "undefined" ? null : document.activeElement,
  );
  const pendingViews = useRef(new Set<string>());
  const flushTimer = useRef<number | null>(null);
  const markedSeen = useRef(new Set<string>());
  const lastDisplay = useRef<StoryDisplay | null>(null);
  const lastGeneration = useRef(state.generation);
  const closingRef = useRef(false);
  const replyNonce = useRef<{ storyId: string; text: string; nonce: string } | null>(null);

  const person = currentPerson(state);
  const storyId = currentStoryId(state);
  const story = storyId ? (stories.get(storyId) ?? null) : null;
  const author: StoryAuthor | null =
    story?.author ?? (person ? (request.authors[person.authorId] ?? null) : null);
  const isOwn = Boolean(story?.own) || person?.authorId === me.id;
  const audienceKey = ringAudienceKey(request.audience);
  const paused = isPaused(state);
  const fraction = progressFraction(state);
  const dialogOpen = Boolean(report || confirmDelete || modRemove);

  // ---------------------------------------------------------------- data
  useEffect(() => {
    const pending = inflight.current;
    const wanted = idsToPreload(state).filter(
      (id) => !stories.has(id) && !missing.has(id) && !pending.has(id),
    );
    if (wanted.length === 0) {
      return;
    }
    for (const id of wanted) {
      pending.add(id);
    }
    let cancelled = false;
    fetchStories(wanted)
      .then((found) => {
        if (cancelled) {
          return;
        }
        setStories((current) => {
          const next = new Map(current);
          for (const item of found) {
            next.set(item.id, item);
          }
          return next;
        });
        const foundIds = new Set(found.map((item) => item.id));
        const gone = wanted.filter((id) => !foundIds.has(id));
        if (gone.length > 0) {
          setMissing((current) => new Set([...current, ...gone]));
          dispatch({ type: "remove", storyIds: gone });
        }
        // Warm the next pictures so a tap never waits on a download.
        for (const item of found) {
          if (item.kind === "image" && item.media?.url) {
            const image = new Image();
            image.decoding = "async";
            image.src = item.media.url;
          }
        }
      })
      .catch(() => undefined)
      .finally(() => {
        for (const id of wanted) {
          pending.delete(id);
        }
      });
    return () => {
      cancelled = true;
      for (const id of wanted) {
        pending.delete(id);
      }
    };
    // `state` is read through idsToPreload; the indices are what move it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.personIndex, state.storyIndex, state.people, stories, missing]);

  // A frame that names removed stories drops them at once; an `own` frame
  // while watching our own stories refreshes their counts and status.
  useEffect(
    () =>
      onStoriesSignal((signal) => {
        if (signal.kind === "update" && signal.frame.removedStoryIds?.length) {
          dispatch({ type: "remove", storyIds: signal.frame.removedStoryIds });
        }
        if (signal.kind === "update" && signal.frame.scope === "own" && isOwnRef.current) {
          const ids = currentPersonIdsRef.current;
          if (ids.length > 0) {
            void fetchStories(ids)
              .then((found) =>
                setStories((current) => {
                  const next = new Map(current);
                  for (const item of found) {
                    next.set(item.id, item);
                  }
                  return next;
                }),
              )
              .catch(() => undefined);
          }
        }
      }),
    [],
  );
  const isOwnRef = useRef(isOwn);
  isOwnRef.current = isOwn;
  const currentPersonIdsRef = useRef<string[]>([]);
  currentPersonIdsRef.current = person?.storyIds ?? [];

  // Clock for ages and local expiry.
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 15_000);
    return () => window.clearInterval(timer);
  }, []);
  useEffect(() => {
    if (story?.expiresAt && Date.parse(story.expiresAt) <= now) {
      dispatch({ type: "remove", storyIds: [story.id] });
    }
  }, [story, now]);

  // How long this story stays up. A video tells us itself.
  useEffect(() => {
    if (!story || state.durationMs !== null) {
      return;
    }
    if (story.kind === "video") {
      if (story.own?.status === "processing" || !story.media?.url) {
        dispatch({ type: "duration", durationMs: storyDisplayMs({ ...story, kind: "image" }) });
      }
      return;
    }
    dispatch({ type: "duration", durationMs: storyDisplayMs(story) });
  }, [story, state.durationMs, state.generation]);

  // One rAF loop for every story that is not a playing video.
  const videoDriven = story?.kind === "video" && Boolean(story.media?.url) && story.own?.status !== "processing";
  useEffect(() => {
    if (videoDriven || phase !== "open") {
      return;
    }
    let frame = 0;
    let last = performance.now();
    const step = (time: number) => {
      dispatch({ type: "tick", deltaMs: time - last });
      last = time;
      frame = requestAnimationFrame(step);
    };
    frame = requestAnimationFrame(step);
    return () => cancelAnimationFrame(frame);
  }, [videoDriven, phase]);

  // ---------------------------------------------------------------- seen
  const flushViews = useCallback(() => {
    if (flushTimer.current !== null) {
      window.clearTimeout(flushTimer.current);
      flushTimer.current = null;
    }
    const ids = [...pendingViews.current];
    pendingViews.current.clear();
    if (ids.length > 0) {
      void recordStoryViews(ids).catch(() => undefined);
    }
  }, []);

  useEffect(() => {
    if (!story || markedSeen.current.has(story.id) || state.elapsedMs < SEEN_AFTER_MS) {
      return;
    }
    markedSeen.current.add(story.id);
    noteStoriesSeen([story.id]);
    if (story.author.id === me.id || story.own) {
      return;
    }
    pendingViews.current.add(story.id);
    if (flushTimer.current === null) {
      flushTimer.current = window.setTimeout(flushViews, VIEWS_FLUSH_MS);
    }
  }, [story, state.elapsedMs, me.id, flushViews]);

  // ---------------------------------------------------------------- pauses
  useEffect(() => {
    dispatch({ type: sheetOpen ? "pause" : "resume", reason: "sheet" });
  }, [sheetOpen]);
  useEffect(() => {
    dispatch({ type: replyFocused || replyState === "sent" ? "pause" : "resume", reason: "reply" });
  }, [replyFocused, replyState]);
  useEffect(() => {
    dispatch({ type: dialogOpen ? "pause" : "resume", reason: "dialog" });
  }, [dialogOpen]);
  useEffect(() => {
    const sync = () =>
      dispatch({ type: document.visibilityState === "hidden" ? "pause" : "resume", reason: "hidden" });
    document.addEventListener("visibilitychange", sync);
    return () => document.removeEventListener("visibilitychange", sync);
  }, []);

  // Reset per story: the reply line, the sheet stays only on our own.
  useEffect(() => {
    setReplyState("idle");
    if (!isOwnRef.current) {
      setSheetOpen(false);
    }
  }, [storyId]);

  // ---------------------------------------------------------------- open / close
  const ringFor = useCallback(
    (authorId: string | null): Element | null => {
      const ids = [
        authorId === me.id ? `${audienceKey}:own` : authorId ? `${audienceKey}:${authorId}` : null,
        request.originRingId,
      ];
      for (const id of ids) {
        if (!id) {
          continue;
        }
        const element = document.querySelector(`[data-story-ring="${CSS.escape(id)}"]`);
        if (element) {
          return element;
        }
      }
      return null;
    },
    [audienceKey, me.id, request.originRingId],
  );

  useLayoutEffect(() => {
    const card = cardRef.current;
    const root = rootRef.current;
    root?.focus({ preventScroll: true });
    if (!card) {
      setPhase("open");
      return;
    }
    const reduced = prefersReducedMotion();
    const emphasized = readToken("--ease-emphasized", "ease-out");
    const origin = request.originRect;
    let animation: Animation;
    if (reduced || !origin || typeof card.animate !== "function") {
      animation = card.animate?.([{ opacity: 0 }, { opacity: 1 }], {
        duration: 200,
        easing: "linear",
      });
    } else {
      const box = card.getBoundingClientRect();
      const scale = origin.width / box.width;
      const dx = origin.left + origin.width / 2 - (box.left + box.width / 2);
      const dy = origin.top + origin.height / 2 - (box.top + box.height / 2);
      const square = Math.max(0, (box.height - box.width) / 2);
      animation = card.animate(
        [
          {
            transform: `translate(${dx}px, ${dy}px) scale(${scale})`,
            clipPath: `inset(${square}px 0px round ${box.width / 2}px)`,
          },
          { transform: "none", clipPath: `inset(0px 0px round ${wide ? 14 : 0}px)` },
        ],
        { duration: 360, easing: emphasized },
      );
    }
    if (!animation) {
      setPhase("open");
      return;
    }
    animation.onfinish = () => setPhase((current) => (current === "opening" ? "open" : current));
    return () => animation.cancel();
    // Once, on mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const finishClose = useCallback(() => {
    flushViews();
    onClosed();
    // The ring turns grey only once the card is back in it (design §4).
    window.setTimeout(commitSeenStories, 120);
    const ring = ringFor(person?.authorId ?? null) ?? restoreFocus.current;
    if (ring instanceof HTMLElement) {
      ring.focus({ preventScroll: true });
    }
  }, [flushViews, onClosed, ringFor, person?.authorId]);

  const close = useCallback(() => {
    if (closingRef.current) {
      return;
    }
    closingRef.current = true;
    setPhase("closing");
    const card = cardRef.current;
    const root = rootRef.current;
    if (!card || typeof card.animate !== "function") {
      finishClose();
      return;
    }
    const reduced = prefersReducedMotion();
    const ring = ringFor(person?.authorId ?? null);
    const ringBox = ring?.getBoundingClientRect() ?? null;
    const box = card.getBoundingClientRect();
    const onScreen =
      ringBox &&
      ringBox.width > 0 &&
      ringBox.bottom > 0 &&
      ringBox.top < window.innerHeight &&
      ringBox.right > 0 &&
      ringBox.left < window.innerWidth;
    root?.animate?.([{ opacity: 1 }, { opacity: 0 }], {
      duration: reduced ? 150 : 280,
      easing: "linear",
      fill: "forwards",
    });
    let animation: Animation;
    if (reduced) {
      animation = card.animate([{ opacity: 1 }, { opacity: 0 }], {
        duration: 150,
        fill: "forwards",
      });
    } else if (onScreen && ringBox) {
      const scale = ringBox.width / box.width;
      const dx = ringBox.left + ringBox.width / 2 - (box.left + box.width / 2);
      const dy = ringBox.top + ringBox.height / 2 - (box.top + box.height / 2);
      const square = Math.max(0, (box.height - box.width) / 2);
      animation = card.animate(
        [
          { transform: "none", clipPath: `inset(0px 0px round ${wide ? 14 : 0}px)` },
          {
            transform: `translate(${dx}px, ${dy}px) scale(${scale})`,
            clipPath: `inset(${square}px 0px round ${box.width / 2}px)`,
          },
        ],
        { duration: 280, easing: readToken("--story-ease-exit", "ease-in"), fill: "forwards" },
      );
    } else {
      animation = card.animate(
        [
          { transform: "none", opacity: 1 },
          { transform: "scale(0.96)", opacity: 0 },
        ],
        { duration: 200, easing: readToken("--ease-standard", "ease"), fill: "forwards" },
      );
    }
    animation.onfinish = finishClose;
  }, [finishClose, person?.authorId, ringFor, wide]);

  useEffect(() => {
    if (state.closed) {
      close();
    }
  }, [state.closed, close]);

  // ---------------------------------------------------------------- deck
  const display = story ? storyToDisplay(story) : null;
  useLayoutEffect(() => {
    if (state.generation === lastGeneration.current) {
      return;
    }
    lastGeneration.current = state.generation;
    const previous = lastDisplay.current;
    if (state.lastMove === "none" || !previous) {
      return;
    }
    setDeck({ display: previous, dir: state.lastMove, key: state.generation });
  }, [state.generation, state.lastMove]);
  if (display) {
    lastDisplay.current = display;
  }

  useLayoutEffect(() => {
    if (!deck) {
      return;
    }
    const outgoing = deckRef.current;
    const incoming = cardRef.current?.querySelector<HTMLElement>("[data-story-stage-wrap]");
    const reduced = prefersReducedMotion();
    const easing = readToken("--ease-emphasized", "ease-out");
    const sign = deck.dir === "forward" ? 1 : -1;
    const animations: Animation[] = [];
    if (reduced) {
      if (outgoing) {
        animations.push(outgoing.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 200, fill: "forwards" }));
      }
    } else {
      if (outgoing) {
        animations.push(
          outgoing.animate(
            [
              { transform: "none", filter: "brightness(1)" },
              { transform: `translateX(${-28 * sign}%) scale(0.9)`, filter: "brightness(0.45)" },
            ],
            { duration: 320, easing, fill: "forwards" },
          ),
        );
      }
      if (incoming) {
        animations.push(
          incoming.animate(
            [{ transform: `translateX(${100 * sign}%)` }, { transform: "none" }],
            { duration: 320, easing },
          ),
        );
      }
    }
    const timer = window.setTimeout(() => setDeck(null), reduced ? 200 : 320);
    return () => {
      window.clearTimeout(timer);
      for (const animation of animations) {
        animation.cancel();
      }
    };
  }, [deck]);

  // ---------------------------------------------------------------- gestures
  const gesture = useRef<{
    x: number;
    y: number;
    t: number;
    mode: "none" | "x" | "y" | "up";
    dx: number;
    dy: number;
    id: number;
  } | null>(null);

  function onStagePointerDown(event: ReactPointerEvent<HTMLDivElement>) {
    if (event.button !== 0 || phase !== "open") {
      return;
    }
    gesture.current = {
      x: event.clientX,
      y: event.clientY,
      t: performance.now(),
      mode: "none",
      dx: 0,
      dy: 0,
      id: event.pointerId,
    };
    event.currentTarget.setPointerCapture?.(event.pointerId);
    dispatch({ type: "pause", reason: "hold" });
    setHeld(true);
  }

  function onStagePointerMove(event: ReactPointerEvent<HTMLDivElement>) {
    const current = gesture.current;
    const card = cardRef.current;
    if (!current || current.id !== event.pointerId || !card) {
      return;
    }
    current.dx = event.clientX - current.x;
    current.dy = event.clientY - current.y;
    if (current.mode === "none") {
      if (Math.abs(current.dx) > DRAG_DECIDE_PX && Math.abs(current.dx) > Math.abs(current.dy)) {
        current.mode = "x";
      } else if (current.dy > DRAG_DECIDE_PX && current.dy > Math.abs(current.dx)) {
        current.mode = "y";
      } else if (current.dy < -DRAG_DECIDE_PX && isOwn) {
        current.mode = "up";
      }
    }
    const reduced = prefersReducedMotion();
    if (current.mode === "x") {
      card.style.transform = `translateX(${current.dx}px)`;
    } else if (current.mode === "y") {
      const dy = Math.max(0, current.dy);
      const shrink = reduced ? 1 : 1 - Math.min(dy / card.offsetHeight, 1) * 0.15;
      card.style.transform = `translateY(${dy}px) scale(${shrink})`;
    }
  }

  function settleCard() {
    const card = cardRef.current;
    if (!card) {
      return;
    }
    const from = card.style.transform;
    card.style.transform = "";
    if (from && typeof card.animate === "function" && !prefersReducedMotion()) {
      card.animate([{ transform: from }, { transform: "none" }], {
        duration: 320,
        easing: readToken("--ease-emphasized", "ease-out"),
      });
    }
  }

  function onStagePointerUp(event: ReactPointerEvent<HTMLDivElement>) {
    const current = gesture.current;
    gesture.current = null;
    dispatch({ type: "resume", reason: "hold" });
    setHeld(false);
    if (!current || current.id !== event.pointerId) {
      return;
    }
    const card = cardRef.current;
    const elapsed = Math.max(1, performance.now() - current.t);
    if (current.mode === "x" && card) {
      const width = card.offsetWidth || 1;
      const velocity = Math.abs(current.dx) / elapsed;
      card.style.transform = "";
      if (Math.abs(current.dx) > width * 0.35 || velocity > 0.6) {
        dispatch({ type: current.dx < 0 ? "nextPerson" : "prevPerson" });
      } else {
        card.style.transform = `translateX(${current.dx}px)`;
        settleCard();
      }
      return;
    }
    if (current.mode === "y" && card) {
      const velocity = current.dy / elapsed;
      if (current.dy > 120 || velocity > 0.8) {
        dispatch({ type: "close" });
      } else {
        settleCard();
      }
      return;
    }
    if (current.mode === "up") {
      if (current.dy < -60) {
        setSheetOpen(true);
      }
      return;
    }
    // A tap, not a hold: left third goes back, the rest goes on.
    if (elapsed < 250) {
      const box = event.currentTarget.getBoundingClientRect();
      const x = event.clientX - box.left;
      dispatch({ type: x < box.width / 3 ? "prev" : "next" });
    }
  }

  function onStagePointerCancel() {
    gesture.current = null;
    dispatch({ type: "resume", reason: "hold" });
    setHeld(false);
    settleCard();
  }

  // ---------------------------------------------------------------- keyboard
  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (dialogOpen || phase === "closing") {
        return;
      }
      const typing = document.activeElement === replyRef.current;
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        if (typing) {
          replyRef.current?.blur();
        } else if (sheetOpen) {
          setSheetOpen(false);
        } else {
          dispatch({ type: "close" });
        }
        return;
      }
      if (typing) {
        return;
      }
      const target = event.target as HTMLElement | null;
      if (target?.closest("[role=menu]")) {
        return;
      }
      if (event.key === "ArrowRight") {
        event.preventDefault();
        dispatch({ type: event.shiftKey ? "nextPerson" : "next" });
      } else if (event.key === "ArrowLeft") {
        event.preventDefault();
        dispatch({ type: event.shiftKey ? "prevPerson" : "prev" });
      } else if (event.key === " ") {
        event.preventDefault();
        dispatch({
          type: state.pauses.includes("key") ? "resume" : "pause",
          reason: "key",
        });
      } else if ((event.key === "r" || event.key === "R") && replyRef.current) {
        event.preventDefault();
        replyRef.current.focus();
      } else if (event.key === "ArrowUp" && isOwnRef.current) {
        event.preventDefault();
        setSheetOpen(true);
      } else if (event.key === "ArrowDown" && sheetOpen) {
        event.preventDefault();
        setSheetOpen(false);
      }
    }
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [dialogOpen, phase, sheetOpen, state.pauses]);

  // Keep Tab inside the viewer.
  function onRootKeyDown(event: ReactKeyboardEvent<HTMLDivElement>) {
    if (event.key !== "Tab" || !rootRef.current) {
      return;
    }
    const focusable = [
      ...rootRef.current.querySelectorAll<HTMLElement>(
        "button:not([disabled]), input:not([disabled]), a[href], [tabindex='0']",
      ),
    ].filter((element) => element.offsetParent !== null && !element.closest("[inert]"));
    if (focusable.length === 0) {
      return;
    }
    const first = focusable[0]!;
    const last = focusable[focusable.length - 1]!;
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

  // ---------------------------------------------------------------- actions
  function showToast(text: string) {
    setToast({ key: Date.now(), text });
  }
  useEffect(() => {
    if (!toast) {
      return;
    }
    const timer = window.setTimeout(() => setToast(null), 1800);
    return () => window.clearTimeout(timer);
  }, [toast]);
  useEffect(() => {
    if (!fx) {
      return;
    }
    const timer = window.setTimeout(() => setFx(null), fx.kind === "fly" ? 650 : 1250);
    return () => window.clearTimeout(timer);
  }, [fx]);

  function patchStory(id: string, patch: (story: Story) => Story) {
    setStories((current) => {
      const existing = current.get(id);
      if (!existing) {
        return current;
      }
      const next = new Map(current);
      next.set(id, patch(existing));
      return next;
    });
  }

  function react(reaction: StoryReaction) {
    if (!story || isOwn) {
      return;
    }
    const previous = story.viewer.reaction;
    const next = previous === reaction ? null : reaction;
    patchStory(story.id, (item) => ({ ...item, viewer: { ...item.viewer, reaction: next, seen: true } }));
    noteStoriesSeen([story.id]);
    if (next) {
      setFx(
        prefersReducedMotion()
          ? { kind: "pill", key: Date.now(), text: t("stories.viewer.reacted", { emoji: STORY_REACTION_GLYPH[next] }) }
          : { kind: "fly", key: Date.now(), glyph: STORY_REACTION_GLYPH[next] },
      );
    }
    void setStoryReaction(story.id, next).catch(() => {
      patchStory(story.id, (item) => ({ ...item, viewer: { ...item.viewer, reaction: previous } }));
    });
  }

  async function sendReply() {
    const text = replyText.trim();
    if (!story || !text || replyState === "sending") {
      return;
    }
    setReplyState("sending");
    // One nonce per reply: a retry of the same text after a failure reuses
    // it, so a reply whose answer was lost is not sent twice.
    if (
      !replyNonce.current ||
      replyNonce.current.text !== text ||
      replyNonce.current.storyId !== story.id
    ) {
      replyNonce.current = { storyId: story.id, text, nonce: crypto.randomUUID() };
    }
    try {
      await replyToStory(story.id, text, replyNonce.current.nonce);
      replyNonce.current = null;
      setReplyText("");
      setReplyState("sent");
      replyRef.current?.blur();
      window.setTimeout(() => setReplyState((current) => (current === "sent" ? "idle" : current)), 1200);
    } catch {
      setReplyState("error");
    }
  }

  async function runDelete(id: string) {
    setConfirmDelete(null);
    try {
      await deleteStory(id);
      setSheetOpen(false);
      dispatch({ type: "remove", storyIds: [id] });
      emitStoriesRefresh();
    } catch {
      showToast(t("stories.own.failed"));
    }
  }

  async function runModRemove() {
    if (!modRemove) {
      return;
    }
    const target = modRemove;
    setModRemove(null);
    try {
      await removeStoryFromServer(target.serverId, target.storyId, modReason.trim() || undefined);
      setModReason("");
      showToast(t("stories.menu.modRemoved", { server: target.serverName }));
      dispatch({ type: "remove", storyIds: [target.storyId] });
    } catch (error) {
      showToast(error instanceof ApiError && error.status !== 0 ? error.message : t("stories.own.failed"));
    }
  }

  async function runSaveToBau(serverId: string) {
    if (!story) {
      return;
    }
    const name =
      story.audiences.find((audience) => audience.kind === "server" && audience.serverId === serverId);
    try {
      await saveStoryToBau(story.id, serverId);
      showToast(
        t("stories.own.savedToBau", {
          server: name && name.kind === "server" ? name.serverName : "",
        }),
      );
    } catch {
      showToast(t("stories.own.failed"));
    }
  }

  async function runMute(target: StoryAuthor) {
    try {
      await muteStoryAuthor(target.id);
      showToast(t("stories.menu.muted", { name: target.displayName }));
      const ids = state.people.find((entry) => entry.authorId === target.id)?.storyIds ?? [];
      dispatch({ type: "remove", storyIds: ids });
      emitStoriesRefresh();
    } catch {
      showToast(t("stories.own.failed"));
    }
  }

  // ---------------------------------------------------------------- derived
  const seenThrough =
    request.audience.kind === "server" ? request.audience.serverName : t("stories.viewer.friends");
  const audienceLine =
    story && isOwn
      ? story.audiences
          .map((audience) => (audience.kind === "server" ? audience.serverName : t("stories.viewer.friends")))
          .join(" · ")
      : seenThrough;
  const bauServers =
    story && isOwn && bauEnabled
      ? story.viewer.canSaveToBau.flatMap((serverId) => {
          const audience = story.audiences.find(
            (entry) => entry.kind === "server" && entry.serverId === serverId,
          );
          return audience && audience.kind === "server"
            ? [{ serverId, serverName: audience.serverName }]
            : [];
        })
      : [];
  const moderatedServer =
    story && !isOwn && request.audience.kind === "server" && story.viewer.canModerate.includes(request.audience.serverId)
      ? request.audience
      : null;

  const menuItems: ContextMenuItemDef[] = useMemo(() => {
    if (!story || !author) {
      return [];
    }
    if (isOwn) {
      return [
        ...bauServers.map((server) => ({
          id: `bau-${server.serverId}`,
          label:
            bauServers.length > 1
              ? `${t("stories.own.saveToBau")} · ${server.serverName}`
              : t("stories.own.saveToBau"),
          icon: Archive,
          onSelect: () => void runSaveToBau(server.serverId),
        })),
        {
          id: "views",
          label: t("stories.viewer.viewsButton"),
          icon: Eye,
          onSelect: () => setSheetOpen(true),
        },
        { id: "sep", label: "", separator: true },
        {
          id: "delete",
          label: t("stories.own.delete"),
          icon: Trash2,
          danger: true,
          onSelect: () => setConfirmDelete(story.id),
        },
      ];
    }
    const items: ContextMenuItemDef[] = [
      {
        id: "mute",
        label: t("stories.menu.mute", { name: author.displayName }),
        icon: EyeOff,
        onSelect: () => void runMute(author),
      },
      {
        id: "report",
        label: t("stories.menu.report"),
        icon: Flag,
        danger: true,
        onSelect: () =>
          setReport({
            storyId: story.id,
            serverId: request.audience.kind === "server" ? request.audience.serverId : null,
          }),
      },
    ];
    if (moderatedServer) {
      items.push(
        { id: "sep-mod", label: "", separator: true },
        {
          id: "mod-heading",
          label: t("stories.menu.modSection", { server: moderatedServer.serverName }),
          heading: true,
        },
        {
          id: "mod-remove",
          label: t("stories.menu.modRemove", { server: moderatedServer.serverName }),
          icon: ShieldMinus,
          danger: true,
          onSelect: () =>
            setModRemove({
              storyId: story.id,
              serverId: moderatedServer.serverId,
              serverName: moderatedServer.serverName,
            }),
        },
        {
          id: "mod-revoke",
          label: t("stories.menu.revoke"),
          icon: UserCog,
          onSelect: () => {
            onOpenRoles(moderatedServer.serverId);
            dispatch({ type: "close" });
          },
        },
      );
    }
    return items;
    // The handlers close over the current story; that is the dependency.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [story, author, isOwn, bauServers.length, moderatedServer?.serverId, t]);

  const previousPerson = state.people[state.personIndex - 1] ?? null;
  const nextPerson = state.people[state.personIndex + 1] ?? null;
  const processing = story?.own?.status === "processing";
  const replyBlocked = story && !isOwn && !story.viewer.canReply;
  const showTray = !isOwn && story && story.viewer.canReply && replyFocused;

  // ---------------------------------------------------------------- render
  const card = (
    <div
      ref={cardRef}
      data-story-card=""
      data-story-sheet={sheetOpen ? "open" : "closed"}
      data-story-held={held ? "true" : "false"}
      className={cn(
        "relative flex flex-col overflow-hidden",
        wide
          ? "h-[min(650px,calc(100dvh-96px))] aspect-[366/650] rounded-[14px] shadow-[var(--story-shadow)]"
          : "h-full w-full",
      )}
      style={{ background: "var(--story-card)", touchAction: "none" }}
    >
      <div className="relative min-h-0 flex-1">
        {deck && (
          <div
            ref={deckRef}
            key={deck.key}
            aria-hidden
            className="pointer-events-none absolute inset-0 z-0 overflow-hidden rounded-b-[14px]"
          >
            <StoryContent story={deck.display} still />
          </div>
        )}
        <div
          data-story-stage-wrap=""
          className="absolute inset-0 z-[1]"
        >
          <div
            className="story-stage absolute inset-0 overflow-hidden rounded-b-[14px]"
            onPointerDown={onStagePointerDown}
            onPointerMove={onStagePointerMove}
            onPointerUp={onStagePointerUp}
            onPointerCancel={onStagePointerCancel}
            style={{ background: "var(--story-card)" }}
          >
            {display ? (
              <StoryContent
                key={display.id}
                story={display}
                className="story-media-in"
                playVideo={phase === "open"}
                muted={muted}
                paused={paused}
                onJoinCall={(call) => {
                  onJoinCall(call);
                  dispatch({ type: "close" });
                }}
                onVideoDuration={(ms) => dispatch({ type: "duration", durationMs: ms })}
                onVideoTime={(ms) => dispatch({ type: "progress", elapsedMs: ms })}
                onVideoEnded={() => dispatch({ type: "next" })}
              />
            ) : (
              <div className="absolute inset-0 flex items-center justify-center">
                {storyId && missing.has(storyId) ? (
                  <p className="px-6 text-center text-sm" style={{ color: "var(--story-on-media-2)" }}>
                    {t("stories.viewer.failed")}
                  </p>
                ) : (
                  <span
                    className="h-8 w-8 animate-spin rounded-full border-2 border-transparent"
                    style={{ borderTopColor: "var(--story-on-media)" }}
                    aria-hidden
                  />
                )}
              </div>
            )}
            {processing && (
              <div className="absolute inset-x-6 top-1/2 -translate-y-1/2 rounded-[var(--radius-card)] p-3 text-center text-sm" style={{ background: "var(--story-tray)", color: "var(--story-on-media)" }}>
                {t("stories.viewer.processing")}
              </div>
            )}
            {showTray && <div aria-hidden className="story-dim absolute inset-0" />}
          </div>

          {/* Chrome: bars and header. */}
          <div className="story-chrome pointer-events-none absolute inset-x-0 top-0 z-10 px-3 pt-3">
            <div className="flex gap-1" aria-hidden>
              {(person?.storyIds ?? []).map((id, index) => (
                <span
                  key={id}
                  className="relative h-[2.5px] flex-1 overflow-hidden rounded-full"
                  style={{ background: "var(--story-track)" }}
                >
                  <span
                    className="absolute inset-0 origin-left rounded-full"
                    data-story-bar={index === state.storyIndex ? "current" : index < state.storyIndex ? "done" : "next"}
                    style={{
                      background: "var(--story-on-media)",
                      transform: `scaleX(${index < state.storyIndex ? 1 : index === state.storyIndex ? fraction : 0})`,
                      transition:
                        index < state.storyIndex
                          ? "transform var(--duration-fast) var(--ease-standard)"
                          : "none",
                    }}
                  />
                </span>
              ))}
            </div>
            <div className="mt-2.5 flex items-center gap-2.5">
              {author && (
                <UserAvatar
                  name={author.displayName}
                  avatarUrl={author.avatarUrl}
                  rounded="full"
                  className="h-8 w-8"
                  fallbackClassName="bg-surface-3 text-xs text-text"
                />
              )}
              <div className="min-w-0 flex-1" style={{ color: "var(--story-on-media)" }}>
                <p className="truncate text-sm font-bold leading-tight">
                  {isOwn ? t("stories.strip.yours") : author?.displayName}
                  <span className="ml-1.5 font-medium" style={{ color: "var(--story-on-media-2)" }}>
                    {formatStoryAge(story?.publishedAt ?? null, now)}
                  </span>
                </p>
                <p className="mt-0.5 flex items-center gap-1 truncate text-[11.5px] font-semibold" style={{ color: "var(--story-on-media-2)" }}>
                  <Users className="h-3 w-3 shrink-0" aria-hidden />
                  <span className="truncate">{audienceLine}</span>
                </p>
              </div>
              <div className="pointer-events-auto flex items-center">
                {story?.kind === "video" && !processing && (
                  <ChromeButton
                    label={muted ? t("stories.viewer.unmute") : t("stories.viewer.mute")}
                    onClick={() => setMuted((value) => !value)}
                  >
                    {muted ? <VolumeX className="h-5 w-5" /> : <Volume2 className="h-5 w-5" />}
                  </ChromeButton>
                )}
                <ChromeButton
                  label={paused ? t("stories.viewer.play") : t("stories.viewer.pause")}
                  onClick={() =>
                    dispatch({ type: state.pauses.includes("key") ? "resume" : "pause", reason: "key" })
                  }
                >
                  {state.pauses.includes("key") ? <Play className="h-5 w-5" /> : <Pause className="h-5 w-5" />}
                </ChromeButton>
                {menuItems.length > 0 && (
                  <Menu
                    items={menuItems}
                    align="end"
                    onOpenChange={(open) =>
                      dispatch({ type: open ? "pause" : "resume", reason: "menu" })
                    }
                  >
                    <button
                      type="button"
                      aria-label={t("stories.viewer.more")}
                      data-story-more=""
                      className="flex h-9 w-9 items-center justify-center rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring"
                      style={{ color: "var(--story-on-media)" }}
                    >
                      <MoreHorizontal className="h-5 w-5" />
                    </button>
                  </Menu>
                )}
                <ChromeButton label={t("stories.viewer.close")} onClick={() => dispatch({ type: "close" })}>
                  <X className="h-5 w-5" />
                </ChromeButton>
              </div>
            </div>
          </div>

          {fx?.kind === "fly" && (
            <span
              key={fx.key}
              aria-hidden
              className={cn(
                "story-react-fly absolute bottom-6 left-8 z-30 text-3xl",
                fx.glyph === "GG" && "rounded-[10px] bg-accent px-2 py-1 font-display text-lg font-black text-on-accent",
              )}
            >
              {fx.glyph}
            </span>
          )}
          {fx?.kind === "pill" && (
            <span
              key={fx.key}
              role="status"
              className="story-pill absolute bottom-6 left-1/2 z-30 -translate-x-1/2 rounded-full px-3 py-1.5 text-xs font-semibold"
              style={{ background: "var(--story-tray)", color: "var(--story-on-media)" }}
            >
              {fx.text}
            </span>
          )}
          {toast && (
            <span
              key={toast.key}
              role="status"
              className="story-pill absolute left-1/2 top-20 z-30 -translate-x-1/2 whitespace-nowrap rounded-full px-3 py-1.5 text-xs font-semibold"
              style={{ background: "var(--story-tray)", color: "var(--story-on-media)" }}
            >
              {toast.text}
            </span>
          )}

          {showTray && (
            <div
              className="story-tray-up absolute inset-x-3 bottom-3 z-20 flex h-14 items-center justify-around rounded-full border px-2 shadow-[var(--story-shadow)]"
              style={{ background: "var(--story-tray)", borderColor: "var(--story-hairline)" }}
              onPointerDown={(event) => event.preventDefault()}
            >
              {STORY_REACTION_ORDER.map((reaction, index) => (
                <button
                  key={reaction}
                  type="button"
                  aria-label={t("stories.viewer.react", { emoji: STORY_REACTION_GLYPH[reaction] })}
                  aria-pressed={story?.viewer.reaction === reaction}
                  data-story-react={reaction}
                  onClick={() => react(reaction)}
                  className={cn(
                    "story-react-pop flex h-11 min-w-11 items-center justify-center rounded-full transition-transform hover:scale-110 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring",
                    story?.viewer.reaction === reaction && "ring-2 ring-accent",
                  )}
                  style={{ "--i": index } as CSSProperties}
                >
                  {reaction === "gg" ? (
                    <span className="rounded-[10px] bg-accent px-2 py-1.5 font-display text-base font-black leading-none text-on-accent">
                      GG
                    </span>
                  ) : (
                    <span className="text-[28px] leading-none">{STORY_REACTION_GLYPH[reaction]}</span>
                  )}
                </button>
              ))}
            </div>
          )}

          {story && isOwn && (
            <StoryViewersSheet
              story={story}
              open={sheetOpen}
              now={now}
              bauServers={bauServers}
              onSaveToBau={(serverId) => void runSaveToBau(serverId)}
              onDelete={() => setConfirmDelete(story.id)}
              onClose={() => setSheetOpen(false)}
            />
          )}
        </div>
      </div>

      {/* Footer. */}
      <div className="story-chrome relative z-10 flex min-h-16 shrink-0 items-center gap-2 px-3 pb-[env(safe-area-inset-bottom)]">
        {story && isOwn ? (
          <button
            type="button"
            data-story-views=""
            onClick={() => setSheetOpen((open) => !open)}
            className="flex h-10 items-center gap-2 rounded-full px-3 text-sm font-semibold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring"
            style={{ color: "var(--story-on-media)", background: "var(--story-field-fill)" }}
          >
            <Eye className="h-4 w-4" aria-hidden />
            {t("stories.viewers.title", { count: story.own?.viewCount ?? 0 })}
          </button>
        ) : replyBlocked ? (
          <p className="flex-1 px-1 text-center text-sm" style={{ color: "var(--story-on-media-2)" }}>
            {story.viewer.replyBlockedReason === "dm_closed"
              ? t("stories.viewer.dmClosed", { name: author?.displayName ?? "" })
              : t("stories.viewer.repliesOff", { name: author?.displayName ?? "" })}
          </p>
        ) : story ? (
          <form
            className="flex flex-1 items-center gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              void sendReply();
            }}
          >
            <label className="sr-only" htmlFor="story-reply">
              {t("stories.viewer.replyTo", { name: author?.displayName ?? "" })}
            </label>
            <div className="relative min-w-0 flex-1">
              <input
                id="story-reply"
                ref={replyRef}
                value={replyState === "sent" ? "" : replyText}
                maxLength={2000}
                autoComplete="off"
                onChange={(event) => {
                  setReplyText(event.target.value);
                  if (replyState === "error") {
                    setReplyState("idle");
                  }
                }}
                onFocus={() => setReplyFocused(true)}
                onBlur={() => setReplyFocused(false)}
                placeholder={
                  replyState === "sent" ? "" : t("stories.viewer.replyTo", { name: author?.displayName ?? "" })
                }
                className={cn(
                  "h-11 w-full rounded-full border-[1.5px] bg-transparent px-4 text-[15px] outline-none transition-colors duration-[var(--duration-fast)] placeholder:text-[var(--story-on-media-2)]",
                  replyState === "error" && "border-danger",
                )}
                style={{
                  color: "var(--story-on-media)",
                  borderColor:
                    replyState === "error"
                      ? undefined
                      : replyFocused
                        ? "var(--story-on-media)"
                        : "var(--story-field-edge)",
                  background: replyFocused ? "var(--story-field-fill)" : undefined,
                }}
              />
              {replyState === "sent" && (
                <span
                  role="status"
                  className="story-media-in pointer-events-none absolute inset-0 flex items-center gap-1.5 px-4 text-[15px] font-semibold text-accent"
                >
                  {t("stories.viewer.sent")}
                  <Check className="h-4 w-4" aria-hidden />
                </span>
              )}
            </div>
            {!replyText.trim() ? (
              <button
                type="button"
                data-story-gg=""
                aria-label={t("stories.viewer.react", { emoji: "GG" })}
                aria-pressed={story.viewer.reaction === "gg"}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => react("gg")}
                className={cn(
                  "flex h-11 w-11 shrink-0 items-center justify-center rounded-full border-[1.5px] font-display text-[15px] font-extrabold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring",
                  story.viewer.reaction === "gg" && "border-accent bg-accent text-on-accent",
                )}
                style={
                  story.viewer.reaction === "gg"
                    ? undefined
                    : { color: "var(--story-on-media)", borderColor: "var(--story-field-edge)" }
                }
              >
                GG
              </button>
            ) : null}
            <button
              type="submit"
              aria-label={t("stories.viewer.send")}
              disabled={!replyText.trim() || replyState === "sending"}
              onMouseDown={(event) => event.preventDefault()}
              className={cn(
                "flex h-11 w-11 shrink-0 items-center justify-center rounded-full transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring disabled:opacity-60",
                replyText.trim() && "bg-accent text-on-accent",
              )}
              style={replyText.trim() ? undefined : { color: "var(--story-on-media)" }}
            >
              <Send className="h-5 w-5" aria-hidden />
            </button>
          </form>
        ) : null}
      </div>
    </div>
  );

  const keyHints = wide && (
    <div className="pointer-events-none absolute bottom-4 right-5 hidden items-center gap-3 text-[11px] font-medium text-text-tertiary lg:flex" aria-hidden>
      <span className="flex items-center gap-1">
        <Kbd>←</Kbd>
        <Kbd>→</Kbd>
        {t("stories.viewer.keyNavigate")}
      </span>
      <span className="flex items-center gap-1">
        <Kbd>{t("stories.viewer.keySpace")}</Kbd>
        {t("stories.viewer.keyPause")}
      </span>
      <span className="flex items-center gap-1">
        <Kbd>R</Kbd>
        {t("stories.viewer.keyReply")}
      </span>
      <span className="flex items-center gap-1">
        <Kbd>esc</Kbd>
        {t("stories.viewer.keyClose")}
      </span>
    </div>
  );

  return createPortal(
    <div
      ref={rootRef}
      role="dialog"
      aria-modal="true"
      aria-label={t("stories.viewer.label", { name: author?.displayName ?? "" })}
      tabIndex={-1}
      data-story-viewer=""
      onKeyDown={onRootKeyDown}
      className="story-backdrop-in fixed inset-0 z-[55] flex items-center justify-center outline-none"
      style={{ background: "var(--story-backdrop)", backdropFilter: "blur(10px)" }}
    >
      {wide && (
        <p className="absolute left-5 top-4 text-sm font-bold text-text">
          {request.audience.kind === "server" ? request.audience.serverName : t("stories.viewer.friends")}
          <span className="ml-1.5 font-medium text-text-tertiary">· {t("stories.strip.label").toLowerCase()}</span>
        </p>
      )}
      {wide && (
        <button
          type="button"
          aria-label={t("stories.viewer.close")}
          onClick={() => dispatch({ type: "close" })}
          className="absolute right-4 top-4 flex h-9 w-9 items-center justify-center rounded-full bg-surface-2 text-text hover:bg-surface-3 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring"
        >
          <X className="h-4 w-4" />
        </button>
      )}

      <div className="relative flex h-full w-full items-center justify-center gap-4">
        {wide && (
          <div className="hidden w-[140px] shrink-0 xl:block">
            {previousPerson && (
              <Neighbour
                author={request.authors[previousPerson.authorId] ?? null}
                story={stories.get(previousPerson.storyIds[0] ?? "") ?? null}
                onOpen={() => dispatch({ type: "goPerson", index: state.personIndex - 1 })}
              />
            )}
          </div>
        )}
        {wide && (
          <ArrowButton label={t("stories.viewer.prev")} onClick={() => dispatch({ type: "prev" })}>
            <ChevronLeft className="h-4 w-4" />
          </ArrowButton>
        )}
        {card}
        {wide && (
          <ArrowButton label={t("stories.viewer.next")} onClick={() => dispatch({ type: "next" })}>
            <ChevronRight className="h-4 w-4" />
          </ArrowButton>
        )}
        {wide && (
          <div className="hidden w-[140px] shrink-0 xl:block">
            {nextPerson && (
              <Neighbour
                author={request.authors[nextPerson.authorId] ?? null}
                story={stories.get(nextPerson.storyIds[0] ?? "") ?? null}
                onOpen={() => dispatch({ type: "goPerson", index: state.personIndex + 1 })}
              />
            )}
          </div>
        )}
      </div>
      {keyHints}

      <StoryReportDialog
        target={report}
        onClose={() => setReport(null)}
        onSent={() => {
          setReport(null);
          showToast(t("stories.report.sent"));
        }}
      />
      <ConfirmDialog
        open={confirmDelete !== null}
        title={t("stories.own.deleteTitle")}
        description={t("stories.own.deleteConfirm")}
        confirmLabel={t("stories.own.delete")}
        onConfirm={() => confirmDelete && void runDelete(confirmDelete)}
        onClose={() => setConfirmDelete(null)}
      />
      {modRemove && (
        <Dialog
          open
          size="sm"
          title={t("stories.menu.modRemove", { server: modRemove.serverName })}
          description={t("stories.menu.modRemoveHint")}
          onClose={() => setModRemove(null)}
          footer={
            <>
              <Button variant="ghost" onClick={() => setModRemove(null)}>
                {t("common.cancel")}
              </Button>
              <Button variant="danger" onClick={() => void runModRemove()}>
                {t("stories.menu.modRemove", { server: modRemove.serverName })}
              </Button>
            </>
          }
        >
          <div className="px-5 py-4">
            <Textarea
              value={modReason}
              maxLength={200}
              rows={2}
              className="min-h-16"
              aria-label={t("stories.menu.modRemoveReason")}
              placeholder={t("stories.menu.modRemoveReason")}
              onChange={(event) => setModReason(event.target.value)}
            />
          </div>
        </Dialog>
      )}
    </div>,
    document.body,
  );
}

function ChromeButton({
  label,
  onClick,
  children,
}: {
  label: string;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      onClick={onClick}
      className="flex h-9 w-9 items-center justify-center rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring"
      style={{ color: "var(--story-on-media)" }}
    >
      {children}
    </button>
  );
}

function ArrowButton({
  label,
  onClick,
  children,
}: {
  label: string;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      onClick={onClick}
      className="z-10 flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-text text-surface-0 opacity-90 hover:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring"
    >
      {children}
    </button>
  );
}

function Kbd({ children }: { children: ReactNode }) {
  return (
    <kbd className="rounded-[4px] border border-border bg-surface-2 px-1.5 py-0.5 font-sans text-[10px] font-semibold text-text-secondary">
      {children}
    </kbd>
  );
}

/** A neighbour on either side, at 55%: click it to jump to that person. */
function Neighbour({
  author,
  story,
  onOpen,
}: {
  author: StoryAuthor | null;
  story: Story | null;
  onOpen: () => void;
}) {
  const { t } = useTranslation();
  if (!author) {
    return null;
  }
  return (
    <button
      type="button"
      onClick={onOpen}
      aria-label={t("stories.viewer.openPerson", { name: author.displayName })}
      className="relative block h-[250px] w-[140px] overflow-hidden rounded-[12px] opacity-55 transition-opacity hover:opacity-80 focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring"
      style={{ background: "var(--story-card)" }}
    >
      {story && (
        <span className="absolute inset-0 scale-110 blur-[10px]">
          <StoryContent story={storyToDisplay(story)} still />
        </span>
      )}
      <span className="absolute inset-0 flex flex-col items-center justify-center gap-1.5" style={{ color: "var(--story-on-media)" }}>
        <UserAvatar
          name={author.displayName}
          avatarUrl={author.avatarUrl}
          rounded="full"
          className="h-10 w-10"
          fallbackClassName="bg-surface-3 text-sm text-text"
        />
        <span className="max-w-[120px] truncate text-sm font-semibold">{author.displayName}</span>
      </span>
    </button>
  );
}

import type { Friend, UserStatus } from "@pqp/shared";
import { X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useFriends } from "@/components/friends/use-friends";
import { useLeaving } from "@/components/retro/retro-layer";
import { isMusicRecado } from "@/components/retro/retro-model";
import { UserAvatar } from "@/components/user/user-avatar";
import { useTranslation } from "@/lib/i18n";
import {
  EMPTY_PACING,
  EMPTY_PRESENCE,
  HIDDEN_RESET_MS,
  observePresence,
  queueArrivals,
  takeToast,
  TOAST_VISIBLE_MS,
} from "@/lib/retro-presence";
import { friendOnlineSynth } from "@/lib/retro-sounds";
import { playSynthSound } from "@/lib/sounds";

/**
 * "Fulano acabou de entrar": the corner card for a FRIEND coming online, from
 * a diff of the friends list the app already polls (`lib/retro-presence.ts`
 * has the rules). One card at a time, grouped when several arrive close
 * together, never while I am on Não perturbe, never for the friend whose
 * conversation I am looking at.
 */
interface ShownToast {
  friends: Friend[];
  key: number;
}

export function OnlineToasts({
  enabled,
  sounds,
  myStatus,
  focusedPeerId,
  onOpen,
}: {
  enabled: boolean;
  sounds: boolean;
  myStatus: UserStatus | null;
  focusedPeerId: string | null;
  onOpen: (friendId: string) => void;
}) {
  const friends = useFriends();
  const memory = useRef(EMPTY_PRESENCE);
  const pacing = useRef(EMPTY_PACING);
  const hiddenSince = useRef<number | null>(null);
  const [shown, setShown] = useState<ShownToast | null>(null);
  const timer = useRef<number | null>(null);
  const allowed = enabled && myStatus !== "dnd";
  const latest = useRef({ friends: friends.data.friends, sounds, allowed });
  latest.current = { friends: friends.data.friends, sounds, allowed };

  const pump = useCallback(() => {
    if (timer.current !== null) {
      window.clearTimeout(timer.current);
      timer.current = null;
    }
    // Checked again when a held card comes due: the person may have turned
    // the cards off or gone Não perturbe while it waited.
    if (!latest.current.allowed) {
      pacing.current = { ...pacing.current, pending: [] };
      return;
    }
    const next = takeToast(pacing.current, Date.now());
    pacing.current = next.pacing;
    if (next.ids) {
      const people = next.ids
        .map((id) => latest.current.friends.find((one) => one.id === id))
        .filter((one): one is Friend => Boolean(one));
      if (people.length > 0) {
        setShown({ friends: people, key: Date.now() });
        if (latest.current.sounds) {
          playSynthSound(friendOnlineSynth);
        }
      }
    } else if (next.wait > 0) {
      timer.current = window.setTimeout(pump, next.wait);
    }
  }, []);

  useEffect(
    () => () => {
      if (timer.current !== null) window.clearTimeout(timer.current);
    },
    [],
  );

  // Turning the cards off, or going Não perturbe, also drops what is queued
  // and what is on screen.
  useEffect(() => {
    if (allowed) {
      return;
    }
    if (timer.current !== null) {
      window.clearTimeout(timer.current);
      timer.current = null;
    }
    pacing.current = { ...pacing.current, pending: [] };
    setShown(null);
  }, [allowed]);

  // A tab that sat hidden for a long time starts from a fresh baseline, so it
  // does not come back to a burst of everybody who signed in meanwhile.
  useEffect(() => {
    const onVisibility = () => {
      if (document.visibilityState === "hidden") {
        hiddenSince.current = Date.now();
        return;
      }
      if (
        hiddenSince.current !== null &&
        Date.now() - hiddenSince.current > HIDDEN_RESET_MS
      ) {
        memory.current = EMPTY_PRESENCE;
        pacing.current = EMPTY_PACING;
      }
      hiddenSince.current = null;
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, []);

  useEffect(() => {
    if (friends.loading) {
      return;
    }
    const result = observePresence(
      memory.current,
      friends.data.friends.map((one) => [one.id, one.status] as const),
      Date.now(),
    );
    memory.current = result.memory;
    if (!allowed || result.arrived.length === 0) {
      return;
    }
    const arrived = result.arrived.filter(
      (id) => !(id === focusedPeerId && document.hasFocus()),
    );
    pacing.current = queueArrivals(pacing.current, arrived);
    pump();
    // Only a new snapshot is a new observation; the rest is read through refs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [friends.data, friends.loading]);

  if (!shown) {
    return null;
  }
  return (
    <OnlineCard
      key={shown.key}
      friends={shown.friends}
      onGone={() => setShown(null)}
      onOpen={onOpen}
    />
  );
}

/** One "acabou de entrar" card: up for a few seconds, then it slides away. */
function OnlineCard({
  friends,
  onGone,
  onOpen,
}: {
  friends: Friend[];
  onGone: () => void;
  onOpen: (friendId: string) => void;
}) {
  const { t } = useTranslation();
  const [leaving, leave] = useLeaving(onGone);
  const [paused, setPaused] = useState(false);
  useEffect(() => {
    if (paused) {
      return;
    }
    const timer = window.setTimeout(leave, TOAST_VISIBLE_MS);
    return () => window.clearTimeout(timer);
  }, [leave, paused]);
  const [first, ...rest] = friends;
  if (!first) {
    return null;
  }
  const line =
    rest.length === 0
      ? t("retro.online", { name: first.displayName })
      : t("retro.online_many", { name: first.displayName, count: rest.length });
  return (
    <div
      className="retro-card"
      role="status"
      aria-label={t("retro.toast.region")}
      data-enter=""
      data-leave={leaving ? "" : undefined}
      data-retro-online=""
      onPointerEnter={() => setPaused(true)}
      onPointerLeave={() => setPaused(false)}
    >
      <div className="retro-card-bar">
        <span>pqp</span>
        <button type="button" aria-label={t("retro.toast.close")} onClick={leave}>
          <X className="h-3 w-3" aria-hidden />
        </button>
      </div>
      <button
        type="button"
        className="retro-card-body"
        onClick={() => {
          onGone();
          onOpen(first.id);
        }}
      >
        <span className="retro-frame" data-status={first.status}>
          <UserAvatar
            name={first.displayName}
            avatarUrl={first.avatarUrl}
            className="h-9 w-9"
            rounded="md"
            fallbackClassName="retro-avatar-fallback"
          />
        </span>
        <span className="min-w-0">
          <span className="block">{line}</span>
          {first.customStatus && (
            <span
              className="retro-to-recado block text-[11px]"
              data-music={isMusicRecado(first.customStatus) ? "" : undefined}
            >
              {first.customStatus}
            </span>
          )}
        </span>
      </button>
    </div>
  );
}

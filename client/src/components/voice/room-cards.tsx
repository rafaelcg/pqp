import {
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import {
  EarSlash,
  HandPalm,
  LinkSimple,
  MicrophoneSlash,
  MusicNotes,
  ShieldSlash,
  SpinnerGap,
} from "@phosphor-icons/react";
import { Icon } from "@/components/ui/icon";
import { Button } from "@/components/ui/button";
import { UserAvatar } from "@/components/user/user-avatar";
import { useBringFriendsServer } from "@/components/layout/bring-friends-hint";
import {
  PeerAudioMenu,
  usePeerAudioMenu,
  type PeerAudioTrack,
} from "@/components/voice/peer-audio-menu";
import { SoundboardFloat } from "@/components/voice/soundboard-float";
import {
  ROOM_CARD_RATIO,
  fitRoomCards,
  planRoomCards,
  roomStripFit,
} from "@/components/voice/stage-layout";
import { copyInvitePaste } from "@/lib/invite-paste-copy";
import { setMusicOpen } from "@/lib/music-store";
import { useTranslation } from "@/lib/i18n";
import { cn } from "@/lib/utils";

/**
 * THE ROOM AS CARDS, under the redesign (`showsRoomView`).
 *
 * A server voice call where nobody publishes a picture used to be a slim bar
 * over the transcript, and people coming from Discord read that as "the call
 * has no screen". This is that screen: one card per person, the way the QG
 * asked for it ("cada pessoa teria seu próprio card, mostrando o avatar e o
 * nome, e o card poderia reagir quando a pessoa estiver falando"). A card is
 * the face, the name, whether they are talking, and why they cannot be heard
 * (muted, no sound, muted by a moderator), plus a raised hand. A camera turns
 * the person into a picture tile on the ordinary stage, so a card never needs
 * a camera or share badge.
 *
 * Clicking a card opens the same audio panel every face opens. How many cards
 * and how many columns is `planRoomCards`; this file only draws the answer.
 */

export interface RoomCardEntry {
  key: string;
  userId?: string;
  name: string;
  avatarUrl: string | null;
  speaking: boolean;
  muted: boolean;
  deafened: boolean;
  serverMuted: boolean;
  handPosition: number | null;
  connecting: boolean;
  isSelf: boolean;
  failed?: boolean;
  onRetry?: () => void;
  /** Their camera goes in this card (`renderCamera` draws it). */
  camera?: boolean;
  audio?: {
    voice?: PeerAudioTrack;
    share?: PeerAudioTrack;
    soundboardUserId?: string;
  };
}

const COPY_MS = 1200;

/** Gap between cards and the padding around the grid, in px. */
const GAP = 12;
const PAD = 12;
/** "Ver todos" lays cards at least this wide and scrolls. */
const SHOW_ALL_MIN_WIDTH = 200;

/** How a card's size change animates: a camera or a share arriving. */
const RESIZE =
  "transition-[width,height] duration-[var(--duration-slow)] ease-out motion-reduce:transition-none";

export function RoomCards({
  people,
  youLabel,
  stage,
  renderCamera,
}: {
  people: RoomCardEntry[];
  youLabel: string;
  /**
   * A share (or the music clip) on the stage. Given, it takes the space above
   * and every card shrinks into one row under it.
   */
  stage?: ReactNode;
  /**
   * The picture tile for a card whose `camera` is set, drawn at the card's
   * size in the card's place. `first` is the first picture in the list, which
   * carries the stage's primary video (iPhone fullscreen hands that one over).
   */
  renderCamera?: (
    person: RoomCardEntry,
    style: CSSProperties | undefined,
    className: string,
    first: boolean,
  ) => ReactNode;
}) {
  const { t } = useTranslation();
  const [showAll, setShowAll] = useState(false);
  const [box, setBox] = useState({ width: 0, height: 0 });
  const [banners, setBanners] = useState(0);
  const rootRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const root = rootRef.current;
    if (!root || typeof ResizeObserver === "undefined") {
      return;
    }
    // The banner column is a sibling higher up the stage, drawn over its top
    // edge; a banner coming or going changes its height and not ours.
    let banner: Element | null = null;
    for (let at = root.parentElement; at && !banner; at = at.parentElement) {
      banner = at.querySelector(":scope > [data-stage-banners]");
    }
    const measure = () => {
      const rect = root.getBoundingClientRect();
      // How far the banners reach down over us, measured rather than read
      // from `--stage-banners`, which the stage sets a render later.
      const top = banner
        ? Math.max(0, banner.getBoundingClientRect().bottom - rect.top)
        : 0;
      setBanners(top);
      setBox({
        width: Math.max(0, rect.width - PAD * 2),
        height: Math.max(0, rect.height - PAD * 2 - top),
      });
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(root);
    if (banner) {
      observer.observe(banner);
    }
    return () => observer.disconnect();
  }, []);

  const strip = stage !== undefined;
  // One cell per person, plus the "+N" card only when they cannot all fit.
  const stripFit = roomStripFit(box, GAP, people.length);
  const plan = planRoomCards(people, {
    aloneCard: !strip,
    limit: strip ? Math.max(1, stripFit.perRow - 1) : undefined,
  });
  const shown = showAll ? people : plan.shown;
  const overflow = showAll ? 0 : plan.overflow;
  const cells = showAll ? people.length + 1 : plan.cells;
  let cardWidth = 0;
  let cardHeight = 0;
  if (strip) {
    cardWidth = stripFit.width;
    cardHeight = stripFit.height;
  } else if (showAll && box.width > 0) {
    const columns = Math.max(
      1,
      Math.floor((box.width + GAP) / (SHOW_ALL_MIN_WIDTH + GAP)),
    );
    cardWidth = Math.floor((box.width - GAP * (columns - 1)) / columns);
    cardHeight = Math.floor(cardWidth / ROOM_CARD_RATIO);
  } else {
    const fit = fitRoomCards(cells, box, GAP);
    cardWidth = fit.width;
    cardHeight = fit.height;
  }
  // Unmeasured (the first paint, a test without layout): the plain grid.
  const sized = box.width > 0 && cardWidth > 0;
  const cell: CSSProperties | undefined = sized
    ? { width: cardWidth, height: cardHeight }
    : undefined;
  const alone = !strip && people.length === 1 && people[0]?.isSelf === true;
  const firstCamera = shown.find(
    (person) => person.camera === true && renderCamera,
  )?.key;
  const cards = (
    <ul
      aria-label={t("voice.room.label")}
      className={cn(
        "flex w-full flex-wrap justify-center",
        strip
          ? cn("shrink-0", showAll && "max-h-[50%] overflow-y-auto")
          : showAll
            ? "content-start"
            : "h-full content-center",
      )}
      style={{
        gap: GAP,
        ...(sized
          ? {}
          : {
              display: "grid",
              gridTemplateColumns: `repeat(${plan.columns}, minmax(0, 1fr))`,
            }),
      }}
    >
      {shown.map((person) =>
        person.camera && renderCamera ? (
          renderCamera(person, cell, RESIZE, person.key === firstCamera)
        ) : (
          <RoomCard
            key={person.key}
            person={person}
            youLabel={youLabel}
            style={cell}
            compact={strip}
          />
        ),
      )}
      {overflow > 0 && (
        <li className={cn("min-h-0 min-w-0", RESIZE)} style={cell}>
          <button
            type="button"
            data-testid="room-cards-more"
            aria-label={t("voice.room.more", { count: overflow })}
            onClick={() => setShowAll(true)}
            className={cn(
              "flex h-full w-full items-center justify-center rounded-[var(--call-tile-radius)] bg-[color:var(--call-tile-bg)] font-semibold tabular-nums text-text-secondary transition-colors duration-[var(--duration-fast)] hover:text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--color-focus-ring)] motion-reduce:transition-none",
              strip ? "text-lg" : "text-2xl",
            )}
          >
            +{overflow}
          </button>
        </li>
      )}
      {showAll && (
        <li className="min-h-0 min-w-0" style={cell}>
          <button
            type="button"
            data-testid="room-cards-less"
            onClick={() => setShowAll(false)}
            className="flex h-full w-full items-center justify-center rounded-[var(--call-tile-radius)] border border-dashed border-[color:var(--card-border)] text-sm text-text-secondary hover:text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--color-focus-ring)]"
          >
            {t("voice.room.less")}
          </button>
        </li>
      )}
      {alone && <AloneCard style={cell} />}
    </ul>
  );
  return (
    <div
      ref={rootRef}
      data-testid="stage-room-cards"
      data-room-layout={strip ? "share" : "grid"}
      className={cn(
        "h-full w-full",
        strip ? "flex flex-col" : showAll && "overflow-y-auto",
      )}
      // Each side on its own: a `padding` shorthand beside `paddingTop` is
      // re-applied on update and wipes the banner offset.
      style={{
        paddingTop: PAD + banners,
        paddingRight: PAD,
        paddingBottom: PAD,
        paddingLeft: PAD,
        gap: GAP,
      }}
    >
      {strip && (
        <div data-testid="room-cards-stage" className="relative min-h-0 flex-1">
          {stage}
        </div>
      )}
      {cards}
    </div>
  );
}

function RoomCard({
  person,
  youLabel,
  style,
  compact = false,
}: {
  person: RoomCardEntry;
  youLabel: string;
  style?: CSSProperties;
  /** In the row under a share: a smaller badge. */
  compact?: boolean;
}) {
  const { t } = useTranslation();
  const menu = usePeerAudioMenu<HTMLLIElement>();
  const actionable = Boolean(person.audio || (person.failed && person.onRetry));
  const silent = person.muted || person.deafened || person.serverMuted;
  const face = (
    <>
      <span
        className={cn(
          "aspect-square h-[42%] max-h-28 min-h-10 rounded-full transition-shadow duration-[var(--duration-fast)] motion-reduce:transition-none",
          person.speaking && "shadow-[var(--shadow-speaking)]",
        )}
      >
        <UserAvatar
          name={person.name}
          avatarUrl={person.avatarUrl}
          className="h-full w-full text-[clamp(0.875rem,8cqw,2.5rem)]"
          rounded="full"
          tint={person.userId ?? person.key}
          dimmed={silent}
        />
      </span>
      <RoomCardBadge person={person} youLabel={youLabel} compact={compact} />
    </>
  );
  const cardClass = cn(
    "@container relative flex h-full w-full flex-col items-center justify-center overflow-hidden rounded-[var(--call-tile-radius)] bg-[color:var(--call-tile-bg)] ring-2 ring-inset ring-transparent transition-shadow duration-[var(--duration-fast)] motion-reduce:transition-none",
    person.speaking && "ring-[color:var(--call-speaking)]",
  );
  return (
    <li
      ref={menu.rootRef}
      data-call-listener={person.name}
      data-speaking={person.speaking ? "" : undefined}
      className={cn("relative min-h-0 min-w-0", RESIZE)}
      style={style}
    >
      <SoundboardFloat userId={person.userId} />
      {actionable ? (
        <button
          type="button"
          aria-haspopup="dialog"
          aria-expanded={menu.open}
          aria-label={t("voice.audio.title", { name: person.name })}
          onClick={menu.toggle}
          className={cn(
            cardClass,
            "hover:bg-[color:var(--call-control-hover)] focus-visible:outline-none focus-visible:ring-[color:var(--color-focus-ring)]",
          )}
        >
          {face}
        </button>
      ) : (
        <div className={cardClass}>{face}</div>
      )}
      {person.failed && person.onRetry && (
        <Button
          variant="secondary"
          size="sm"
          className="absolute right-2 top-2"
          onClick={person.onRetry}
        >
          {t("voice.tile.retry")}
        </Button>
      )}
      <PeerAudioMenu
        name={person.name}
        open={menu.open}
        voice={person.audio?.voice}
        share={person.audio?.share}
        soundboardUserId={person.audio?.soundboardUserId}
        failed={person.failed}
        onRetry={person.onRetry}
        // Portalled: the stage and the card row hide their overflow, so a
        // panel nested in the card was cut off (the row under a share sits at
        // the stage's bottom edge). From that row it opens upward.
        side={compact ? "top" : "bottom"}
        anchorRef={menu.rootRef}
        panelRef={menu.panelRef}
        onClose={menu.close}
      />
    </li>
  );
}

/**
 * Name and state along the card's bottom edge, in the picture tiles' glass
 * pill so a card and a camera read as the same thing. One state glyph at most:
 * no sound wins over muted (a person who cannot hear is muted too, and the
 * sidebar draws it the same way), and a moderator's mute has its own glyph.
 */
function RoomCardBadge({
  person,
  youLabel,
  compact = false,
}: {
  person: RoomCardEntry;
  youLabel: string;
  compact?: boolean;
}) {
  const { t } = useTranslation();
  return (
    <span
      className={cn(
        "absolute flex items-center gap-1 truncate rounded-full bg-[color:var(--call-badge-bg)] font-medium text-[color:var(--call-badge-text)] backdrop-blur-sm",
        compact
          ? "bottom-1 left-1 max-w-[calc(100%-0.5rem)] px-1.5 py-0.5 text-[11px]"
          : "bottom-2 left-2 max-w-[calc(100%-1rem)] px-2.5 py-1 text-xs",
      )}
    >
      {person.serverMuted ? (
        <Icon
          icon={ShieldSlash}
          kind="symbol"
          size="sm"
          className="text-warning"
          label={t("voice.tile.serverMuted", { name: person.name })}
        />
      ) : person.deafened ? (
        <Icon
          icon={EarSlash}
          kind="symbol"
          size="sm"
          className="text-danger"
          label={t("chrome.deafened")}
        />
      ) : person.muted ? (
        <Icon
          icon={MicrophoneSlash}
          kind="symbol"
          size="sm"
          className="text-danger"
          label={t("chrome.muted")}
        />
      ) : null}
      {person.handPosition !== null && (
        <span
          className="flex items-center gap-0.5 text-warning"
          aria-label={t("voice.room.hand", { position: person.handPosition })}
        >
          <Icon icon={HandPalm} kind="object" size="sm" />
          <span className="tabular-nums">{person.handPosition}</span>
        </span>
      )}
      <span className="truncate">
        {person.isSelf ? `${person.name} ${youLabel}` : person.name}
      </span>
      {person.connecting && !person.isSelf && (
        <Icon
          icon={SpinnerGap}
          kind="symbol"
          size="sm"
          className="animate-spin motion-reduce:animate-none"
          label={t("voice.tile.connecting")}
        />
      )}
    </span>
  );
}

/**
 * Alone in the room: what to do next, instead of an empty half of the grid.
 * The invite copies the same seven-day link the "Chama mais 2" hint does, and
 * only for somebody who may create one (`CREATE_INVITE`, checked again by the
 * API). The music button opens the queue, the thing a room does while it waits.
 */
function AloneCard({ style }: { style?: CSSProperties }) {
  const { t, locale } = useTranslation();
  const { serverId, canCreateInvite } = useBringFriendsServer();
  const [state, setState] = useState<"idle" | "busy" | "copied" | "failed">(
    "idle",
  );
  const timer = useRef<number | null>(null);
  useEffect(
    () => () => {
      if (timer.current !== null) {
        window.clearTimeout(timer.current);
      }
    },
    [],
  );
  const canInvite = Boolean(serverId) && canCreateInvite;

  async function copyInvite() {
    if (!serverId || state === "busy") {
      return;
    }
    setState("busy");
    try {
      await copyInvitePaste({ serverId, locale });
      setState("copied");
      if (timer.current !== null) {
        window.clearTimeout(timer.current);
      }
      timer.current = window.setTimeout(() => setState("idle"), COPY_MS);
    } catch {
      setState("failed");
    }
  }

  return (
    <li
      data-testid="room-cards-alone"
      style={style}
      className="flex min-h-0 min-w-0 flex-col items-center justify-center gap-3 rounded-[var(--call-tile-radius)] border border-dashed border-[color:var(--card-border)] p-4 text-center"
    >
      <p className="text-sm font-semibold text-text">
        {t("voice.room.alone.title")}
      </p>
      <p className="max-w-xs text-xs text-text-secondary" role="status">
        {state === "failed"
          ? t("invite.hint.bringFriends.failed")
          : t(
              canInvite
                ? "voice.room.alone.body"
                : "voice.room.alone.bodyNoInvite",
            )}
      </p>
      <div className="flex flex-wrap items-center justify-center gap-2">
        {canInvite && (
          <Button
            size="sm"
            data-testid="room-cards-invite"
            disabled={state === "busy"}
            onClick={() => void copyInvite()}
          >
            <Icon icon={LinkSimple} kind="symbol" size="sm" />
            {state === "copied"
              ? t("invite.paste.copied")
              : t("invite.hint.bringFriends.cta")}
          </Button>
        )}
        <Button
          size="sm"
          variant="secondary"
          data-testid="room-cards-music"
          onClick={() => setMusicOpen(true)}
        >
          <Icon icon={MusicNotes} kind="object" size="sm" />
          {t("music.open")}
        </Button>
      </div>
    </li>
  );
}

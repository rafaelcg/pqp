import {
  LayoutGrid,
  Music,
  Clapperboard,
  Monitor,
  MessagesSquare,
  Users,
  ShieldCheck,
  TriangleAlert,
  X,
  RefreshCw,
  type LucideIcon,
} from "lucide-react";
import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import type { AppSessionSummary } from "@pqp/shared";
import { AppIconTile, appIconFor } from "@/components/apps/app-icon";
import { Avatars, countText } from "@/components/apps/app-session-card";
import { Button } from "@/components/ui/button";
import { Tooltip } from "@/components/ui/tooltip";
import { useAppsConfig, loadAppsConfig } from "@/hooks/use-apps-config";
import { useSmUp } from "@/hooks/use-sm-up";
import { AppStartError, startAppSessionRequest } from "@/lib/apps/api";
import {
  applyChannelApp,
  focusAppPane,
  isSeated,
  liveAppSession,
  requestAppJoin,
  useAppSessions,
} from "@/lib/apps/app-sessions-store";
import { appText, CARD_AVATARS_SHOWN, type CardPerson } from "@/lib/apps/card-model";
import {
  buildLauncherTiles,
  initialSelection,
  moveSelection,
  type AppTile,
  type BuiltInTile,
  type LauncherChannelType,
  type LauncherTile,
  type TileReason,
  type TileSize,
} from "@/lib/apps/launcher-model";
import { useTranslation, type MessageKey } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import { SHEET_SURFACE } from "@/components/ui/sheet";

/**
 * The apps button in the composer and the panel it opens (mock 01).
 *
 * A popover on a desktop, a sheet with a scrim on a phone. The grid is one
 * listbox with a roving tab stop (arrows move the selection, Tab leaves the
 * list), the detail on the right says what the selected app is, and the footer
 * holds the one primary action. A tile that cannot be used here stays on screen
 * with its reason written under the name.
 *
 * Starting is the only thing that talks to the server, and it never closes the
 * panel by itself while it waits: a failure is read inside the panel, in an
 * alert, with focus on the button that retries.
 */

/** Past this a start that has not answered is a failure, not a spinner for ever. */
export const APP_START_TIMEOUT_MS = 8_000;

/**
 * One start request per channel, shared by every press and every panel. A
 * request that outlives the eight seconds is not abandoned and not repeated:
 * "Tentar de novo" attaches to the same request, so a stalled API never gets a
 * second one on top. The answer is adopted here, once, whoever is still
 * looking: the store gets the session and the starter joins it, so a late
 * success can never leave a session started and un-joined.
 */
interface StartInFlight {
  appId: string;
  promise: Promise<AppSessionSummary>;
}
const startsInFlight = new Map<string, StartInFlight>();

function startOnce(channelId: string, appId: string): StartInFlight {
  const existing = startsInFlight.get(channelId);
  if (existing) {
    return existing;
  }
  const promise = startAppSessionRequest(channelId, appId).then(
    (session) => {
      // The card and the strip read the store; put the answer there before
      // anything else so they never wait for the frame. The starter is host
      // and is not seated: join straight away.
      applyChannelApp(channelId, session);
      requestAppJoin(session.id);
      return session;
    },
    (error: unknown) => {
      if (error instanceof AppStartError && error.code === "session_live" && error.session) {
        // Somebody else got there first: the store learns of their session.
        applyChannelApp(channelId, error.session);
      }
      throw error;
    },
  );
  const entry: StartInFlight = { appId, promise };
  startsInFlight.set(channelId, entry);
  const done = () => {
    if (startsInFlight.get(channelId) === entry) {
      startsInFlight.delete(channelId);
    }
  };
  promise.then(done, done);
  return entry;
}

/** Test seam: forget any request still in flight. */
export function resetAppStartsForTests() {
  startsInFlight.clear();
}

const PANEL_WIDTH = 620;
const GRID_COLUMNS = 3;

export interface AppLauncherBuiltIns {
  /** Música: opens the queue sheet. Present when the music queue exists in this build. */
  music?: { inCallHere: boolean; open: () => void } | null;
  /** Watch party: open the server's channel for it, or create one. */
  watchParty?: { label: "open" | "create"; run: () => void } | null;
}

export interface AppLauncherProps {
  serverId: string;
  channelId: string;
  channelName: string;
  channelType: LauncherChannelType;
  viewerId: string | null;
  /** Holds USE_APPS in this channel. */
  canStart: boolean;
  /** Holds MANAGE_CHANNELS in this channel (an app's `requires.start` may ask for it). */
  canManageChannels?: boolean;
  /** Holds MANAGE_SERVER: the one person the empty panel is for. */
  canManageServer: boolean;
  builtIns?: AppLauncherBuiltIns;
  /** Names and pictures of the people on a running app's line. */
  people?: ReadonlyMap<
    string,
    { displayName?: string | null; username?: string | null; avatarUrl?: string | null }
  >;
  /** The empty panel's "Pedir acesso". Absent hides the button. */
  onRequestAccess?: () => void;
  disabled?: boolean;
  /** The composer's own icon-button look, so the button sits with its neighbours. */
  buttonClassName?: string;
  /** Moves the composer's other popups out of the way when this one opens. */
  onOpenChange?: (open: boolean) => void;
}

type StartState =
  | { status: "idle" }
  | { status: "starting"; appId: string }
  | { status: "failed"; appId: string; code: "failed" | "permission" | "rate-limited" };

export function AppLauncher({
  serverId,
  channelId,
  channelName,
  channelType,
  viewerId,
  canStart,
  canManageChannels = false,
  canManageServer,
  builtIns,
  people,
  onRequestAccess,
  disabled = false,
  buttonClassName,
  onOpenChange,
}: AppLauncherProps) {
  const { t, locale } = useTranslation();
  const config = useAppsConfig(serverId);
  const live = useAppSessions((state) => liveAppSession(state, channelId));
  const online = useAppSessions((state) => state.online);
  const [open, setOpenState] = useState(false);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const smUp = useSmUp();
  const panelId = useId();

  const setOpen = useCallback(
    (next: boolean) => {
      setOpenState(next);
      onOpenChange?.(next);
    },
    [onOpenChange],
  );

  const hasApps = config.apps.length > 0;
  // Nothing at all while the platform is off for the server (or has not
  // answered). With apps released, everyone sees the button, because an app
  // running here turns it into Entrar for everyone; with none released only
  // the person who can ask for them does.
  if (!config.enabled || (!hasApps && !canManageServer)) {
    return null;
  }

  const running = Boolean(live);
  return (
    <div className="relative">
      <Tooltip label={t("apps.name")}>
        <Button
          ref={buttonRef}
          type="button"
          variant="ghost"
          size="icon"
          disabled={disabled}
          aria-label={t("apps.name")}
          aria-haspopup="dialog"
          aria-expanded={open}
          aria-controls={open ? panelId : undefined}
          data-testid="apps-button"
          onClick={() => setOpen(!open)}
          onMouseDown={(event) => event.preventDefault()}
          className={cn(buttonClassName, open && "bg-surface-3 text-text")}
        >
          <LayoutGrid className="h-4.5 w-4.5" />
          {running ? (
            <span
              aria-hidden
              className="absolute right-1 top-1 h-2 w-2 rounded-full bg-accent ring-2 ring-surface-1"
            />
          ) : null}
        </Button>
      </Tooltip>
      {open ? (
        <LauncherPanel
          id={panelId}
          modal={!smUp}
          anchor={buttonRef}
          serverId={serverId}
          channelId={channelId}
          channelName={channelName}
          channelType={channelType}
          viewerId={viewerId}
          canStart={canStart}
          canManageChannels={canManageChannels}
          apps={config.apps}
          builtIns={builtIns}
          people={people}
          online={online}
          locale={locale}
          onRequestAccess={onRequestAccess}
          onClose={() => {
            setOpen(false);
            buttonRef.current?.focus();
          }}
        />
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------

interface PanelProps {
  id: string;
  modal: boolean;
  anchor: React.RefObject<HTMLButtonElement | null>;
  serverId: string;
  channelId: string;
  channelName: string;
  channelType: LauncherChannelType;
  viewerId: string | null;
  canStart: boolean;
  canManageChannels: boolean;
  apps: ReturnType<typeof useAppsConfig>["apps"];
  builtIns?: AppLauncherBuiltIns;
  people?: AppLauncherProps["people"];
  online: boolean;
  locale: string;
  onRequestAccess?: () => void;
  onClose: () => void;
}

function LauncherPanel(props: PanelProps) {
  const { t } = useTranslation();
  const {
    modal,
    channelId,
    channelName,
    channelType,
    viewerId,
    canStart,
    canManageChannels,
    apps,
    builtIns,
    people,
    online,
    locale,
    onRequestAccess,
    onClose,
  } = props;
  const live = useAppSessions((state) => liveAppSession(state, channelId));
  const panelRef = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const [startState, setStartState] = useState<StartState>({ status: "idle" });
  const attached = useRef<Promise<AppSessionSummary> | null>(null);
  const unmounted = useRef(false);
  const startTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const tiles = useMemo(
    () =>
      buildLauncherTiles({
        apps,
        channelType,
        locale,
        live,
        inCallHere: builtIns?.music?.inCallHere ?? false,
        watchPartyAvailable: Boolean(builtIns?.watchParty),
        canManageChannels,
      }).filter((tile) => tile.kind !== "builtin" || tile.id !== "music" || builtIns?.music),
    [apps, channelType, locale, live, builtIns, canManageChannels],
  );
  const [selectedId, setSelectedId] = useState<string | null>(() =>
    initialSelection(tiles),
  );
  const selected = tiles.find((tile) => tile.id === selectedId) ?? tiles[0] ?? null;
  const tileRefs = useRef(new Map<string, HTMLButtonElement>());
  const startButtonRef = useRef<HTMLButtonElement>(null);

  // The panel keeps its place when a session starts or ends under it.
  useEffect(() => {
    if (!selectedId || !tiles.some((tile) => tile.id === selectedId)) {
      setSelectedId(initialSelection(tiles));
    }
  }, [tiles, selectedId]);

  // On open, focus goes to the selected tile.
  useEffect(() => {
    const first = selectedId ? tileRefs.current.get(selectedId) : null;
    (first ?? panelRef.current)?.focus();
    // Only on open.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    unmounted.current = false;
    return () => {
      unmounted.current = true;
      if (startTimer.current) {
        clearTimeout(startTimer.current);
      }
    };
  }, []);

  // Esc closes, and a click outside does, except while a start is waiting.
  const starting = startState.status === "starting";
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        onClose();
      }
    };
    const onPointer = (event: PointerEvent) => {
      if (modal || starting) {
        return;
      }
      const target = event.target as Node | null;
      if (
        target &&
        !panelRef.current?.contains(target) &&
        !props.anchor.current?.contains(target)
      ) {
        onClose();
      }
    };
    document.addEventListener("keydown", onKey, true);
    document.addEventListener("pointerdown", onPointer, true);
    return () => {
      document.removeEventListener("keydown", onKey, true);
      document.removeEventListener("pointerdown", onPointer, true);
    };
  }, [modal, starting, onClose, props.anchor]);

  const start = useCallback(
    (tile: AppTile) => {
      // A request already in flight for this channel (a retry after the eight
      // seconds) is the one this press waits for: nothing second is sent.
      const request = startOnce(channelId, tile.id);
      if (request.appId !== tile.id) {
        // Another app's start is still pending here. It is not this press's
        // request, so it is never silently taken for it: the selection moves
        // to the app that is actually starting and the panel says so.
        setSelectedId(request.appId);
      }
      setStartState({ status: "starting", appId: request.appId });
      if (startTimer.current) {
        clearTimeout(startTimer.current);
      }
      startTimer.current = setTimeout(() => {
        setStartState({ status: "failed", appId: request.appId, code: "failed" });
      }, APP_START_TIMEOUT_MS);
      if (attached.current === request.promise) {
        return;
      }
      attached.current = request.promise;
      const settled = () => {
        if (attached.current !== request.promise) {
          return false;
        }
        attached.current = null;
        if (startTimer.current) {
          clearTimeout(startTimer.current);
        }
        return !unmounted.current;
      };
      request.promise.then(
        () => {
          if (settled()) {
            setStartState({ status: "idle" });
            onClose();
          }
        },
        (error: unknown) => {
          if (!settled()) {
            return;
          }
          if (error instanceof AppStartError && error.code === "session_live") {
            // The panel turns into "já tem um app".
            setStartState({ status: "idle" });
            return;
          }
          const code =
            error instanceof AppStartError
              ? error.code === "cannot_start"
                ? "permission"
                : error.code === "rate_limited"
                  ? "rate-limited"
                  : "failed"
              : "failed";
          setStartState({ status: "failed", appId: request.appId, code });
        },
      );
    },
    [channelId, onClose, setSelectedId],
  );

  // A failure puts focus back on the button that retries.
  useEffect(() => {
    if (startState.status === "failed") {
      startButtonRef.current?.focus();
    }
  }, [startState.status]);

  const onTileKey = (event: ReactKeyboardEvent<HTMLButtonElement>, index: number) => {
    if (event.key === "Enter") {
      event.preventDefault();
      startButtonRef.current?.focus();
      return;
    }
    const next = moveSelection(index, tiles.length, event.key, modal ? 1 : GRID_COLUMNS);
    if (next === index || next < 0) {
      return;
    }
    event.preventDefault();
    const tile = tiles[next]!;
    setSelectedId(tile.id);
    tileRefs.current.get(tile.id)?.focus();
  };

  // The phone sheet is modal: keep Tab inside it.
  const onPanelKey = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (!modal || event.key !== "Tab") {
      return;
    }
    const focusable = Array.from(
      panelRef.current?.querySelectorAll<HTMLElement>(
        'button:not([disabled]), [tabindex="0"]',
      ) ?? [],
    );
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
  };

  // Above the whole composer, level with its left edge (the mock puts the
  // popover 16px in from the pane and above the field, not above the button).
  const [placement, setPlacement] = useState<{
    left: number;
    bottom: number;
    width: number;
  } | null>(null);
  useLayoutEffect(() => {
    if (modal) {
      return;
    }
    const place = () => {
      const button = props.anchor.current;
      const form = button?.closest("form");
      if (!button || !form) {
        return;
      }
      const b = button.getBoundingClientRect();
      const f = form.getBoundingClientRect();
      setPlacement({
        left: f.left - b.left,
        bottom: b.top - f.top + 8,
        width: Math.min(PANEL_WIDTH, Math.max(280, f.width)),
      });
    };
    place();
    window.addEventListener("resize", place);
    return () => window.removeEventListener("resize", place);
  }, [modal, props.anchor]);

  const empty = apps.length === 0;
  const body = empty ? (
    <EmptyBody onRequestAccess={onRequestAccess} />
  ) : !online ? (
    <OfflineBody serverId={props.serverId} />
  ) : (
    <div className={cn("flex min-h-0 flex-1", modal ? "flex-col" : "flex-row")}>
      <div
        role="listbox"
        aria-label={t("apps.launcher.listLabel")}
        aria-orientation={modal ? "vertical" : undefined}
        className={cn(
          "grid gap-2 p-3",
          modal ? "grid-cols-1" : "w-[340px] shrink-0 grid-cols-3 content-start",
        )}
      >
        {tiles.map((tile, index) => (
          <TileButton
            key={tile.id}
            tile={tile}
            selected={tile.id === selected?.id}
            tabStop={tile.id === selected?.id}
            modal={modal}
            locale={locale}
            registerRef={(node) => {
              if (node) {
                tileRefs.current.set(tile.id, node);
              } else {
                tileRefs.current.delete(tile.id);
              }
            }}
            onSelect={() => setSelectedId(tile.id)}
            onKeyDown={(event) => onTileKey(event, index)}
          />
        ))}
      </div>
      <div
        className={cn(
          "flex min-w-0 flex-1 flex-col gap-3 p-4",
          modal ? "border-t border-border" : "border-l border-border",
        )}
        data-testid="apps-detail"
      >
        {selected ? (
          <Detail
            tile={selected}
            locale={locale}
            live={live}
            people={people}
          />
        ) : null}
      </div>
    </div>
  );

  const footer =
    empty || !online || !selected ? null : (
      <Footer
        tile={selected}
        live={live}
        canStart={canStart}
        viewerId={viewerId}
        startState={startState}
        startButtonRef={startButtonRef}
        builtIns={builtIns}
        onStart={(tile) => void start(tile)}
        onClose={onClose}
      />
    );

  return (
    <>
      {modal ? (
        <div
          aria-hidden
          className="fixed inset-0 z-40 bg-black/50 app-scrim"
          onClick={() => {
            if (!starting) {
              onClose();
            }
          }}
        />
      ) : null}
      <div
        ref={panelRef}
        id={props.id}
        role="dialog"
        aria-modal={modal || undefined}
        aria-labelledby={titleId}
        tabIndex={-1}
        onKeyDown={onPanelKey}
        data-testid="apps-launcher"
        className={cn(
          "app-launcher-panel z-50 flex flex-col overflow-hidden border border-border-strong bg-surface-1 shadow-[var(--shadow-2)] focus:outline-none",
          modal
            ? cn(
                // The old radius is the toggle-off look; SHEET_SURFACE's wins under the redesign.
                "app-launcher-sheet fixed inset-x-0 bottom-0 max-h-[88dvh] rounded-t-[var(--radius-panel)] pb-[env(safe-area-inset-bottom)]",
                SHEET_SURFACE,
              )
            : "absolute max-h-[min(70dvh,560px)] rounded-[12px]",
        )}
        style={
          modal || !placement
            ? undefined
            : {
                left: placement.left,
                bottom: `calc(100% + ${placement.bottom}px)`,
                width: placement.width,
              }
        }
      >
        <header className="flex items-center gap-2 border-b border-border px-4 py-3">
          <h2
            id={titleId}
            className="font-display text-sm font-bold leading-5 text-text"
          >
            {t("apps.name")}
          </h2>
          <span
            className="min-w-0 flex-1 truncate text-xs text-text-tertiary"
            title={`#${channelName}`}
          >
            #{channelName}
          </span>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            aria-label={t("apps.launcher.close")}
            className="-mr-2 h-8 w-8"
            onClick={onClose}
          >
            <X className="h-4 w-4" aria-hidden />
          </Button>
        </header>
        <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">{body}</div>
        {footer}
      </div>
    </>
  );
}

// ---------------------------------------------------------------------------

function sizeText(
  size: TileSize,
  t: (key: MessageKey, vars?: Record<string, string | number>) => string,
): string {
  switch (size.kind) {
    case "any":
      return t("apps.launcher.anySize");
    case "exact":
      return t(size.people ? "apps.launcher.peopleExact" : "apps.launcher.playersExact", {
        count: size.count,
      });
    case "range":
      return t(size.people ? "apps.launcher.peopleRange" : "apps.launcher.playersRange", {
        min: size.min,
        max: size.max,
        count: size.max,
      });
  }
}

function reasonText(
  reason: TileReason,
  t: (key: MessageKey) => string,
): string {
  switch (reason) {
    case "voice-only":
      return t("apps.launcher.reason.voiceOnly");
    case "text-only":
      return t("apps.launcher.reason.textOnly");
    case "community":
      return t("apps.launcher.reason.community");
    case "join-call":
      return t("apps.launcher.reason.joinCall");
    case "needs-manage":
      return t("apps.launcher.reason.needsManage");
    case "unavailable":
      return t("apps.launcher.reason.unavailable");
    default:
      return t("apps.launcher.reason.off");
  }
}

const BUILTIN_ICON: Record<BuiltInTile["id"], LucideIcon> = {
  music: Music,
  "watch-party": Clapperboard,
};

function tileName(tile: LauncherTile, t: (key: MessageKey) => string): string {
  if (tile.kind === "app") {
    return tile.name;
  }
  return tile.id === "music" ? t("apps.launcher.music.name") : t("apps.launcher.watchParty.name");
}

function TileButton({
  tile,
  selected,
  tabStop,
  modal,
  registerRef,
  onSelect,
  onKeyDown,
}: {
  tile: LauncherTile;
  selected: boolean;
  tabStop: boolean;
  modal: boolean;
  locale: string;
  registerRef: (node: HTMLButtonElement | null) => void;
  onSelect: () => void;
  onKeyDown: (event: ReactKeyboardEvent<HTMLButtonElement>) => void;
}) {
  const { t } = useTranslation();
  const name = tileName(tile, t);
  const dim = tile.reason !== null;
  const sub = tile.reason
    ? reasonText(tile.reason, t)
    : tile.kind === "app"
      ? tile.running
        ? t("apps.launcher.running")
        : sizeText(tile.size, t)
      : t("apps.launcher.shortcut");
  const Icon = tile.kind === "app" ? appIconFor(tile.icon) : BUILTIN_ICON[tile.id];
  return (
    <button
      ref={registerRef}
      type="button"
      role="option"
      aria-selected={selected}
      aria-disabled={dim || undefined}
      tabIndex={tabStop ? 0 : -1}
      data-tile={tile.id}
      onClick={onSelect}
      onKeyDown={onKeyDown}
      className={cn(
        "flex min-h-[104px] flex-col items-start gap-2 rounded-[var(--radius-card)] border p-3 text-left transition-colors duration-100",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-offset-ring-offset focus-visible:ring-focus-ring",
        modal && "min-h-[64px] flex-row items-center gap-3",
        selected
          ? "border-accent bg-accent-soft text-on-accent-soft"
          : "border-border bg-surface-2 text-text hover:bg-surface-3",
        dim && !selected && "text-text-tertiary",
      )}
    >
      <span
        aria-hidden
        className={cn(
          "flex h-10 w-10 shrink-0 items-center justify-center rounded-[var(--radius-control)]",
          dim ? "bg-surface-3 text-text-tertiary" : "bg-accent-soft text-on-accent-soft",
        )}
      >
        <Icon className="h-5 w-5" />
      </span>
      <span className="min-w-0">
        <span className="line-clamp-2 block text-[13px] font-semibold leading-4">{name}</span>
        <span
          className={cn(
            "mt-0.5 line-clamp-2 block text-[11px] leading-4",
            selected ? "text-on-accent-soft" : "text-text-tertiary",
          )}
        >
          {sub}
        </span>
      </span>
    </button>
  );
}

function Fact({ icon: Icon, children }: { icon: LucideIcon; children: React.ReactNode }) {
  return (
    <li className="flex items-start gap-2 text-xs leading-4 text-text-secondary">
      <Icon aria-hidden className="mt-px h-4 w-4 shrink-0 text-text-tertiary" />
      <span>{children}</span>
    </li>
  );
}

function Detail({
  tile,
  locale,
  live,
  people,
}: {
  tile: LauncherTile;
  locale: string;
  live: ReturnType<typeof liveAppSession>;
  people?: AppLauncherProps["people"];
}) {
  const { t } = useTranslation();
  const title = tileName(tile, t);
  const Icon = tile.kind === "app" ? appIconFor(tile.icon) : BUILTIN_ICON[tile.id];

  if (tile.kind === "builtin") {
    return (
      <>
        <div className="flex items-center gap-3">
          <span
            aria-hidden
            className="flex h-10 w-10 items-center justify-center rounded-[var(--radius-control)] bg-accent-soft text-on-accent-soft"
          >
            <Icon className="h-5 w-5" />
          </span>
          <h3 className="font-display text-lg font-bold leading-6 text-text">{title}</h3>
        </div>
        <p className="text-[13px] leading-5 text-text-secondary">
          {t(
            tile.id === "music"
              ? "apps.launcher.music.description"
              : "apps.launcher.watchParty.description",
          )}
        </p>
        {tile.reason ? (
          <p role="status" className="text-xs leading-4 text-text-tertiary">
            {reasonText(tile.reason, t)}
          </p>
        ) : null}
      </>
    );
  }

  const { app } = tile;
  const runningHere = live && live.appId === app.id ? live : null;
  const startedBy = runningHere?.startedBy
    ? (people?.get(runningHere.startedBy)?.displayName ?? "?")
    : "?";
  const cardPeople: CardPerson[] = runningHere
    ? runningHere.participants.slice(0, CARD_AVATARS_SHOWN).map((one) => ({
        userId: one.userId,
        displayName: people?.get(one.userId)?.displayName ?? "?",
        avatarUrl: people?.get(one.userId)?.avatarUrl ?? null,
      }))
    : [];
  const spectators = app.players.spectators;
  const range = sizeText(tile.size, t);
  const where = app.channelTypes.length === 2 ? "both" : app.channelTypes[0] === "voice" ? "voice" : "text";
  const notice = app.notice ? appText(app, locale, app.notice) : null;

  return (
    <>
      <div className="flex items-center gap-3">
        <AppIconTile icon={app.icon} />
        <h3 className="font-display text-lg font-bold leading-6 text-text">{title}</h3>
      </div>
      {runningHere ? (
        <div
          role="status"
          className="flex flex-col gap-2 rounded-[var(--radius-card)] bg-surface-2 p-3 text-xs leading-4 text-text-secondary"
        >
          <p>{t("apps.launcher.runningHere", { name: startedBy })}</p>
          <div className="flex items-center gap-2">
            <Avatars
              people={cardPeople}
              more={Math.max(0, runningHere.participants.length - CARD_AVATARS_SHOWN)}
              ended={false}
            />
            <span>
              {countText(
                runningHere.players >= app.players.max
                  ? {
                      kind: "full",
                      players: runningHere.players,
                      max: app.players.max,
                      watching: runningHere.spectators,
                    }
                  : runningHere.players === 0
                    ? { kind: "none" }
                    : { kind: "of", players: runningHere.players, max: app.players.max },
                t,
              )}
            </span>
          </div>
        </div>
      ) : (
        <>
          <p className="text-[13px] leading-5 text-text-secondary">
            {appText(app, locale, app.description)}
          </p>
          <ul className="flex flex-col gap-1.5">
            <Fact icon={Users}>
              {spectators ? t("apps.launcher.factPlayersWatch", { range }) : range}
            </Fact>
            <Fact icon={MessagesSquare}>{t(`apps.launcher.where.${where}` as MessageKey)}</Fact>
            {app.capabilities.share === "pane" && app.shareAllowed ? (
              <Fact icon={Monitor}>{t("apps.launcher.factShare")}</Fact>
            ) : null}
            {notice ? <Fact icon={ShieldCheck}>{notice}</Fact> : null}
          </ul>
          {tile.reason ? (
            <p role="status" className="text-xs leading-4 text-text-tertiary">
              {reasonText(tile.reason, t)}
            </p>
          ) : null}
        </>
      )}
    </>
  );
}

function Footer({
  tile,
  live,
  canStart,
  viewerId,
  startState,
  startButtonRef,
  builtIns,
  onStart,
  onClose,
}: {
  tile: LauncherTile;
  live: ReturnType<typeof liveAppSession>;
  canStart: boolean;
  viewerId: string | null;
  startState: StartState;
  startButtonRef: React.RefObject<HTMLButtonElement | null>;
  builtIns?: AppLauncherBuiltIns;
  onStart: (tile: AppTile) => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const starting = startState.status === "starting";
  const failed = startState.status === "failed" ? startState : null;

  if (tile.kind === "builtin") {
    const disabled = tile.reason !== null;
    const label =
      tile.id === "music"
        ? t("apps.launcher.music.open")
        : builtIns?.watchParty?.label === "create"
          ? t("apps.launcher.watchParty.create")
          : t("apps.launcher.watchParty.open");
    return (
      <footer className="flex items-center justify-end gap-3 border-t border-border px-4 py-3">
        <Button
          ref={startButtonRef}
          type="button"
          aria-disabled={disabled || undefined}
          className="h-11 min-w-[120px] sm:h-9 aria-disabled:cursor-not-allowed aria-disabled:opacity-60"
          onClick={() => {
            if (disabled) {
              return;
            }
            onClose();
            if (tile.id === "music") {
              builtIns?.music?.open();
            } else {
              builtIns?.watchParty?.run();
            }
          }}
        >
          {label}
        </Button>
      </footer>
    );
  }

  const runningHere = live && live.appId === tile.id ? live : null;

  // An app is already running in this channel: the primary button joins it,
  // and any other app waits (one app per channel).
  if (runningHere) {
    const inside = isSeated(runningHere, viewerId);
    return (
      <footer className="flex flex-wrap items-center justify-between gap-3 border-t border-border px-4 py-3">
        <p role="status" className="min-w-0 flex-1 basis-[200px] text-xs leading-4 text-text-tertiary">
          {t("apps.launcher.onePerChannel")}
        </p>
        <Button
          ref={startButtonRef}
          type="button"
          className="h-12 w-full sm:h-9 sm:w-auto sm:min-w-[120px]"
          onClick={() => {
            onClose();
            if (inside) {
              focusAppPane(runningHere.id);
            } else {
              requestAppJoin(runningHere.id);
            }
          }}
        >
          {inside ? t("apps.card.backToApp") : t("apps.join")}
        </Button>
      </footer>
    );
  }

  const blocked = tile.reason !== null || live !== undefined;
  const noPermission = !canStart || failed?.code === "permission";
  const note = noPermission
    ? t("apps.launcher.noPermission")
    : live
      ? t("apps.launcher.onePerChannel")
      : failed
        ? null
        : t("apps.launcher.hostNote");
  const disabled = starting || blocked || noPermission;

  return (
    <footer className="flex flex-col gap-3 border-t border-border px-4 py-3">
      {failed && !noPermission ? (
        <p
          role="alert"
          className="flex items-start gap-2 rounded-[var(--radius-control)] bg-danger-soft px-2.5 py-2 text-xs leading-4 text-on-danger-soft"
        >
          <TriangleAlert aria-hidden className="mt-px h-3.5 w-3.5 shrink-0" />
          <span>
            {failed.code === "rate-limited"
              ? t("apps.launcher.rateLimited")
              : t("apps.launcher.failed")}
          </span>
        </p>
      ) : null}
      <div className="flex flex-wrap items-center justify-between gap-3">
        {note ? (
          <p className="min-w-0 flex-1 basis-[200px] text-xs leading-4 text-text-tertiary">
            {note}
          </p>
        ) : (
          <span className="flex-1" />
        )}
        <Button
          ref={startButtonRef}
          type="button"
          aria-busy={starting || undefined}
          aria-disabled={disabled || undefined}
          className="h-12 w-full sm:h-9 sm:w-auto sm:min-w-[120px] aria-disabled:cursor-not-allowed aria-disabled:opacity-60"
          onClick={() => {
            if (!disabled && tile.kind === "app") {
              onStart(tile);
            }
          }}
        >
          {starting ? (
            <>
              <StartSpinner />
              {t("apps.launcher.starting")}
            </>
          ) : failed && !noPermission ? (
            <>
              <RefreshCw aria-hidden className="h-4 w-4" />
              {t("apps.card.retry")}
            </>
          ) : (
            t("apps.launcher.start")
          )}
        </Button>
      </div>
    </footer>
  );
}

function StartSpinner() {
  return (
    <>
      <span
        aria-hidden
        className="h-4 w-4 animate-spin rounded-full border-2 border-current border-t-transparent motion-reduce:hidden"
      />
      <span
        aria-hidden
        className="hidden h-3.5 w-3.5 rounded-full border-2 border-dashed border-current motion-reduce:inline-block"
      />
    </>
  );
}

function EmptyBody({ onRequestAccess }: { onRequestAccess?: () => void }) {
  const { t } = useTranslation();
  return (
    <div className="flex flex-col items-start gap-3 p-6" data-testid="apps-empty">
      <span
        aria-hidden
        className="flex h-10 w-10 items-center justify-center rounded-[var(--radius-control)] bg-surface-2 text-text-tertiary"
      >
        <LayoutGrid className="h-5 w-5" />
      </span>
      <h3 className="font-display text-lg font-bold leading-6 text-text [text-wrap:balance]">
        {t("apps.launcher.emptyTitle")}
      </h3>
      <p className="max-w-[320px] text-[13px] leading-5 text-text-secondary">
        {t("apps.launcher.emptyBody")}
      </p>
      {onRequestAccess ? (
        <Button type="button" variant="secondary" onClick={onRequestAccess}>
          {t("apps.launcher.requestAccess")}
        </Button>
      ) : null}
    </div>
  );
}

function OfflineBody({ serverId }: { serverId: string }) {
  const { t } = useTranslation();
  return (
    <div className="flex flex-col items-start gap-3 p-6" data-testid="apps-offline">
      <h3 className="font-display text-lg font-bold leading-6 text-text">
        {t("apps.launcher.offlineTitle")}
      </h3>
      <p className="max-w-[320px] text-[13px] leading-5 text-text-secondary">
        {t("apps.launcher.offlineBody")}
      </p>
      <Button
        type="button"
        variant="secondary"
        onClick={() => {
          void loadAppsConfig(serverId).catch(() => {
            // Still offline: the panel keeps saying so.
          });
        }}
      >
        {t("apps.card.retry")}
      </Button>
    </div>
  );
}

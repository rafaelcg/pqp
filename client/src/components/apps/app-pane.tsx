import { TriangleAlert } from "lucide-react";
import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from "react";
import { AppFrame, type AppFrameHandle, type AppFrameStatus } from "@/components/apps/app-frame";
import "@/components/apps/apps-strip.css";
import { Button } from "@/components/ui/button";
import type { AppConfigEntry } from "@pqp/shared";
import { parseAppsOrigin } from "@/lib/apps/apps-origin";
import type {
  AppRuntimeConfig,
  AppSessionTransport,
  AppUserDirectory,
} from "@/lib/apps/types";
import { useTranslation, type MessageKey } from "@/lib/i18n";
import { cn } from "@/lib/utils";

/**
 * The app itself, in the conversation's place (mock 03). The pane is a labelled
 * region holding one sandboxed frame (`AppFrame`), the loading and failure
 * states around it, and the veil that freezes it while the link is down.
 *
 * THE VEIL FREEZES, IT DOES NOT HIDE. While the socket is down the app keeps its
 * last picture under a 40 % veil that eats pointer input, so what the person
 * sees is the room as it was and not a blank that reads as "it crashed". The
 * seat is held for 90 seconds and the strip says so.
 *
 * It measures itself once and gives that to the frame as its first height: an
 * app that never calls `ui.resize` then fills the pane, and one that does is
 * still obeyed (the frame's own height rules from then on).
 */

export interface AppPaneHandle {
  focus(): void;
  /** The element a pane share crops to. */
  element(): HTMLElement | null;
}

export interface AppPaneProps {
  app: AppConfigEntry;
  /** `origin` of the apps config; null while this deployment has none. */
  origin: string | null;
  title: string;
  transport: AppSessionTransport;
  users: AppUserDirectory;
  locale: string;
  asSpectator?: boolean;
  /** The link to the server is down: freeze the pane. */
  frozen?: boolean;
  /** Whether a failed join as a player may be offered as a watch (the app admits spectators). */
  canWatch?: boolean;
  onShare?: (on: boolean) => Promise<boolean>;
  onStatus?: (status: AppFrameStatus) => void;
  className?: string;
}

/** The slice of a config entry the frame host reads. */
export function runtimeConfigOf(app: AppConfigEntry): AppRuntimeConfig | null {
  const url = app.entry.url;
  if (!url) return null;
  return {
    id: app.id,
    version: app.version,
    entry: { url },
    capabilities: {
      share: app.capabilities.share,
      localFiles: app.capabilities.localFiles,
      deviceStore: app.capabilities.deviceStore,
    },
    assets: app.assets
      .filter((asset): asset is typeof asset & { url: string } => asset.url !== null)
      .map((asset) => ({
        name: asset.name,
        url: asset.url,
        sha256: asset.sha256,
        bytes: asset.bytes,
      })),
    shareAllowed: app.shareAllowed,
  };
}

function errorKey(status: Extract<AppFrameStatus, { kind: "error" }>): MessageKey {
  if (status.reason === "join-failed") {
    switch (status.code) {
      case "full":
        return "apps.pane.errorFull";
      case "not-allowed":
        return "apps.pane.errorNotAllowed";
      case "ended":
        return "apps.pane.errorEnded";
      default:
        return "apps.pane.errorJoin";
    }
  }
  if (status.reason === "bad-entry") return "apps.pane.errorUnavailable";
  return "apps.pane.error";
}

export const AppPane = forwardRef<AppPaneHandle, AppPaneProps>(function AppPane(props, ref) {
  const { app, origin, title, transport, users, locale, frozen, canWatch, className } = props;
  const { t } = useTranslation();
  const box = useRef<HTMLDivElement>(null);
  const frame = useRef<AppFrameHandle>(null);
  const [height, setHeight] = useState<number | null>(null);
  const [status, setStatus] = useState<AppFrameStatus>({ kind: "loading" });
  const [attempt, setAttempt] = useState(0);
  const [asSpectator, setAsSpectator] = useState(props.asSpectator === true);

  useImperativeHandle(
    ref,
    () => ({
      focus: () => frame.current?.focus(),
      element: () => box.current,
    }),
    [],
  );

  useEffect(() => {
    const node = box.current;
    if (!node) return;
    const first = Math.round(node.clientHeight);
    setHeight(first > 0 ? first : 360);
  }, []);

  const runtime = runtimeConfigOf(app);
  const safeOrigin = origin ? parseAppsOrigin(origin) : null;

  const onStatus = useCallback(
    (next: AppFrameStatus) => {
      setStatus(next);
      props.onStatus?.(next);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [props.onStatus],
  );

  const unavailable = !runtime || !safeOrigin;

  return (
    <div
      ref={box}
      role="region"
      aria-label={t("apps.strip.pane", { app: title })}
      data-testid="app-pane"
      data-status={unavailable ? "unavailable" : status.kind}
      className={cn(
        "relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-surface-0",
        className,
      )}
    >
      {!unavailable && height !== null && status.kind !== "error" ? (
        <AppFrame
          key={attempt}
          ref={frame}
          app={runtime}
          appsOrigin={safeOrigin}
          transport={transport}
          users={users}
          title={title}
          locale={locale}
          asSpectator={asSpectator}
          initialHeight={height}
          className="flex min-h-0 flex-1 flex-col overflow-auto"
          onStatus={onStatus}
          onShare={props.onShare}
        />
      ) : null}
      {!unavailable && status.kind === "loading" ? (
        <div
          className="pointer-events-none absolute inset-0 grid place-items-center text-sm text-text-tertiary"
          role="status"
        >
          {t("apps.pane.loading", { app: title })}
        </div>
      ) : null}
      {unavailable || status.kind === "error" ? (
        <div
          role="alert"
          className="m-auto flex max-w-sm flex-col items-center gap-3 p-6 text-center"
        >
          <span className="grid h-12 w-12 place-items-center rounded-2xl bg-danger-soft text-on-danger-soft">
            <TriangleAlert aria-hidden className="h-6 w-6" />
          </span>
          <p className="text-sm text-text-secondary">
            {unavailable
              ? t("apps.pane.errorUnavailable")
              : t(errorKey(status as Extract<AppFrameStatus, { kind: "error" }>))}
          </p>
          {!unavailable ? (
            <div className="flex gap-2">
              {status.kind === "error" &&
              status.reason === "join-failed" &&
              status.code === "full" &&
              canWatch ? (
                <Button
                  type="button"
                  variant="secondary"
                  onClick={() => {
                    setAsSpectator(true);
                    setStatus({ kind: "loading" });
                    setAttempt((n) => n + 1);
                  }}
                >
                  {t("apps.strip.watch")}
                </Button>
              ) : null}
              <Button
                type="button"
                onClick={() => {
                  setStatus({ kind: "loading" });
                  setAttempt((n) => n + 1);
                }}
              >
                {t("apps.pane.retry")}
              </Button>
            </div>
          ) : null}
        </div>
      ) : null}
      {frozen ? (
        <div aria-hidden data-testid="app-pane-veil" className="app-pane-veil absolute inset-0" />
      ) : null}
    </div>
  );
});

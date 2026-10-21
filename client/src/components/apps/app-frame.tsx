import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";
import {
  mountAppFrame,
  type AppFrameController,
  type AppFrameControllerOptions,
  type AppFrameStatus,
} from "@/lib/apps/frame-controller";
import type { ShareAudioRelay } from "@/lib/apps/share-audio";
import type {
  AppRuntimeConfig,
  AppSessionTransport,
  AppUserDirectory,
} from "@/lib/apps/types";

export type { AppFrameStatus } from "@/lib/apps/frame-controller";

export interface AppFrameProps {
  /** One entry of `GET /api/apps/config`, reduced to what the host needs. */
  app: AppRuntimeConfig;
  /** `origin` of that config, through `parseAppsOrigin`. */
  appsOrigin: string;
  /** The session on the server. Track U passes the `/ws` implementation. */
  transport: AppSessionTransport;
  /** Who a user id is (name and avatar URL), for the seats an app draws. */
  users: AppUserDirectory;
  /** The iframe's accessible name, usually the app's translated name. */
  title: string;
  /** BCP 47 tag of the language pqp is showing, sent to the app in `hello`. */
  locale: string;
  asSpectator?: boolean;
  /** CSS pixels, until the app asks for another height. Default 360. */
  initialHeight?: number;
  className?: string;
  /** Loading, ready, error (with a reason) or ended. The UI around the frame draws each. */
  onStatus?: (status: AppFrameStatus) => void;
  /** pqp's screen share flow, for apps whose manifest allows sharing the pane. */
  onShare?: (on: boolean) => Promise<boolean>;
  /** The app's own sound for a running share (`share.audio`). Stable for the life of the frame: read when it mounts. */
  shareAudio?: ShareAudioRelay;
  /**
   * Whether the pane is shared right now, as the page knows it. The app is told
   * whenever it changes (the bridge's `share` push), so its own share control
   * follows the switch above the pane and the call's stop.
   */
  shared?: boolean;
  /**
   * Bridge host options beyond the session (the guest player passes `guest`,
   * `saveSync: null`, its own device store and `onActivity`). Read when the
   * frame mounts.
   */
  host?: AppFrameControllerOptions["host"];
}

export interface AppFrameHandle {
  /** Put focus on the frame, its one tab stop. */
  focus(): void;
}

/**
 * An app, running. Renders a `div` and lets `mountAppFrame` put the sandboxed
 * `<iframe>` in it (the frame is created imperatively, after the page's
 * `frame-src` policy is in place; see `lib/apps/frame-controller.ts` for the
 * whole story and the keyboard contract).
 *
 * `data-status` on the wrapper is `loading`, `ready`, `error` or `ended`. The
 * seat is taken on mount and released on unmount. Props that identify the
 * session (`app`, `transport`, `appsOrigin`) must be stable for as long as the
 * frame should live: a new `app.entry.url` or `transport` is a new frame.
 */
export const AppFrame = forwardRef<AppFrameHandle, AppFrameProps>(function AppFrame(props, ref) {
  const { app, appsOrigin, transport, users, title, locale, asSpectator, initialHeight, className } = props;
  const container = useRef<HTMLDivElement>(null);
  const controller = useRef<AppFrameController | null>(null);
  const [status, setStatus] = useState<AppFrameStatus["kind"]>("loading");

  // the latest callbacks and values, without remounting the frame when they change
  const shared = props.shared === true;
  const latest = useRef({ onStatus: props.onStatus, onShare: props.onShare, locale, users, shared });
  latest.current = { onStatus: props.onStatus, onShare: props.onShare, locale, users, shared };

  useImperativeHandle(ref, () => ({ focus: () => controller.current?.focus() }), []);

  useEffect(() => {
    const node = container.current;
    if (!node) return undefined;
    setStatus("loading");
    const mounted = mountAppFrame({
      container: node,
      app,
      appsOrigin,
      title,
      transport,
      users: { resolve: (userId) => latest.current.users.resolve(userId) },
      locale: () => latest.current.locale,
      asSpectator,
      initialHeight,
      ...(props.host ? { host: props.host } : {}),
      ...(props.shareAudio ? { shareAudio: props.shareAudio } : {}),
      onShare: (on) =>
        latest.current.onShare ? latest.current.onShare(on) : Promise.reject(new Error("no share flow")),
      onStatus: (next) => {
        setStatus(next.kind);
        latest.current.onStatus?.(next);
      },
    });
    controller.current = mounted;
    mounted.setShared(latest.current.shared);
    // a failure while mounting (a bad entry URL) was already reported through onStatus
    setStatus(mounted.status.kind);
    return () => {
      mounted.destroy();
      controller.current = null;
    };
    // title, locale and the callbacks are read live; the session identity is what a frame is
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [app.entry.url, app.id, app.version, appsOrigin, transport, asSpectator]);

  useEffect(() => {
    controller.current?.setShared(shared);
  }, [shared]);

  return <div ref={container} className={className} data-app-frame-host data-status={status} />;
});

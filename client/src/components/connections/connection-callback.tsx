import { useEffect, useRef } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { completeConnection } from "@/lib/api";
import {
  callbackParamsFromLocation,
  hasStashedConnectionCallback,
  stashConnectionCallbackFromWindow,
  takeConnectionCallbackFromWindow,
} from "@/lib/connection-callback";
import { connectionProviderFromPath } from "@pqp/shared";
import { useTranslation } from "@/lib/i18n";

/**
 * Finishes Steam / Battle.net / Twitch after the provider bounces back to
 * `/app/connections/callback/:provider`. The authorization code (or OpenID
 * assertion) is in the query string; this posts it to the API with the
 * existing Clerk session and then opens Settings → Connections.
 *
 * The query is stashed on first paint so a later `syncRoute` rewrite cannot
 * drop it. A module-level inflight promise is what stops StrictMode from
 * POSTing the same assertion twice.
 */

let inflight: Promise<"ok" | "error"> | null = null;

export function ConnectionCallbackOverlay({
  onFinished,
}: {
  onFinished: (result: "ok" | "error") => void;
}) {
  const { t } = useTranslation();
  const location = useLocation();
  const navigate = useNavigate();
  const onFinishedRef = useRef(onFinished);
  onFinishedRef.current = onFinished;

  stashConnectionCallbackFromWindow(location.pathname, location.search);

  const visible =
    connectionProviderFromPath(location.pathname) !== null ||
    hasStashedConnectionCallback() ||
    inflight !== null;

  useEffect(() => {
    if (!inflight) {
      inflight = (async () => {
        const pending =
          takeConnectionCallbackFromWindow() ??
          fallbackFromLocation(location.pathname, location.search);
        if (!pending) {
          return "error" as const;
        }
        try {
          await completeConnection(pending.provider, pending.params);
          return "ok" as const;
        } catch {
          return "error" as const;
        }
      })();
    }
    void inflight.then((result) => {
      onFinishedRef.current(result);
      inflight = null;
      navigate("/app", { replace: true });
    });
    // One-shot: location is read into the first inflight closure; onFinished
    // is a ref so a parent rerender cannot start a second POST.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [navigate]);

  if (!visible) {
    return null;
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-ink/80 px-6">
      <p className="text-sm text-paper-muted">
        {t("settings.connections.completing")}
      </p>
    </div>
  );
}

function fallbackFromLocation(pathname: string, search: string) {
  const provider = connectionProviderFromPath(pathname);
  if (!provider) {
    return null;
  }
  const params = callbackParamsFromLocation(search);
  if (Object.keys(params).length === 0) {
    return null;
  }
  return { provider, params };
}

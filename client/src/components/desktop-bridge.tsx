import { useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { deepLinkToAppPath, getDesktop } from "@/lib/desktop";

/**
 * Handles Electron deep-link IPC → React Router navigation under `/app`.
 */
export function DesktopDeepLinkBridge() {
  const navigate = useNavigate();

  useEffect(() => {
    const desktop = getDesktop();
    if (!desktop) {
      return;
    }

    function go(payload: string) {
      const path = deepLinkToAppPath(payload);
      navigate(path);
    }

    void desktop.getPendingDeepLink().then((pending) => {
      if (pending) {
        go(pending);
      }
    });

    return desktop.onDeepLink(go);
  }, [navigate]);

  return null;
}

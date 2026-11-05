import { useEffect, useState } from "react";
import { windowFillsScreen } from "@/lib/share-self-capture";

function read(): boolean {
  if (typeof window === "undefined") {
    return false;
  }
  try {
    return windowFillsScreen(window);
  } catch {
    return false;
  }
}

/** True while the pqp window fills its screen. See `windowFillsScreen`. */
export function useWindowFillsScreen(): boolean {
  const [fills, setFills] = useState(read);
  useEffect(() => {
    const update = () => setFills(read());
    update();
    window.addEventListener("resize", update);
    document.addEventListener("fullscreenchange", update);
    return () => {
      window.removeEventListener("resize", update);
      document.removeEventListener("fullscreenchange", update);
    };
  }, []);
  return fills;
}

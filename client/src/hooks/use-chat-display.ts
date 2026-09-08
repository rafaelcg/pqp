import { useSyncExternalStore } from "react";
import {
  getChatDisplay,
  setChatDisplay,
  subscribeChatDisplay,
  type ChatDisplay,
} from "@/lib/chat-display";

interface UseChatDisplay {
  display: ChatDisplay;
  setDisplay: typeof setChatDisplay;
}

export function useChatDisplay(): UseChatDisplay {
  const display = useSyncExternalStore(
    subscribeChatDisplay,
    getChatDisplay,
    getChatDisplay,
  );
  return { display, setDisplay: setChatDisplay };
}

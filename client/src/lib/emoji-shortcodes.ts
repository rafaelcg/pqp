const SHORTCODES: Record<string, string> = {
  smile: "😄",
  grinning: "😀",
  joy: "😂",
  rofl: "🤣",
  blush: "😊",
  heart_eyes: "😍",
  wink: "😉",
  thinking: "🤔",
  thumbs_up: "👍",
  thumbsup: "👍",
  "+1": "👍",
  thumbs_down: "👎",
  "-1": "👎",
  clap: "👏",
  wave: "👋",
  fire: "🔥",
  100: "💯",
  tada: "🎉",
  party: "🎉",
  heart: "❤️",
  hearts: "💕",
  eyes: "👀",
  cry: "😢",
  sob: "😭",
  angry: "😠",
  scream: "😱",
  skull: "💀",
  rocket: "🚀",
  check: "✅",
  x: "❌",
  warning: "⚠️",
  star: "⭐",
  sparkles: "✨",
  ok_hand: "👌",
  pray: "🙏",
  muscle: "💪",
  coffee: "☕",
  pizza: "🍕",
};

export function expandEmojiShortcodes(input: string): string {
  return input.replace(/:([a-z0-9_+-]+):/gi, (match, name: string) => {
    const emoji = SHORTCODES[name.toLowerCase()];
    return emoji ?? match;
  });
}

export const QUICK_REACTIONS = ["👍", "❤️", "😂", "😮", "😢", "🔥", "🎉", "👀"] as const;

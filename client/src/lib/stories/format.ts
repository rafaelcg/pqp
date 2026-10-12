import { STORY_REACTIONS, type StoryReaction } from "@pqp/shared";

/**
 * "2 h", "12 min": how a story says its age and its time left. Units read the
 * same in the three languages the app speaks, so these need no catalogue keys
 * (design §14: `{left}` is "21 h" / "40 min").
 */
export function formatStoryDuration(ms: number): string {
  const minutes = Math.max(1, Math.floor(Math.max(0, ms) / 60_000));
  if (minutes < 60) {
    return `${minutes} min`;
  }
  return `${Math.floor(minutes / 60)} h`;
}

export function formatStoryAge(publishedAt: string | null, now: number): string {
  const at = publishedAt ? Date.parse(publishedAt) : NaN;
  return Number.isFinite(at) ? formatStoryDuration(now - at) : "";
}

export function formatStoryLeft(expiresAt: string | null, now: number): string {
  const at = expiresAt ? Date.parse(expiresAt) : NaN;
  return Number.isFinite(at) ? formatStoryDuration(at - now) : "";
}

/** GG is the house reaction: a word, not an emoji. */
export const STORY_REACTION_GLYPH: Record<StoryReaction, string> = {
  gg: "GG",
  fire: "🔥",
  joy: "😂",
  wow: "😮",
  skull: "💀",
  clap: "👏",
};

export const STORY_REACTION_ORDER: readonly StoryReaction[] = STORY_REACTIONS;

/** First name for a ring label: what fits under a 48 px circle. */
export function ringLabel(displayName: string): string {
  const first = displayName.trim().split(/\s+/)[0] ?? displayName;
  return first || displayName;
}

import {
  Bug,
  Camera,
  CircleCheck,
  CircleHelp,
  Clapperboard,
  Code,
  Coffee,
  CalendarDays,
  Film,
  Flame,
  Gamepad2,
  Gift,
  Heart,
  LifeBuoy,
  Lightbulb,
  Link as LinkIcon,
  Lock,
  Laugh,
  Megaphone,
  MessageSquareHeart,
  MessagesSquare,
  Music,
  Newspaper,
  Palette,
  Pin,
  RefreshCw,
  Rocket,
  ScrollText,
  Sparkles,
  Star,
  Trophy,
  Tv,
  TriangleAlert,
  Users,
  Vote,
  Wrench,
  BookOpen,
  type LucideIcon,
} from "lucide-react";
import {
  type ForumTag,
  type ForumTagIconKey,
  type ForumTagPreset,
} from "@pqp/shared";
import { useTranslation, type MessageKey } from "@/lib/i18n";

/**
 * A forum tag's picture. The wire carries an icon KEY from the curated set in
 * `@pqp/shared` (`FORUM_TAG_ICONS`); this is the web's art for each key. A
 * `Record` over the key type, so adding a key to the shared list fails the
 * build here until it has a drawing, and `forum-tag-icons.test.ts` checks the
 * labels and the locales as well.
 */
export const FORUM_TAG_ICON_COMPONENTS: Record<ForumTagIconKey, LucideIcon> = {
  question: CircleHelp,
  help: LifeBuoy,
  bug: Bug,
  idea: Lightbulb,
  feedback: MessageSquareHeart,
  discussion: MessagesSquare,
  poll: Vote,
  announcement: Megaphone,
  news: Newspaper,
  release: Rocket,
  update: RefreshCw,
  wip: Wrench,
  code: Code,
  guide: BookOpen,
  rules: ScrollText,
  solved: CircleCheck,
  warning: TriangleAlert,
  security: Lock,
  pinned: Pin,
  event: CalendarDays,
  showcase: Sparkles,
  art: Palette,
  photo: Camera,
  video: Clapperboard,
  clip: Film,
  stream: Tv,
  music: Music,
  game: Gamepad2,
  meme: Laugh,
  offtopic: Coffee,
  community: Users,
  gift: Gift,
  trophy: Trophy,
  hot: Flame,
  star: Star,
  heart: Heart,
  link: LinkIcon,
};

/** The picker's accessible name for each icon, and the tooltip under a hover. */
export const FORUM_TAG_ICON_LABELS: Record<ForumTagIconKey, MessageKey> = {
  question: "forum.tags.icon.question",
  help: "forum.tags.icon.help",
  bug: "forum.tags.icon.bug",
  idea: "forum.tags.icon.idea",
  feedback: "forum.tags.icon.feedback",
  discussion: "forum.tags.icon.discussion",
  poll: "forum.tags.icon.poll",
  announcement: "forum.tags.icon.announcement",
  news: "forum.tags.icon.news",
  release: "forum.tags.icon.release",
  update: "forum.tags.icon.update",
  wip: "forum.tags.icon.wip",
  code: "forum.tags.icon.code",
  guide: "forum.tags.icon.guide",
  rules: "forum.tags.icon.rules",
  solved: "forum.tags.icon.solved",
  warning: "forum.tags.icon.warning",
  security: "forum.tags.icon.security",
  pinned: "forum.tags.icon.pinned",
  event: "forum.tags.icon.event",
  showcase: "forum.tags.icon.showcase",
  art: "forum.tags.icon.art",
  photo: "forum.tags.icon.photo",
  video: "forum.tags.icon.video",
  clip: "forum.tags.icon.clip",
  stream: "forum.tags.icon.stream",
  music: "forum.tags.icon.music",
  game: "forum.tags.icon.game",
  meme: "forum.tags.icon.meme",
  offtopic: "forum.tags.icon.offtopic",
  community: "forum.tags.icon.community",
  gift: "forum.tags.icon.gift",
  trophy: "forum.tags.icon.trophy",
  hot: "forum.tags.icon.hot",
  star: "forum.tags.icon.star",
  heart: "forum.tags.icon.heart",
  link: "forum.tags.icon.link",
};

/** The starter tags' names, in the viewer's language. */
export const FORUM_TAG_PRESET_KEYS: Record<ForumTagPreset, MessageKey> = {
  question: "forum.tags.preset.question",
  bug: "forum.tags.preset.bug",
  suggestion: "forum.tags.preset.suggestion",
  tutorial: "forum.tags.preset.tutorial",
  release: "forum.tags.preset.release",
  wip: "forum.tags.preset.wip",
  discussion: "forum.tags.preset.discussion",
};

type Translate = (key: MessageKey) => string;

/** What the tag is called ON THIS SCREEN: the localized starter name, or the stored one. */
export function forumTagLabel(
  tag: Pick<ForumTag, "name" | "preset">,
  t: Translate,
): string {
  return tag.preset && FORUM_TAG_PRESET_KEYS[tag.preset]
    ? t(FORUM_TAG_PRESET_KEYS[tag.preset])
    : tag.name;
}

/** The hook form, for a component that draws tags. */
export function useForumTagLabel(): (tag: Pick<ForumTag, "name" | "preset">) => string {
  const { t } = useTranslation();
  return (tag) => forumTagLabel(tag, t);
}

/**
 * The icon component for a tag, or null. Only a known key counts: an unknown
 * one reaches here as null (the schema degrades it) but a hand-built tag could
 * still carry one, and the emoji is the honest fallback.
 */
export function forumTagIconComponent(
  tag: Pick<ForumTag, "icon">,
): LucideIcon | null {
  return tag.icon ? (FORUM_TAG_ICON_COMPONENTS[tag.icon] ?? null) : null;
}

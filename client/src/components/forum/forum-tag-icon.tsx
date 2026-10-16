import type { ForumTag } from "@pqp/shared";
import { forumTagIconComponent } from "@/lib/forum-tag-icons";
import { cn } from "@/lib/utils";

/**
 * The picture at the start of a tag chip: the tag's icon when it has one, the
 * emoji an older row still carries when it does not, nothing when neither.
 * Always decorative: the tag's name sits beside it and says everything.
 */
export function ForumTagIcon({
  tag,
  className,
}: {
  tag: Pick<ForumTag, "icon" | "emoji">;
  /** Size and colour of the icon; the emoji fallback scales with the text. */
  className?: string;
}) {
  const Icon = forumTagIconComponent(tag);
  if (Icon) {
    return (
      <Icon
        aria-hidden="true"
        strokeWidth={2.25}
        data-forum-tag-icon={tag.icon ?? ""}
        className={cn("h-3 w-3 shrink-0", className)}
      />
    );
  }
  return tag.emoji ? <span aria-hidden="true">{tag.emoji}</span> : null;
}

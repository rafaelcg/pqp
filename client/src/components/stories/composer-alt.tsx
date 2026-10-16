import { useState } from "react";
import { STORY_LAYER_ALT_MAX } from "@pqp/shared";
import { useTranslation } from "@/lib/i18n";
import { ComposerSheet } from "./composer-stickers";
import { StoryButton } from "./composer-ui";

/**
 * "Describe the photo": the words a screen reader says for the picture (the story's own, or one
 * placed on it). It rises as a sheet like the stickers tray. Saving an empty box clears it; nothing
 * here is required, a story posts the same with none.
 */
export function AltTextSheet({
  kind,
  initial,
  onSave,
  onClose,
}: {
  /** What is being described, for the title and the hint. */
  kind: "base" | "photo";
  initial: string;
  onSave: (alt: string) => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const [value, setValue] = useState(initial);
  const left = STORY_LAYER_ALT_MAX - [...value].length;
  const save = () => onSave(value.replace(/\s+/g, " ").trim());
  return (
    <ComposerSheet
      title={t(kind === "base" ? "stories.editor.alt.titleBase" : "stories.editor.alt.titlePhoto")}
      hint={t("stories.editor.alt.hint")}
      onClose={onClose}
      testId="alt"
      focusClose={false}
    >
      <textarea
        value={value}
        onChange={(event) => setValue(event.target.value.slice(0, STORY_LAYER_ALT_MAX))}
        onKeyDown={(event) => {
          // Enter saves, as in every single-line field here; a description is one sentence, not a paragraph.
          if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
            event.preventDefault();
            save();
          }
        }}
        rows={3}
        maxLength={STORY_LAYER_ALT_MAX}
        autoFocus
        placeholder={t("stories.editor.alt.placeholder")}
        aria-label={t(kind === "base" ? "stories.editor.alt.titleBase" : "stories.editor.alt.titlePhoto")}
        aria-describedby="story-alt-count"
        data-story-alt-input=""
        className="story-field w-full resize-none rounded-[16px] border px-4 py-3 text-[16px] font-medium leading-snug outline-none"
        style={{ background: "var(--story-field-fill)", borderColor: "var(--story-field-edge)", color: "var(--story-on-media)" }}
      />
      <div className="flex items-center justify-between gap-3 px-1 pt-3">
        <span
          id="story-alt-count"
          className="text-xs tabular-nums"
          style={{ color: left <= 20 ? "var(--story-on-media)" : "var(--story-on-media-2)" }}
        >
          {t("stories.editor.alt.left", { n: left })}
        </span>
        <StoryButton data-story-alt-save="" onClick={save}>
          {t("stories.editor.alt.save")}
        </StoryButton>
      </div>
    </ComposerSheet>
  );
}

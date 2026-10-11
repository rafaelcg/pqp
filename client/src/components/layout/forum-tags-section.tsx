import { useRef, useState, type DragEvent, type KeyboardEvent } from "react";
import { GripVertical, Plus, Smile, Trash2 } from "lucide-react";
import { FORUM_MAX_TAGS, FORUM_TAG_NAME_MAX } from "@pqp/shared";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { Tooltip } from "@/components/ui/tooltip";
import { EmojiPickerPanel } from "@/components/chat/emoji-picker";
import { SettingsGroup, SettingsSwitchRow } from "@/components/settings/kit";
import { useTranslation } from "@/lib/i18n";
import {
  acceptTagEmoji,
  addStarterTags,
  addTag,
  clampTagName,
  draftProblems,
  moveTag,
  removeTag,
  starterTagsFor,
  updateTag,
  type TagDraft,
  type TagDraftRow,
} from "@/lib/forum-tag-draft";
import { cn } from "@/lib/utils";

/**
 * A forum's tags, edited in place (channel settings, section "Tags", visible
 * to MANAGE_CHANNELS). Mock: `04-tag-settings.png` in the forum UX study.
 *
 * Controlled: the draft lives in `ChannelSettingsDialog`, because the dialog's
 * sticky footer ("1 mudança não salva", Desfazer, Salvar) is what saves it,
 * as one PUT for the tags and one PATCH for the switch. Every rule about the
 * draft (duplicates, the 20 cap, what counts as a change) is in
 * `lib/forum-tag-draft.ts`; this file only draws it.
 *
 * Rows: drag handle (or its arrow keys), emoji, the name as a field that
 * looks like text until it is touched, the post count, "Só staff", delete.
 * Deleting a saved tag asks first and says how many posts it comes off.
 */
export function ForumTagsSection({
  channelName,
  draft,
  onDraftChange,
  status,
  onRetry,
}: {
  channelName: string;
  draft: TagDraft;
  onDraftChange: (next: TagDraft) => void;
  status: "loading" | "ready" | "error";
  onRetry: () => void;
}) {
  const { t } = useTranslation();
  const [newName, setNewName] = useState("");
  const [newEmoji, setNewEmoji] = useState<string | null>(null);
  const [addError, setAddError] = useState<string | null>(null);
  const [emojiFor, setEmojiFor] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<TagDraftRow | null>(null);
  const [dragKey, setDragKey] = useState<string | null>(null);
  const [dropIndex, setDropIndex] = useState<number | null>(null);
  const newNameRef = useRef<HTMLInputElement>(null);
  const handleRefs = useRef(new Map<string, HTMLButtonElement>());

  const problems = draftProblems(draft);
  const full = draft.rows.length >= FORUM_MAX_TAGS;
  const starters = starterTagsFor(channelName).map((starter) => ({
    emoji: starter.emoji,
    name: t(starter.nameKey),
  }));

  function submitNew() {
    const result = addTag(draft, { name: newName, emoji: newEmoji });
    if (!result.ok) {
      setAddError(t(result.error, { max: FORUM_MAX_TAGS }));
      return;
    }
    onDraftChange(result.draft);
    setNewName("");
    setNewEmoji(null);
    setAddError(null);
    newNameRef.current?.focus();
  }

  function moveBy(row: TagDraftRow, delta: -1 | 1) {
    const index = draft.rows.findIndex((one) => one.key === row.key);
    onDraftChange(moveTag(draft, row.key, index + delta));
    // The handle re-renders in its new place; keep the keyboard on it.
    requestAnimationFrame(() => handleRefs.current.get(row.key)?.focus());
  }

  function onHandleKey(event: KeyboardEvent<HTMLButtonElement>, row: TagDraftRow) {
    if (event.key === "ArrowUp" || event.key === "ArrowDown") {
      event.preventDefault();
      moveBy(row, event.key === "ArrowUp" ? -1 : 1);
    }
  }

  function onRowDragOver(event: DragEvent<HTMLLIElement>, index: number) {
    if (!dragKey) {
      return;
    }
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
    const box = event.currentTarget.getBoundingClientRect();
    const after = event.clientY > box.top + box.height / 2;
    setDropIndex(after ? index + 1 : index);
  }

  function onRowDrop(event: DragEvent<HTMLLIElement>) {
    event.preventDefault();
    if (dragKey !== null && dropIndex !== null) {
      const from = draft.rows.findIndex((row) => row.key === dragKey);
      // Dropping below itself moves past one fewer row once it is lifted out.
      onDraftChange(moveTag(draft, dragKey, dropIndex > from ? dropIndex - 1 : dropIndex));
    }
    setDragKey(null);
    setDropIndex(null);
  }

  function requestDelete(row: TagDraftRow) {
    if (!row.id && row.postCount === 0) {
      // Never saved: nothing to lose, nothing to ask.
      onDraftChange(removeTag(draft, row.key));
      return;
    }
    setPendingDelete(row);
  }

  function pickEmoji(target: string, value: string) {
    const emoji = acceptTagEmoji(value);
    if (!emoji) {
      return;
    }
    if (target === NEW_ROW) {
      setNewEmoji(emoji);
    } else {
      onDraftChange(updateTag(draft, target, { emoji }));
    }
    setEmojiFor(null);
  }

  return (
    <div className="space-y-4" data-forum-tags-section="">
      <header>
        <h3 className="font-display text-base font-bold text-text">
          {t("forum.settings.tags")}
        </h3>
        <p className="mt-1 text-[13px] leading-snug text-text-tertiary">
          {t("forum.settings.tags.lead")}
        </p>
      </header>

      <SettingsGroup>
        <SettingsSwitchRow
          id="forum-require-tag"
          searchable={false}
          label={t("forum.settings.requireTag")}
          description={t("forum.settings.requireTag.hint")}
          checked={draft.requireTag}
          disabled={status !== "ready"}
          onCheckedChange={(requireTag) => onDraftChange({ ...draft, requireTag })}
        />
      </SettingsGroup>

      {status === "loading" && (
        <div
          className="elevation-1 space-y-3 rounded-[var(--radius-card)] bg-surface-card p-4"
          aria-busy="true"
          aria-label={t("common.loading")}
        >
          <Skeleton className="h-4 w-1/2" />
          <Skeleton className="h-4 w-2/3" />
          <Skeleton className="h-4 w-1/3" />
        </div>
      )}

      {status === "error" && (
        <div
          role="alert"
          className="flex items-center justify-between gap-3 rounded-[var(--radius-card)] bg-warning-soft px-4 py-3 text-sm text-on-warning-soft"
        >
          <span>{t("forum.settings.loadFailed")}</span>
          <Button variant="secondary" size="sm" onClick={onRetry}>
            {t("bootstrapError.retry")}
          </Button>
        </div>
      )}

      {status === "ready" && draft.rows.length === 0 && (
        <div
          data-forum-starter=""
          className="rounded-[var(--radius-card)] border border-dashed border-border-strong px-4 py-3"
        >
          <p className="text-[13px] text-text-secondary">{t("forum.empty.starter")}</p>
          <div className="mt-2 flex flex-wrap items-center gap-1.5">
            {starters.map((starter) => (
              <span
                key={starter.name}
                className="inline-flex h-7 items-center gap-1 rounded-full border border-dashed border-border px-2.5 text-xs text-text-secondary"
              >
                <span aria-hidden="true">{starter.emoji}</span>
                {starter.name}
              </span>
            ))}
            <Button
              size="sm"
              variant="secondary"
              className="ml-auto"
              onClick={() => onDraftChange(addStarterTags(draft, starters))}
            >
              {t("forum.empty.starterUse")}
            </Button>
          </div>
        </div>
      )}

      {status === "ready" && (
        <div className="elevation-1 overflow-hidden rounded-[var(--radius-card)] bg-surface-card">
          <div
            aria-hidden="true"
            className="grid grid-cols-[1fr_auto] items-center gap-3 border-b border-border px-4 py-2 text-[11px] font-semibold uppercase tracking-[0.12em] text-text-tertiary"
          >
            <span>{t("forum.settings.col.tag")}</span>
            <span className="flex items-center gap-3">
              <span className="w-10 text-right max-sm:hidden">
                {t("forum.settings.col.posts")}
              </span>
              <span className="w-20 whitespace-nowrap text-center">{t("forum.settings.col.staff")}</span>
              <span className="w-8" />
            </span>
          </div>

          <ul role="list" onDragLeave={() => setDropIndex(null)}>
            {draft.rows.map((row, index) => {
              const problem = problems.get(row.key);
              const length = Array.from(row.name).length;
              return (
                <li
                  key={row.key}
                  data-forum-tag-row={row.key}
                  onDragOver={(event) => onRowDragOver(event, index)}
                  onDrop={onRowDrop}
                  className={cn(
                    "relative border-b border-border px-2 py-1.5 sm:px-3",
                    // Only a row that just arrived fades in; the saved list
                    // is simply there when the section opens.
                    !row.id && "animate-fade-in",
                    dragKey === row.key && "opacity-50",
                    dropIndex === index && "shadow-[inset_0_2px_0_var(--color-accent)]",
                    dropIndex === index + 1 &&
                      index === draft.rows.length - 1 &&
                      "shadow-[inset_0_-2px_0_var(--color-accent)]",
                  )}
                >
                  <div className="flex items-center gap-2">
                    <Tooltip label={t("forum.settings.moveTag", { name: row.name })}>
                      <button
                        type="button"
                        ref={(node) => {
                          if (node) {
                            handleRefs.current.set(row.key, node);
                          } else {
                            handleRefs.current.delete(row.key);
                          }
                        }}
                        draggable
                        onDragStart={(event) => {
                          event.dataTransfer.effectAllowed = "move";
                          event.dataTransfer.setData("text/plain", row.name);
                          setDragKey(row.key);
                        }}
                        onDragEnd={() => {
                          setDragKey(null);
                          setDropIndex(null);
                        }}
                        onKeyDown={(event) => onHandleKey(event, row)}
                        className="flex h-11 w-6 shrink-0 sm:h-8 cursor-grab items-center justify-center rounded-[var(--radius-control)] text-text-tertiary hover:text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring active:cursor-grabbing"
                      >
                        <GripVertical className="h-4 w-4" aria-hidden="true" />
                      </button>
                    </Tooltip>

                    <EmojiButton
                      emoji={row.emoji}
                      label={t("forum.settings.emoji", { name: row.name })}
                      open={emojiFor === row.key}
                      onToggle={() => setEmojiFor(emojiFor === row.key ? null : row.key)}
                      onClear={() => onDraftChange(updateTag(draft, row.key, { emoji: null }))}
                      onPick={(value) => pickEmoji(row.key, value)}
                      onClose={() => setEmojiFor(null)}
                    />

                    <label className="group/name relative flex min-w-0 flex-1 items-center gap-2">
                      <span className="sr-only">{t("forum.settings.tagName")}</span>
                      <input
                        value={row.name}
                        maxLength={FORUM_TAG_NAME_MAX * 2}
                        aria-invalid={problem ? true : undefined}
                        onChange={(event) =>
                          onDraftChange(updateTag(draft, row.key, { name: event.target.value }))
                        }
                        className={cn(
                          "peer h-11 min-w-0 flex-1 rounded-[var(--radius-control)] border border-transparent bg-transparent px-2 text-base font-medium sm:h-9 sm:text-sm text-text outline-none transition-colors duration-[var(--duration-fast)]",
                          "hover:border-border focus:border-accent focus:bg-surface-0 focus:pr-14",
                          problem && "border-danger",
                        )}
                      />
                      <span
                        aria-hidden="true"
                        className="pointer-events-none absolute right-2 hidden text-[11px] tabular-nums text-text-tertiary peer-focus:block"
                      >
                        {length}/{FORUM_TAG_NAME_MAX}
                      </span>
                      {row.moderated && (
                        <Badge variant="accent" className="peer-focus:hidden">
                          {t("forum.settings.staffBadge")}
                        </Badge>
                      )}
                    </label>

                    <span className="w-10 shrink-0 text-right text-xs tabular-nums text-text-tertiary max-sm:hidden">
                      {row.postCount}
                    </span>

                    <div className="flex w-20 shrink-0 justify-center">
                      <Switch
                        checked={row.moderated}
                        onCheckedChange={(moderated) =>
                          onDraftChange(updateTag(draft, row.key, { moderated }))
                        }
                        label={t("forum.settings.staffOnly", { name: row.name })}
                        hideLabel
                      />
                    </div>

                    <Tooltip label={t("forum.settings.deleteTag", { name: row.name })}>
                      <button
                        type="button"
                        onClick={() => requestDelete(row)}
                        className="flex h-11 w-11 shrink-0 sm:h-8 sm:w-8 items-center justify-center rounded-[var(--radius-control)] text-text-tertiary hover:bg-danger-soft hover:text-on-danger-soft focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring"
                      >
                        <Trash2 className="h-4 w-4" aria-hidden="true" />
                      </button>
                    </Tooltip>
                  </div>
                  {problem && (
                    <p role="alert" className="ml-16 mt-0.5 text-xs text-danger">
                      {t(problem)}
                    </p>
                  )}
                </li>
              );
            })}
          </ul>

          <form
            className="flex items-center gap-2 px-2 py-2 sm:px-3"
            onSubmit={(event) => {
              event.preventDefault();
              submitNew();
            }}
          >
            <span className="w-6 shrink-0" aria-hidden="true" />
            <EmojiButton
              emoji={newEmoji}
              label={t("forum.settings.newEmoji")}
              open={emojiFor === NEW_ROW}
              onToggle={() => setEmojiFor(emojiFor === NEW_ROW ? null : NEW_ROW)}
              onClear={() => setNewEmoji(null)}
              onPick={(value) => pickEmoji(NEW_ROW, value)}
              onClose={() => setEmojiFor(null)}
              disabled={full}
            />
            <input
              ref={newNameRef}
              value={newName}
              disabled={full}
              placeholder={t("forum.settings.newTag")}
              aria-label={t("forum.settings.newTag")}
              aria-invalid={addError ? true : undefined}
              aria-describedby={addError ? "forum-tag-add-error" : undefined}
              onChange={(event) => {
                setNewName(clampTagName(event.target.value));
                setAddError(null);
              }}
              className="h-11 min-w-0 flex-1 rounded-[var(--radius-control)] border border-transparent bg-transparent px-2 text-base text-text sm:h-9 sm:text-sm outline-none placeholder:text-text-tertiary hover:border-border focus:border-accent focus:bg-surface-0 disabled:cursor-not-allowed disabled:opacity-50"
            />
            <Button type="submit" variant="secondary" size="sm" disabled={full}>
              <Plus className="h-4 w-4" aria-hidden="true" />
              {t("forum.settings.add")}
            </Button>
          </form>
        </div>
      )}

      {status === "ready" && (
        <div className="flex items-start justify-between gap-3 text-xs text-text-tertiary">
          <p>{draft.rows.length > 1 ? t("forum.settings.reorder") : null}</p>
          <p className="shrink-0 tabular-nums" aria-live="polite">
            {full
              ? t("forum.settings.full", { max: FORUM_MAX_TAGS })
              : t("forum.settings.count", { count: draft.rows.length, max: FORUM_MAX_TAGS })}
          </p>
        </div>
      )}
      {addError && (
        <p id="forum-tag-add-error" role="alert" className="text-xs text-danger">
          {addError}
        </p>
      )}

      <ConfirmDialog
        open={pendingDelete !== null}
        title={t("forum.settings.delete.title", { name: pendingDelete?.name ?? "" })}
        description={t("forum.settings.delete.body", {
          count: pendingDelete?.postCount ?? 0,
        })}
        confirmLabel={t("forum.settings.delete.confirm")}
        onConfirm={() => {
          if (pendingDelete) {
            onDraftChange(removeTag(draft, pendingDelete.key));
          }
          setPendingDelete(null);
        }}
        onClose={() => setPendingDelete(null)}
      />
    </div>
  );
}

const NEW_ROW = "__new__";

/**
 * The emoji square at the start of a row. Opens the app's emoji picker;
 * Delete or Backspace on it takes the emoji off.
 */
function EmojiButton({
  emoji,
  label,
  open,
  onToggle,
  onClear,
  onPick,
  onClose,
  disabled = false,
}: {
  emoji: string | null;
  label: string;
  open: boolean;
  onToggle: () => void;
  onClear: () => void;
  onPick: (value: string) => void;
  onClose: () => void;
  disabled?: boolean;
}) {
  return (
    <span className="relative shrink-0">
      <Tooltip label={label}>
        <button
          type="button"
          disabled={disabled}
          aria-expanded={open}
          onClick={onToggle}
          onKeyDown={(event) => {
            if (emoji && (event.key === "Backspace" || event.key === "Delete")) {
              event.preventDefault();
              onClear();
            }
          }}
          className="flex h-10 w-10 items-center sm:h-8 sm:w-8 justify-center rounded-[var(--radius-control)] border border-border bg-surface-0 text-base hover:border-border-strong focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring disabled:opacity-40"
        >
          {emoji ? (
            <span aria-hidden="true">{emoji}</span>
          ) : (
            <Smile className="h-4 w-4 text-text-tertiary" aria-hidden="true" />
          )}
        </button>
      </Tooltip>
      {open && <EmojiPickerPanel onSelect={onPick} onClose={onClose} />}
    </span>
  );
}

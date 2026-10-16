import {
  FORUM_MAX_TAGS_PER_POST,
  type ForumTag,
  type WebhookForumSettings,
} from "@pqp/shared";
import { ChevronDown, Tag as TagGlyph } from "lucide-react";
import { useId, useRef, useState } from "react";
import { ForumTagIcon } from "@/components/forum/forum-tag-icon";
import { SettingsInlineStatus } from "@/components/settings/kit/inline-status";
import { useInlineSave } from "@/components/settings/kit/use-inline-save";
import { CheckRow } from "@/components/ui/check-row";
import { RadioGroup, type RadioOption } from "@/components/ui/radio-group";
import { putWebhookForumSettings } from "@/lib/api";
import { forumTagIconComponent, useForumTagLabel } from "@/lib/forum-tag-icons";
import { useTranslation } from "@/lib/i18n";
import { cn } from "@/lib/utils";

/** The windows offered, in hours. 0 is off. A value set some other way is kept as an extra option. */
const DEDUPE_PRESETS = [0, 24, 72, 168] as const;

type AllowMode = "all" | "chosen";

/**
 * A forum webhook's feed settings (forum PR 4): which tags the feed may apply,
 * which tags it gets when the item names none that match, and how long a
 * repeat of the same item is answered instead of posted. Each change saves at
 * once (`PUT /api/webhooks/:id/forum-settings` replaces all three), the way
 * every other row in settings does, and says so under the panel.
 *
 * Folded by default: most feeds never need it, and a forum with several
 * webhooks would otherwise be three checklists tall per row.
 */
export function WebhookForumSettingsPanel({
  webhookId,
  initial,
  tags,
}: {
  webhookId: string;
  initial: WebhookForumSettings;
  tags: ForumTag[];
}) {
  const { t } = useTranslation();
  const panelId = useId();
  const [open, setOpen] = useState(false);
  const [settings, setSettings] = useState<WebhookForumSettings>(initial);
  const { state, run } = useInlineSave();

  // What the server last confirmed, and which edit is the newest. Writes go
  // out one at a time and an overtaken one is skipped (`useInlineSave`), and
  // each sends the whole object, so the newest edit is what the server ends
  // up with. Only a failure of that newest edit rolls the ticks back, and
  // back to the server's state, never to a snapshot an older edit took.
  const confirmed = useRef<WebhookForumSettings>(initial);
  const newest = useRef(0);

  function save(next: WebhookForumSettings) {
    const edit = ++newest.current;
    setSettings(next);
    void run(async () => {
      try {
        await putWebhookForumSettings(webhookId, next);
        confirmed.current = next;
      } catch (error) {
        if (edit === newest.current) {
          setSettings(confirmed.current);
        }
        throw error;
      }
    }, t("webhooks.forum.saveFailed"));
  }

  const mode: AllowMode = settings.allowedTagIds === null ? "all" : "chosen";
  const allowed = new Set(settings.allowedTagIds ?? []);
  const defaults = new Set(settings.defaultTagIds);
  const nameOf = useForumTagLabel();
  const tagLabel = (tag: ForumTag) =>
    tag.moderated ? `${nameOf(tag)} · ${t("webhooks.forum.staffOnly")}` : nameOf(tag);
  // Its own column, a tag glyph where there is no icon or emoji, so every name
  // starts at the same x (forum QA P13).
  const tagIcon = (tag: ForumTag) =>
    forumTagIconComponent(tag) || tag.emoji ? (
      <ForumTagIcon tag={tag} className="h-3.5 w-3.5" />
    ) : (
      <TagGlyph className="h-3.5 w-3.5" />
    );

  const dedupeOptions: RadioOption<number>[] = [
    ...DEDUPE_PRESETS.map((hours) => ({ value: hours, label: dedupeLabel(hours) })),
    ...(DEDUPE_PRESETS.includes(settings.dedupeWindowHours as (typeof DEDUPE_PRESETS)[number])
      ? []
      : [{ value: settings.dedupeWindowHours, label: dedupeLabel(settings.dedupeWindowHours) }]),
  ];

  function dedupeLabel(hours: number): string {
    if (hours === 0) return t("webhooks.forum.dedupe.off");
    if (hours === 168) return t("webhooks.forum.dedupe.week");
    return t("webhooks.forum.dedupe.hours", { hours });
  }

  return (
    <div className="mt-3 border-t border-border pt-2">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => setOpen((value) => !value)}
        className={cn(
          "flex w-full items-center justify-between gap-2 rounded-[var(--radius-control)] px-1 py-1.5 text-left text-sm text-text-secondary",
          "hover:text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring",
        )}
      >
        <span className="font-medium">{t("webhooks.forum.toggle")}</span>
        <ChevronDown
          aria-hidden
          className={cn(
            "h-4 w-4 shrink-0 transition-transform duration-[var(--duration-fast)] motion-reduce:transition-none",
            open && "rotate-180",
          )}
        />
      </button>
      {open && (
        <div id={panelId} className="mt-2 space-y-5 px-1 pb-1 motion-safe:animate-fade-in">
          <section className="space-y-2">
            <h4 className="text-xs font-semibold text-text-secondary">
              {t("webhooks.forum.allowed.label")}
            </h4>
            {tags.length === 0 ? (
              <p className="text-sm text-text-tertiary">{t("webhooks.forum.noTags")}</p>
            ) : (
              <>
                <RadioGroup<AllowMode>
                  label={t("webhooks.forum.allowed.label")}
                  variant="segmented"
                  size="sm"
                  value={mode}
                  options={[
                    { value: "all", label: t("webhooks.forum.allowed.all") },
                    { value: "chosen", label: t("webhooks.forum.allowed.chosen") },
                  ]}
                  onValueChange={(next) =>
                    save({
                      ...settings,
                      // Starting from every open tag, so picking "only these"
                      // changes nothing until a tick comes off.
                      allowedTagIds:
                        next === "all"
                          ? null
                          : tags.filter((tag) => !tag.moderated).map((tag) => tag.id),
                    })
                  }
                />
                {mode === "chosen" && (
                  <div role="group" aria-label={t("webhooks.forum.allowed.chosen")}>
                    {tags.map((tag) => (
                      <CheckRow
                        key={tag.id}
                        label={tagLabel(tag)}
                        icon={tagIcon(tag)}
                        checked={allowed.has(tag.id)}
                        onCheckedChange={(checked) =>
                          save({
                            ...settings,
                            allowedTagIds: tags
                              .filter((other) =>
                                other.id === tag.id ? checked : allowed.has(other.id),
                              )
                              .map((other) => other.id),
                          })
                        }
                      />
                    ))}
                  </div>
                )}
                <p className="text-xs text-text-tertiary">{t("webhooks.forum.allowed.hint")}</p>
              </>
            )}
          </section>

          {tags.length > 0 && (
            <section className="space-y-2">
              <h4 className="text-xs font-semibold text-text-secondary">
                {t("webhooks.forum.defaults.label")}
              </h4>
              <div role="group" aria-label={t("webhooks.forum.defaults.label")}>
                {tags.map((tag) => {
                  const checked = defaults.has(tag.id);
                  return (
                    <CheckRow
                      key={tag.id}
                      label={tagLabel(tag)}
                      icon={tagIcon(tag)}
                      checked={checked}
                      disabled={!checked && defaults.size >= FORUM_MAX_TAGS_PER_POST}
                      onCheckedChange={(next) =>
                        save({
                          ...settings,
                          defaultTagIds: tags
                            .filter((other) =>
                              other.id === tag.id ? next : defaults.has(other.id),
                            )
                            .map((other) => other.id),
                        })
                      }
                    />
                  );
                })}
              </div>
              <p className="text-xs text-text-tertiary">
                {t("webhooks.forum.defaults.hint", { max: FORUM_MAX_TAGS_PER_POST })}
              </p>
            </section>
          )}

          <section className="space-y-2">
            <h4 className="text-xs font-semibold text-text-secondary">
              {t("webhooks.forum.dedupe.label")}
            </h4>
            <RadioGroup<number>
              label={t("webhooks.forum.dedupe.label")}
              variant="segmented"
              size="sm"
              value={settings.dedupeWindowHours}
              options={dedupeOptions}
              onValueChange={(hours) => save({ ...settings, dedupeWindowHours: hours })}
            />
            <p className="text-xs text-text-tertiary">{t("webhooks.forum.dedupe.hint")}</p>
          </section>

          <SettingsInlineStatus state={state} />
        </div>
      )}
    </div>
  );
}

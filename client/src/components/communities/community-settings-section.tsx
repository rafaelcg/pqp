import {
  COMMUNITY_CATEGORIES,
  COMMUNITY_SLUG_MAX_LENGTH,
  COMMUNITY_TAGLINE_MAX_LENGTH,
  slugifyCommunityName,
  type CommunityCategory,
  type CommunitySettings,
} from "@pqp/shared";
import { Globe } from "lucide-react";
import { useEffect, useId, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  ApiError,
  fetchCommunitySettings,
  updateCommunitySettings,
} from "@/lib/api";
import { useTranslation } from "@/lib/i18n";

/**
 * The owner's opt-in, inside Server settings.
 *
 * THE COPY IS THE FEATURE HERE. Listing a server is the single most
 * consequential thing an owner can do to it — the room stops being private and
 * strangers can walk in without an invite and without anyone approving them —
 * and an owner who did not understand that is an owner who will be surprised by
 * their own member list. So the explainer says all three consequences in plain
 * words (findable, member count visible, one-tap join with no approval) and
 * says them BEFORE the switch, not in a tooltip beside it.
 *
 * The second paragraph is the half people forget to write: it is a public
 * surface now, so reports about it go to whoever runs the instance, and they can
 * pull the listing. Saying that up front is both honest and the thing that makes
 * a suspension later feel like a rule rather than an ambush.
 *
 * Rendered only when the deployment has communities on — the parent checks the
 * config — and only for the owner, which the server enforces independently.
 */
export function CommunitySettingsSection({
  serverId,
}: {
  serverId: string;
}) {
  const { t } = useTranslation();
  const [settings, setSettings] = useState<CommunitySettings | null>(null);
  const [tagline, setTagline] = useState("");
  const [category, setCategory] = useState<CommunityCategory>("geral");
  const [slug, setSlug] = useState("");
  const [listed, setListed] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /**
   * The address's own refusal, held apart from `error`.
   *
   * A collision is not a failure of the form, it is a failure of one field, and
   * a sentence at the bottom of the panel about a box halfway up it is a
   * sentence people re-read three times. The server makes this possible by
   * being explicit about it: on this route 400, 409 and 422 always mean the
   * address and never anything else — see the note on the PATCH handler.
   */
  const [slugError, setSlugError] = useState<string | null>(null);
  const toggleId = useId();
  const taglineId = useId();
  const categoryId = useId();
  const slugId = useId();

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    fetchCommunitySettings(serverId)
      .then((res) => {
        if (cancelled) {
          return;
        }
        setSettings(res.community);
        setListed(res.community.isCommunity);
        setTagline(res.community.tagline ?? "");
        setCategory(res.community.category);
        setSlug(res.community.slug ?? "");
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setError(
            err instanceof ApiError ? err.message : t("communities.settings.failed"),
          );
        }
      })
      .finally(() => {
        if (!cancelled) {
          setLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [serverId, t]);

  async function save() {
    setSaving(true);
    setError(null);
    setSlugError(null);
    setSaved(false);
    const typedSlug = slug.trim();
    try {
      const res = await updateCommunitySettings(serverId, {
        isCommunity: listed,
        // An emptied box means "clear it", which the API spells as explicit
        // null — sending "" would store a blank line the card reserves space for.
        tagline: tagline.trim() === "" ? null : tagline.trim(),
        category,
        // ABSENT WHEN THE BOX IS EMPTY, which is what asks the server to derive
        // one from the name on the first opt-in. Sending `""` would be a
        // request to set an empty address, and the schema would refuse it —
        // turning "I have not chosen one" into an error about a field the owner
        // never touched.
        ...(typedSlug ? { slug: typedSlug } : {}),
      });
      setSettings(res.community);
      setListed(res.community.isCommunity);
      setTagline(res.community.tagline ?? "");
      setCategory(res.community.category);
      // The server may have DERIVED one; reading it back is what puts the
      // address the owner now owns into the box they left empty.
      setSlug(res.community.slug ?? "");
      setSaved(true);
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        setSlugError(t("communities.settings.slugTaken"));
      } else if (err instanceof ApiError && err.status === 422) {
        setSlugError(t("communities.settings.slugUnderivable"));
      } else if (err instanceof ApiError && err.status === 400 && typedSlug) {
        // 400 on this route with a slug in the body is the schema refusing the
        // string's shape, and its message already says how.
        setSlugError(err.message);
      } else {
        setError(
          err instanceof ApiError
            ? err.message
            : t("communities.settings.failed"),
        );
      }
    } finally {
      setSaving(false);
    }
  }

  const remaining = COMMUNITY_TAGLINE_MAX_LENGTH - tagline.trim().length;
  const dirty =
    settings !== null &&
    (listed !== settings.isCommunity ||
      (tagline.trim() || null) !== settings.tagline ||
      category !== settings.category ||
      (slug.trim() || null) !== settings.slug);

  return (
    <section
      className="space-y-3 border-t border-ink-4 pt-5"
      data-community-settings
    >
      <h3 className="flex items-center gap-2 font-display text-sm font-bold uppercase tracking-wider text-paper-muted">
        <Globe aria-hidden="true" className="h-4 w-4" />
        {t("communities.settings.title")}
      </h3>

      {/* Both paragraphs render whether or not the switch is on. Reading what
          listing means only after you have turned it on is the wrong order. */}
      <p className="text-sm text-paper-muted">
        {t("communities.settings.explainer")}
      </p>
      <p className="text-sm text-paper-muted">
        {t("communities.settings.explainerModeration")}
      </p>

      {settings?.suspended && (
        <p
          role="status"
          className="rounded-md border border-warning/40 bg-warning/5 p-3 text-sm text-paper"
        >
          {t("communities.settings.suspended")}
        </p>
      )}

      {loading ? (
        <p role="status" aria-live="polite" className="text-sm text-paper-muted">
          {t("communities.loading")}
        </p>
      ) : (
        <div className="space-y-3">
          <label className="flex items-center gap-2 text-sm text-paper" htmlFor={toggleId}>
            <input
              id={toggleId}
              type="checkbox"
              checked={listed}
              disabled={saving}
              className="h-4 w-4 rounded border-ink-4 bg-ink accent-signal"
              onChange={(e) => {
                setListed(e.target.checked);
                setSaved(false);
              }}
            />
            {t("communities.settings.toggle")}
          </label>

          <div className="space-y-1">
            <label
              className="block text-xs font-semibold uppercase tracking-wide text-paper-muted"
              htmlFor={taglineId}
            >
              {t("communities.settings.tagline")}
            </label>
            <Input
              id={taglineId}
              value={tagline}
              maxLength={COMMUNITY_TAGLINE_MAX_LENGTH}
              disabled={saving}
              placeholder={t("communities.settings.taglinePlaceholder")}
              onChange={(e) => {
                setTagline(e.target.value);
                setSaved(false);
              }}
            />
            <p className="text-xs tabular-nums text-paper-muted">
              {t("communities.settings.taglineHint", { count: remaining })}
            </p>
          </div>

          <div className="space-y-1">
            <label
              className="block text-xs font-semibold uppercase tracking-wide text-paper-muted"
              htmlFor={categoryId}
            >
              {t("communities.settings.category")}
            </label>
            <select
              id={categoryId}
              value={category}
              disabled={saving}
              className="h-10 w-full rounded-md border border-ink-4 bg-ink px-3 text-sm text-paper focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-signal/50 disabled:opacity-50"
              onChange={(e) => {
                setCategory(e.target.value as CommunityCategory);
                setSaved(false);
              }}
            >
              {COMMUNITY_CATEGORIES.map((slug) => (
                <option key={slug} value={slug}>
                  {t(`communities.category.${slug}` as never)}
                </option>
              ))}
            </select>
          </div>

          {/* The public address. Rendered as the URL it becomes, prefix and
              all, rather than as a bare text field labelled "slug": the owner
              is choosing the thing they will paste into a group chat, and the
              only honest way to show that is to show the whole string. Same
              construction the handle field in Settings → Profile uses. */}
          <div className="space-y-1">
            <label
              className="block text-xs font-semibold uppercase tracking-wide text-paper-muted"
              htmlFor={slugId}
            >
              {t("communities.settings.slug")}
            </label>
            <div className="flex items-stretch rounded-md border border-ink-4 bg-ink focus-within:ring-2 focus-within:ring-signal/50">
              <span className="flex select-none items-center pl-3 font-mono text-sm text-paper-muted">
                pqp.gg/c/
              </span>
              <input
                id={slugId}
                value={slug}
                maxLength={COMMUNITY_SLUG_MAX_LENGTH}
                autoComplete="off"
                autoCapitalize="none"
                spellCheck={false}
                disabled={saving}
                placeholder={t("communities.settings.slugPlaceholder")}
                // Slugified on every keystroke rather than validated on blur.
                // The server slugifies the body anyway, so a field that let
                // somebody type "Valorant Brasil" and then silently stored
                // something else would be lying about what it holds; this way
                // the box always shows the address that will exist.
                onChange={(e) => {
                  setSlug(slugifyCommunityName(e.target.value));
                  setSaved(false);
                  setSlugError(null);
                }}
                className="min-w-0 flex-1 bg-transparent px-1 py-2 font-mono text-sm text-paper outline-none placeholder:text-paper-muted/60 disabled:opacity-50"
              />
            </div>
            <p className="text-xs text-paper-muted">
              {t("communities.settings.slugHint")}
            </p>
            {slugError && (
              <p role="alert" className="text-xs text-danger">
                {slugError}
              </p>
            )}
          </div>

          <Button disabled={saving || !dirty} onClick={() => void save()}>
            {saving
              ? t("communities.settings.saving")
              : t("communities.settings.save")}
          </Button>

          <p role="status" aria-live="polite" className="text-xs text-paper-muted">
            {saved ? t("communities.settings.saved") : ""}
          </p>
        </div>
      )}

      {error && (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      )}
    </section>
  );
}

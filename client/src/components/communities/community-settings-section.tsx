import {
  COMMUNITY_ABOUT_MAX_LENGTH,
  COMMUNITY_CATEGORIES,
  COMMUNITY_LANGUAGES,
  COMMUNITY_LINKS_MAX,
  COMMUNITY_SLUG_MAX_LENGTH,
  COMMUNITY_TAGLINE_MAX_LENGTH,
  DEFAULT_COMMUNITY_LANGUAGE,
  parseCommunityFeaturedEmbed,
  parseCommunityLink,
  publicCommunityPath,
  slugifyCommunityName,
  type CommunityCategory,
  type CommunityLanguage,
  type CommunitySettings,
  type Server,
} from "@pqp/shared";
import { Globe } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  ApiError,
  fetchCommunitySettings,
  fetchServerImageConfig,
  updateCommunitySettings,
} from "@/lib/api";
import { uploadServerImage } from "@/lib/server-image-upload";
import { useTranslation } from "@/lib/i18n";

/**
 * The two public switches, inside Server settings.
 *
 * TWO SWITCHES, AND THE COPY IS WHAT MAKES THEM TWO THINGS.
 *
 *   Endereço público  the page at `pqp.gg/c/<slug>`. Whoever gets the link
 *                     reads the poster and walks in with one tap. Nobody finds
 *                     the room without being sent it.
 *   Diretório         the step on top: every signed-in account can find the
 *                     room by browsing or searching, having been sent nothing.
 *
 * Each switch carries its consequence in the line directly under it, in the
 * present tense, rather than in a paragraph above both or a tooltip beside one.
 * The directory switch is disabled until the address is on and says why, so the
 * dependency is visible before it is hit rather than as a refusal afterwards.
 *
 * THE COPY IS THE FEATURE HERE. Listing a server is the most consequential
 * thing an owner can do to it — the room stops being private and strangers can
 * walk in without an invite and without anyone approving them — and an owner who
 * did not understand that is an owner who will be surprised by their own member
 * list.
 *
 * The second paragraph is the half people forget to write: it is a public
 * surface now, so reports about it go to whoever runs the instance, and they can
 * pull the listing. Saying that up front is both honest and the thing that makes
 * a suspension later feel like a rule rather than an ambush.
 *
 * WHO SEES IT. Anyone with Manage Server, because the public address lives here
 * and the people who hand out a community's link are its moderators as often as
 * its owner. The directory switch is the owner's alone: `canListPublicly` is
 * false for everybody else, and the server enforces the same split
 * independently (see the PATCH handler in api/index.ts).
 *
 * A NON-OWNER GETS A DISABLED SWITCH AND A SENTENCE, not a hidden control.
 * Hiding it would leave an admin unable to see whether the room is listed at
 * all, which is the first thing you need to know before you edit its page; and
 * a greyed box with no explanation is the shape of a bug rather than of a rule.
 * The address switch is disabled for them too while the room is IN the
 * directory, because turning it off there would take the listing down sideways
 * — the server refuses exactly that, and the line under the switch says so.
 */
export function CommunitySettingsSection({
  serverId,
  canListPublicly,
  onIdentitySaved,
}: {
  serverId: string;
  /** True only for the server's owner. */
  canListPublicly: boolean;
  onIdentitySaved?: (patch: Partial<Server>) => void;
}) {
  const { t } = useTranslation();
  const [settings, setSettings] = useState<CommunitySettings | null>(null);
  const [tagline, setTagline] = useState("");
  const [about, setAbout] = useState("");
  const [linkUrls, setLinkUrls] = useState<string[]>([]);
  const [featuredUrl, setFeaturedUrl] = useState("");
  const [featuredImage, setFeaturedImage] = useState(false);
  const [uploadsOn, setUploadsOn] = useState(false);
  const [featuredBusy, setFeaturedBusy] = useState(false);
  const featuredFileRef = useRef<HTMLInputElement>(null);
  const [category, setCategory] = useState<CommunityCategory>("geral");
  const [slug, setSlug] = useState("");
  const [language, setLanguage] = useState<CommunityLanguage>(
    DEFAULT_COMMUNITY_LANGUAGE,
  );
  /** The public address at `pqp.gg/c/<slug>` — `isCommunity` on the wire. */
  const [addressed, setAddressed] = useState(false);
  /** The directory. Owner-only, and impossible without an address. */
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
   * being explicit about it: 409 and 422 always mean the address. A 400
   * whose message is "address cannot be used" does too. About, links, and
   * featured 400s stay on the form error, not this box.
   */
  const [slugError, setSlugError] = useState<string | null>(null);
  const addressToggleId = useId();
  const toggleId = useId();
  const taglineId = useId();
  const aboutId = useId();
  const linksId = useId();
  const featuredId = useId();
  const categoryId = useId();
  const slugId = useId();
  const languageId = useId();
  const formBusy = saving || featuredBusy;

  function applySettings(next: CommunitySettings) {
    setSettings(next);
    setAddressed(next.isCommunity);
    setListed(next.isListed);
    setTagline(next.tagline ?? "");
    setAbout(next.about ?? "");
    setLinkUrls(next.links.map((link) => link.url));
    if (next.featured?.kind === "image") {
      setFeaturedUrl("");
      setFeaturedImage(true);
    } else {
      setFeaturedUrl(next.featured?.url ?? "");
      setFeaturedImage(false);
    }
    setCategory(next.category);
    setSlug(next.slug ?? "");
    setLanguage(next.language);
  }

  useEffect(() => {
    let cancelled = false;
    void fetchServerImageConfig()
      .then((config) => {
        if (!cancelled) {
          setUploadsOn(config.enabled);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setUploadsOn(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    fetchCommunitySettings(serverId)
      .then((res) => {
        if (cancelled) {
          return;
        }
        applySettings(res.community);
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
    const preparedLinks = linkUrls.map((url) => url.trim()).filter(Boolean);
    if (preparedLinks.length > COMMUNITY_LINKS_MAX) {
      setError(t("communities.settings.linksInvalid"));
      setSaving(false);
      return;
    }
    for (const url of preparedLinks) {
      if (!parseCommunityLink(url)) {
        setError(t("communities.settings.linksInvalid"));
        setSaving(false);
        return;
      }
    }
    const trimmedFeatured = featuredUrl.trim();
    let featured:
      | { kind: "youtube" | "twitch"; url: string }
      | null
      | undefined;
    if (trimmedFeatured) {
      const parsed = parseCommunityFeaturedEmbed(trimmedFeatured);
      if (!parsed) {
        setError(t("communities.settings.featuredInvalid"));
        setSaving(false);
        return;
      }
      featured = parsed;
    } else if (settings?.featured && settings.featured.kind !== "image") {
      featured = null;
    }
    try {
      const res = await updateCommunitySettings(serverId, {
        isCommunity: addressed,
        ...(canListPublicly ? { isListed: listed } : {}),
        tagline: tagline.trim() === "" ? null : tagline.trim(),
        about: about.trim() === "" ? null : about.trim(),
        links: preparedLinks.map((url) => ({ url })),
        ...(featured !== undefined ? { featured } : {}),
        category,
        ...(typedSlug ? { slug: typedSlug } : {}),
        language,
      });
      applySettings(res.community);
      onIdentitySaved?.({
        isCommunity: res.community.isCommunity,
        communityTagline: res.community.tagline,
        communityAbout: res.community.about,
        communityLinks: res.community.links,
        communitySlug: res.community.slug,
      });
      setSaved(true);
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        setSlugError(t("communities.settings.slugTaken"));
      } else if (err instanceof ApiError && err.status === 422) {
        setSlugError(t("communities.settings.slugUnderivable"));
      } else if (
        err instanceof ApiError &&
        err.status === 400 &&
        /address cannot be used/i.test(err.message)
      ) {
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

  async function uploadFeatured(file: File) {
    setFeaturedBusy(true);
    setError(null);
    try {
      await uploadServerImage(serverId, "featured", file);
      setFeaturedImage(true);
      setFeaturedUrl("");
      setSaved(true);
      try {
        const res = await fetchCommunitySettings(serverId);
        applySettings(res.community);
        onIdentitySaved?.({
          isCommunity: res.community.isCommunity,
          communityTagline: res.community.tagline,
          communityAbout: res.community.about,
          communityLinks: res.community.links,
          communitySlug: res.community.slug,
        });
      } catch {
        setError(t("communities.settings.featuredRefreshFailed"));
      }
    } catch (err) {
      setError(
        err instanceof ApiError || err instanceof Error
          ? err.message
          : t("communities.settings.failed"),
      );
    } finally {
      setFeaturedBusy(false);
    }
  }

  async function clearFeatured() {
    setFeaturedBusy(true);
    setError(null);
    try {
      const res = await updateCommunitySettings(serverId, { featured: null });
      applySettings(res.community);
      onIdentitySaved?.({
        isCommunity: res.community.isCommunity,
        communityTagline: res.community.tagline,
        communityAbout: res.community.about,
        communityLinks: res.community.links,
        communitySlug: res.community.slug,
      });
      setSaved(true);
    } catch (err) {
      setError(
        err instanceof ApiError || err instanceof Error
          ? err.message
          : t("communities.settings.failed"),
      );
    } finally {
      setFeaturedBusy(false);
    }
  }

  const remaining = COMMUNITY_TAGLINE_MAX_LENGTH - tagline.trim().length;
  const aboutRemaining = COMMUNITY_ABOUT_MAX_LENGTH - about.trim().length;
  /**
   * The address cannot be turned off by a non-owner while the room is listed:
   * that write would take the listing down with it, and the server refuses it.
   * Disabled here rather than left to fail, with the reason in the line below.
   */
  const addressLocked = !canListPublicly && settings?.isListed === true;
  const currentEmbed =
    settings?.featured && settings.featured.kind !== "image"
      ? settings.featured.url
      : "";
  const dirty =
    settings !== null &&
    (addressed !== settings.isCommunity ||
      (canListPublicly && listed !== settings.isListed) ||
      (tagline.trim() || null) !== settings.tagline ||
      (about.trim() || null) !== settings.about ||
      JSON.stringify(linkUrls.map((url) => url.trim()).filter(Boolean)) !==
        JSON.stringify(settings.links.map((link) => link.url)) ||
      featuredUrl.trim() !== currentEmbed ||
      category !== settings.category ||
      (slug.trim() || null) !== settings.slug ||
      language !== settings.language);

  return (
    <section
      className="space-y-3 border-t border-ink-4 pt-5"
      data-community-settings
    >
      <h3 className="flex items-center gap-2 font-display text-sm font-bold uppercase tracking-wider text-paper-muted">
        <Globe aria-hidden="true" className="h-4 w-4" />
        {t("communities.settings.title")}
      </h3>

      {/* Both paragraphs render whether or not either switch is on. Reading
          what the two mean only after you have ticked one is the wrong order. */}
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
          {/* Switch one: the address. Its consequence sits directly under it,
              because "who can now do what" is the only thing anybody is asking
              when their hand is on the box. */}
          <div className="space-y-1">
            <label
              className="flex items-center gap-2 text-sm text-paper"
              htmlFor={addressToggleId}
            >
              <input
                id={addressToggleId}
                type="checkbox"
                checked={addressed}
                disabled={formBusy || addressLocked}
                className="h-4 w-4 rounded border-ink-4 bg-ink accent-signal disabled:opacity-50"
                onChange={(e) => {
                  setAddressed(e.target.checked);
                  // Turning the address off takes the listing with it, which is
                  // what the server does anyway. Showing it here keeps the form
                  // from claiming a listing that the save is about to remove.
                  if (!e.target.checked) {
                    setListed(false);
                  }
                  setSaved(false);
                }}
              />
              {t("communities.settings.addressToggle")}
            </label>
            <p className="pl-6 text-xs text-paper-muted">
              {t("communities.settings.addressHint")}
            </p>
            {addressLocked && (
              <p className="pl-6 text-xs text-paper-muted">
                {t("communities.settings.addressLockedByListing")}
              </p>
            )}
          </div>

          {/* Switch two: the directory. Disabled until the address is on, and
              saying which of the two reasons applies — an owner with no address
              yet, and an admin, are stopped by different rules and a single
              greyed box would tell neither of them which. */}
          <div className="space-y-1">
            <label
              className="flex items-center gap-2 text-sm text-paper"
              htmlFor={toggleId}
            >
              <input
                id={toggleId}
                type="checkbox"
                checked={listed}
                disabled={formBusy || !canListPublicly || !addressed}
                className="h-4 w-4 rounded border-ink-4 bg-ink accent-signal disabled:opacity-50"
                onChange={(e) => {
                  setListed(e.target.checked);
                  setSaved(false);
                }}
              />
              {t("communities.settings.toggle")}
            </label>
            <p className="pl-6 text-xs text-paper-muted">
              {t("communities.settings.toggleHint")}
            </p>
            {!canListPublicly ? (
              <p className="pl-6 text-xs text-paper-muted">
                {t("communities.settings.listingOwnerOnly")}
              </p>
            ) : (
              !addressed && (
                <p className="pl-6 text-xs text-paper-muted">
                  {t("communities.settings.listingNeedsAddress")}
                </p>
              )
            )}
          </div>

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
              disabled={formBusy}
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
              htmlFor={aboutId}
            >
              {t("communities.settings.about")}
            </label>
            <textarea
              id={aboutId}
              value={about}
              maxLength={COMMUNITY_ABOUT_MAX_LENGTH}
              disabled={formBusy}
              rows={5}
              placeholder={t("communities.settings.aboutPlaceholder")}
              onChange={(e) => {
                setAbout(e.target.value);
                setSaved(false);
              }}
              className="w-full rounded-md border border-ink-4 bg-ink px-3 py-2 text-sm text-paper focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-signal/50 disabled:opacity-50"
            />
            <p className="text-xs tabular-nums text-paper-muted">
              {t("communities.settings.aboutHint", { count: aboutRemaining })}
            </p>
          </div>

          <div className="space-y-2">
            <p
              className="text-xs font-semibold uppercase tracking-wide text-paper-muted"
              id={linksId}
            >
              {t("communities.settings.links")}
            </p>
            <p className="text-xs text-paper-muted">
              {t("communities.settings.linksHint")}
            </p>
            <ul className="space-y-2" aria-labelledby={linksId}>
              {linkUrls.map((url, index) => (
                <li key={index} className="flex gap-2">
                  <Input
                    value={url}
                    disabled={formBusy}
                    placeholder={t("communities.settings.linksPlaceholder")}
                    onChange={(e) => {
                      const next = [...linkUrls];
                      next[index] = e.target.value;
                      setLinkUrls(next);
                      setSaved(false);
                    }}
                  />
                  <Button
                    type="button"
                    variant="secondary"
                    disabled={formBusy}
                    onClick={() => {
                      setLinkUrls(linkUrls.filter((_, i) => i !== index));
                      setSaved(false);
                    }}
                  >
                    {t("communities.settings.linksRemove")}
                  </Button>
                </li>
              ))}
            </ul>
            {linkUrls.length < COMMUNITY_LINKS_MAX && (
              <Button
                type="button"
                variant="secondary"
                disabled={formBusy}
                onClick={() => {
                  setLinkUrls([...linkUrls, ""]);
                  setSaved(false);
                }}
              >
                {t("communities.settings.linksAdd")}
              </Button>
            )}
          </div>

          <div className="space-y-2">
            <label
              className="block text-xs font-semibold uppercase tracking-wide text-paper-muted"
              htmlFor={featuredId}
            >
              {t("communities.settings.featured")}
            </label>
            <p className="text-xs text-paper-muted">
              {t("communities.settings.featuredHint")}
            </p>
            <Input
              id={featuredId}
              value={featuredUrl}
              disabled={formBusy}
              placeholder={t("communities.settings.featuredPlaceholder")}
              onChange={(e) => {
                setFeaturedUrl(e.target.value);
                setSaved(false);
              }}
            />
            <div className="flex flex-wrap gap-2">
              {uploadsOn && (
                <>
                  <input
                    ref={featuredFileRef}
                    type="file"
                    accept="image/jpeg,image/png,image/webp"
                    className="hidden"
                    onChange={(e) => {
                      const file = e.target.files?.[0];
                      e.target.value = "";
                      if (file) {
                        void uploadFeatured(file);
                      }
                    }}
                  />
                  <Button
                    type="button"
                    variant="secondary"
                    disabled={formBusy}
                    onClick={() => featuredFileRef.current?.click()}
                  >
                    {t("communities.settings.featuredUpload")}
                  </Button>
                </>
              )}
              {(featuredImage || featuredUrl || settings?.featured) && (
                <Button
                  type="button"
                  variant="secondary"
                  disabled={formBusy}
                  onClick={() => void clearFeatured()}
                >
                  {t("communities.settings.featuredRemove")}
                </Button>
              )}
            </div>
            {featuredImage && (
              <p className="text-xs text-paper-muted">
                {t("communities.settings.featuredImageSet")}
              </p>
            )}
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
              disabled={formBusy}
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
                disabled={formBusy}
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

          {/* Language sits under the category because it is the narrower of the
              two decisions and reads as one: this room is about X, held in Y.
              A select rather than a segment here — this is a form, and it
              matches the control directly above it. */}
          <div className="space-y-1">
            <label
              className="block text-xs font-semibold uppercase tracking-wide text-paper-muted"
              htmlFor={languageId}
            >
              {t("communities.settings.language")}
            </label>
            <select
              id={languageId}
              value={language}
              disabled={formBusy}
              className="h-10 w-full rounded-md border border-ink-4 bg-ink px-3 text-sm text-paper focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-signal/50 disabled:opacity-50"
              onChange={(e) => {
                setLanguage(e.target.value as CommunityLanguage);
                setSaved(false);
              }}
            >
              {COMMUNITY_LANGUAGES.map((code) => (
                <option key={code} value={code}>
                  {t(`communities.language.${code}` as never)}
                </option>
              ))}
            </select>
          </div>

          <div className="flex flex-wrap gap-2">
            <Button disabled={formBusy || !dirty} onClick={() => void save()}>
              {saving
                ? t("communities.settings.saving")
                : t("communities.settings.save")}
            </Button>
            {addressed && slug.trim() && (
              <Button asChild variant="secondary">
                <a
                  href={publicCommunityPath(slug.trim())}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  {t("communities.settings.preview")}
                </a>
              </Button>
            )}
          </div>

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

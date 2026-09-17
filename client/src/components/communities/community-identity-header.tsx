import {
  COMMUNITY_ABOUT_MAX_LENGTH,
  COMMUNITY_LINKS_MAX,
  COMMUNITY_TAGLINE_MAX_LENGTH,
  MAX_SERVER_BANNER_BYTES,
  MAX_SERVER_ICON_BYTES,
  SERVER_BANNER_HEIGHT,
  SERVER_BANNER_WIDTH,
  SERVER_ICON_SIZE,
  SERVER_IMAGE_MIME_ALLOWLIST,
  type CommunityLink,
  type Server,
} from "@pqp/shared";
import { publicCommunityDisplayUrl } from "@pqp/shared";
import { Camera, ImagePlus, Pencil, Plus, X } from "lucide-react";
import { useId, useRef, type ReactNode } from "react";
import { CommunityAboutText } from "@/components/communities/community-about-text";
import { HeroMosaic } from "@/components/communities/hero-mosaic";
import { CommunityOfficialLinks } from "@/components/communities/community-official-links";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { resolveUploadedImageUrl } from "@/lib/avatar";
import { heroHue, heroTintStyle, initialsFor } from "@/lib/hero-tint";
import { useTranslation } from "@/lib/i18n";
import { cn } from "@/lib/utils";

export type CommunityIdentityDraft = {
  tagline: string;
  about: string;
  linkUrls: string[];
};

export type CommunityIdentityEdit = {
  draft: CommunityIdentityDraft;
  saving: boolean;
  uploadsEnabled: boolean;
  imageBusy: "icon" | "banner" | "remove-icon" | "remove-banner" | null;
  onChange: (patch: Partial<CommunityIdentityDraft>) => void;
  onPickImage: (kind: "icon" | "banner", file: File) => void;
  onRemoveImage: (kind: "icon" | "banner") => void;
  onError: (message: string) => void;
};

const BANNER_MB = Math.round(MAX_SERVER_BANNER_BYTES / (1024 * 1024));
const ICON_MB = Math.round(MAX_SERVER_ICON_BYTES / (1024 * 1024));

/**
 * The community's identity at the top of Overview, above the Baú feed.
 *
 * A POSTER, NOT A CAPTION. The banner is full-bleed on the pane, the way a
 * Patreon creator page opens: one cover that owns the width, a large icon
 * overlapping its foot, the name as a title. With no posts the about stays
 * here. With posts the header compresses and about moves beside the feed.
 *
 * STAFF EDIT MODE. Owners and anyone with Manage Server can edit the page
 * in place: cover, icon, tagline, about, official links. Pictures apply as
 * soon as they are picked. The rest waits for Save on the feed chrome.
 * Directory switches, slug and featured stay in Server settings. The editor
 * keeps the poster visible (live preview) and puts labeled fields plus the
 * crop sizes under it, so staff are not guessing at a ghost input.
 *
 * TWO SCALES. With no posts yet this is the page, so the type and the banner
 * stay large and about plus official links live here. Once the feed has
 * cards, the same band compresses (name, address, tagline) and about plus
 * links move beside the feed so they stay sticky. The feed does not keep a
 * Discord channel header above this poster: staff actions sit on the cover.
 */
export function CommunityIdentityHeader({
  server,
  layout = "poster",
  feedAvailable = true,
  canManageServer = false,
  onOpenServerSettings,
  onStartEdit,
  edit,
  bannerStart,
  bannerEnd,
}: {
  server: Pick<
    Server,
    | "name"
    | "iconUrl"
    | "bannerUrl"
    | "communityTagline"
    | "communityAbout"
    | "communityLinks"
    | "communitySlug"
  >;
  layout?: "poster" | "compact";
  feedAvailable?: boolean;
  canManageServer?: boolean;
  onOpenServerSettings?: () => void;
  onStartEdit?: () => void;
  edit?: CommunityIdentityEdit;
  /** Mobile drawer mark, sitting on the cover. Absent while editing. */
  bannerStart?: ReactNode;
  /** Staff compose / overflow, sitting on the cover next to Edit page. */
  bannerEnd?: ReactNode;
}) {
  const { t } = useTranslation();
  const editing = Boolean(edit);
  const poster = layout === "poster" || editing;
  const hue = heroHue(server.communitySlug ?? server.name);
  const bannerUrl = resolveUploadedImageUrl(server.bannerUrl);
  const iconUrl = resolveUploadedImageUrl(server.iconUrl);
  const url = server.communitySlug
    ? publicCommunityDisplayUrl(server.communitySlug)
    : null;
  const showTurnOn =
    canManageServer &&
    !feedAvailable &&
    !editing &&
    Boolean(onOpenServerSettings);
  const showEdit = canManageServer && !editing && Boolean(onStartEdit);
  const taglineId = useId();
  const aboutId = useId();
  const linksId = useId();
  const tagline = editing ? edit!.draft.tagline : (server.communityTagline ?? "");
  const about = editing ? edit!.draft.about : (server.communityAbout ?? "");
  const links = server.communityLinks ?? [];
  const busy = Boolean(edit?.imageBusy || edit?.saving);

  return (
    <section
      className="animate-rise"
      data-community-identity-header
      data-identity-layout={poster ? "poster" : layout}
      data-identity-editing={editing ? "1" : "0"}
    >
      <div
        className={cn(
          "relative w-full overflow-hidden",
          poster ? "h-40 sm:h-52" : "h-32 sm:h-44",
        )}
        data-identity-banner
      >
        {bannerUrl ? (
          <img
            src={bannerUrl}
            alt=""
            className="h-full w-full object-cover"
            decoding="async"
          />
        ) : (
          <HeroMosaic hue={hue} />
        )}
        <span
          aria-hidden
          className="absolute inset-0 bg-[image:var(--scrim-hero)]"
        />
        {!editing && (bannerStart || bannerEnd || showEdit) && (
          <div className="absolute inset-x-0 top-0 z-10 flex items-start justify-between gap-2 p-4">
            <div className="flex items-center gap-2">{bannerStart}</div>
            <div className="flex flex-wrap items-center justify-end gap-2">
              {bannerEnd}
              {showEdit && (
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  className="rounded-full"
                  onClick={onStartEdit}
                  data-identity-edit-start
                >
                  <Pencil className="h-3.5 w-3.5" aria-hidden />
                  {t("communityHome.identity.edit")}
                </Button>
              )}
            </div>
          </div>
        )}
        {edit && (
          <CoverEditor
            hasImage={Boolean(bannerUrl)}
            busy={busy}
            uploading={edit.imageBusy === "banner"}
            uploadsEnabled={edit.uploadsEnabled}
            removing={edit.imageBusy === "remove-banner"}
            onPick={(file) => edit.onPickImage("banner", file)}
            onRemove={() => edit.onRemoveImage("banner")}
          />
        )}
      </div>

      <div className={cn("px-5 sm:px-8", poster ? "pb-8" : "pb-5")}>
        <div className="mx-auto max-w-5xl">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:gap-5">
          <span
            aria-hidden={!editing}
            className={cn(
              "relative flex shrink-0 items-center justify-center rounded-3xl font-display font-bold text-text shadow-[var(--shadow-hero-avatar)] ring-4 ring-surface-0",
              poster
                ? "-mt-12 h-24 w-24 text-2xl sm:-mt-16 sm:h-28 sm:w-28"
                : "-mt-8 h-16 w-16 text-lg sm:-mt-10 sm:h-20 sm:w-20",
            )}
            data-identity-icon
          >
              <span
                className="absolute inset-0 overflow-hidden rounded-3xl"
                style={iconUrl ? undefined : heroTintStyle(hue, 60)}
              >
                {iconUrl ? (
                  <img
                    src={iconUrl}
                    alt=""
                    className="h-full w-full object-cover"
                    decoding="async"
                  />
                ) : (
                  <span className="flex h-full w-full items-center justify-center">
                    {initialsFor(server.name)}
                  </span>
                )}
              </span>
              {edit && edit.uploadsEnabled && (
                <IconEditor
                  hasImage={Boolean(iconUrl)}
                  busy={busy}
                  removing={edit.imageBusy === "remove-icon"}
                  onPick={(file) => edit.onPickImage("icon", file)}
                  onRemove={() => edit.onRemoveImage("icon")}
                />
              )}
            </span>
          <div className="min-w-0 flex-1 sm:pb-0.5">
            <h1
              className={cn(
                "min-w-0 font-display font-extrabold leading-tight tracking-tight text-text",
                poster ? "text-3xl sm:text-4xl" : "text-2xl",
              )}
            >
              {server.name}
            </h1>
            {url && (
              <p
                className="mt-1 truncate font-mono text-sm text-accent"
                data-identity-url
              >
                {url}
              </p>
            )}
            {!edit && server.communityTagline && (
              <p
                className={cn(
                  "mt-2 leading-snug text-text-secondary",
                  poster ? "text-lg" : "text-sm",
                )}
                data-identity-tagline
              >
                {server.communityTagline}
              </p>
            )}
          </div>
          {showTurnOn && (
            <Button
              className="cta-lift h-11 w-full shrink-0 rounded-full sm:w-auto"
              onClick={onOpenServerSettings}
              data-identity-turn-on
            >
              {t("communityHome.identity.turnOn")}
            </Button>
          )}
        </div>

        {edit ? (
          <div
            className="mt-6 space-y-6 rounded-[var(--radius-panel)] border border-border bg-surface-1 p-5 sm:p-6"
            data-identity-band
          >
            {edit.uploadsEnabled && (
              <p
                className="text-sm leading-6 text-text-secondary"
                data-identity-photos-note
              >
                {t("communityHome.identity.photosLive")}
              </p>
            )}
            <ul className="space-y-1 text-xs leading-5 text-text-tertiary">
              <li data-identity-cover-hint>
                {t("communityHome.identity.coverHint", {
                  width: SERVER_BANNER_WIDTH,
                  height: SERVER_BANNER_HEIGHT,
                  mb: BANNER_MB,
                })}
              </li>
              <li data-identity-icon-hint>
                {t("communityHome.identity.iconHint", {
                  size: SERVER_ICON_SIZE,
                  mb: ICON_MB,
                })}
              </li>
            </ul>

            <div>
              <FieldHead
                htmlFor={taglineId}
                label={t("communities.settings.tagline")}
                remaining={COMMUNITY_TAGLINE_MAX_LENGTH - tagline.trim().length}
                remainingKey="communities.settings.taglineHint"
              />
              <p className="mb-2 text-xs leading-5 text-text-tertiary">
                {t("communityHome.identity.taglineHelp")}
              </p>
              <Input
                id={taglineId}
                value={tagline}
                maxLength={COMMUNITY_TAGLINE_MAX_LENGTH}
                disabled={edit.saving}
                placeholder={t("communityHome.identity.taglinePlaceholder")}
                onChange={(event) =>
                  edit.onChange({ tagline: event.target.value })
                }
                data-identity-tagline-input
              />
            </div>

            <div>
              <FieldHead
                htmlFor={aboutId}
                label={t("communityHome.identity.about")}
                remaining={COMMUNITY_ABOUT_MAX_LENGTH - about.trim().length}
                remainingKey="communities.settings.aboutHint"
              />
              <p className="mb-2 text-xs leading-5 text-text-tertiary">
                {t("communityHome.identity.aboutHelp")}
              </p>
              <textarea
                id={aboutId}
                value={about}
                maxLength={COMMUNITY_ABOUT_MAX_LENGTH}
                disabled={edit.saving}
                rows={7}
                placeholder={t("communityHome.identity.aboutPlaceholder")}
                onChange={(event) =>
                  edit.onChange({ about: event.target.value })
                }
                className="flex min-h-40 w-full resize-y rounded-[var(--radius-control)] border border-border bg-surface-0 px-3 py-2.5 text-sm leading-6 text-text placeholder:text-text-tertiary/70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-offset-ring-offset focus-visible:ring-focus-ring disabled:cursor-not-allowed disabled:opacity-50"
                data-identity-about-input
              />
            </div>

            <div>
              <p
                className="text-sm font-semibold text-text"
                id={linksId}
              >
                {t("communities.settings.links")}
              </p>
              <p className="mb-3 mt-1 text-xs leading-5 text-text-tertiary">
                {t("communities.settings.linksHint")}
              </p>
              <ul className="space-y-2" aria-labelledby={linksId} data-identity-links-edit>
                {edit.draft.linkUrls.map((linkUrl, index) => (
                  <li key={index} className="flex items-center gap-2">
                    <Input
                      value={linkUrl}
                      disabled={edit.saving}
                      placeholder={t("communityHome.identity.linksPlaceholder")}
                      onChange={(event) => {
                        const next = [...edit.draft.linkUrls];
                        next[index] = event.target.value;
                        edit.onChange({ linkUrls: next });
                      }}
                    />
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      className="shrink-0"
                      disabled={edit.saving}
                      aria-label={t("communityHome.identity.linksRemove")}
                      onClick={() =>
                        edit.onChange({
                          linkUrls: edit.draft.linkUrls.filter(
                            (_, item) => item !== index,
                          ),
                        })
                      }
                    >
                      <X className="h-4 w-4" aria-hidden />
                    </Button>
                  </li>
                ))}
              </ul>
              {edit.draft.linkUrls.length < COMMUNITY_LINKS_MAX && (
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  className="mt-3"
                  disabled={edit.saving}
                  onClick={() =>
                    edit.onChange({
                      linkUrls: [...edit.draft.linkUrls, ""],
                    })
                  }
                  data-identity-links-add
                >
                  <Plus className="h-3.5 w-3.5" aria-hidden />
                  {t("communityHome.identity.linksAdd")}
                </Button>
              )}
            </div>
          </div>
        ) : (
          poster &&
          Boolean(server.communityAbout || links.length > 0) && (
            <div className="mt-6 max-w-3xl" data-identity-band>
              {server.communityAbout && (
                <CommunityAboutText
                  about={server.communityAbout}
                  lines={8}
                />
              )}
              {links.length > 0 && (
                <CommunityOfficialLinks
                  links={links}
                  className={server.communityAbout ? "mt-5" : undefined}
                />
              )}
            </div>
          )
        )}
        </div>
      </div>
    </section>
  );
}

/**
 * About and official links beside (or under) the feed. Sticky on large
 * screens so the pills stay in reach while the cards scroll.
 */
export function CommunityIdentityRail({
  about,
  links,
  aboutLines,
  showAboutLabel = true,
}: {
  about: string | null;
  links: readonly CommunityLink[];
  aboutLines: 3 | 8;
  showAboutLabel?: boolean;
}) {
  const { t } = useTranslation();
  if (!about && links.length === 0) {
    return null;
  }
  return (
    <>
      {about && (
        <>
          {showAboutLabel && (
            <p className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-text-tertiary">
              {t("communityHome.identity.about")}
            </p>
          )}
          <CommunityAboutText about={about} lines={aboutLines} />
        </>
      )}
      <CommunityOfficialLinks
        links={links}
        className={about ? "mt-5" : undefined}
      />
    </>
  );
}

function FieldHead({
  htmlFor,
  label,
  remaining,
  remainingKey,
}: {
  htmlFor: string;
  label: string;
  remaining: number;
  remainingKey: "communities.settings.taglineHint" | "communities.settings.aboutHint";
}) {
  const { t } = useTranslation();
  return (
    <div className="mb-1 flex items-baseline justify-between gap-3">
      <label className="text-sm font-semibold text-text" htmlFor={htmlFor}>
        {label}
      </label>
      <p className="shrink-0 text-xs tabular-nums text-text-tertiary">
        {t(remainingKey, { count: remaining })}
      </p>
    </div>
  );
}

function CoverEditor({
  hasImage,
  busy,
  uploading,
  uploadsEnabled,
  removing,
  onPick,
  onRemove,
}: {
  hasImage: boolean;
  busy: boolean;
  uploading: boolean;
  uploadsEnabled: boolean;
  removing: boolean;
  onPick: (file: File) => void;
  onRemove: () => void;
}) {
  const { t } = useTranslation();
  const fileRef = useRef<HTMLInputElement>(null);

  return (
    <div className="absolute inset-x-0 top-0 z-[2] flex flex-wrap items-start gap-2 p-4">
      {uploadsEnabled ? (
        <>
          <Button
            type="button"
            variant="secondary"
            size="sm"
            className="rounded-full"
            disabled={busy}
            onClick={() => fileRef.current?.click()}
            data-identity-cover-edit
          >
            <ImagePlus className="h-3.5 w-3.5" aria-hidden />
            {uploading
              ? t("serverSettings.identity.uploading")
              : hasImage
                ? t("communityHome.identity.changeCover")
                : t("communityHome.identity.addCover")}
          </Button>
          {hasImage && (
            <Button
              type="button"
              variant="secondary"
              size="sm"
              className="rounded-full"
              disabled={busy}
              onClick={onRemove}
              data-identity-cover-remove
            >
              {removing
                ? t("serverSettings.identity.removing")
                : t("communityHome.identity.removeCover")}
            </Button>
          )}
        </>
      ) : (
        <p className="rounded-full border border-border bg-surface-1 px-3 py-1.5 text-xs text-text-secondary">
          {t("communityHome.identity.uploadsOff")}
        </p>
      )}
      <p
        className="ml-auto rounded-full border border-border bg-surface-1 px-3 py-1.5 text-xs tabular-nums text-text-secondary"
        data-identity-cover-size
      >
        {t("communityHome.identity.coverSize", {
          width: SERVER_BANNER_WIDTH,
          height: SERVER_BANNER_HEIGHT,
        })}
      </p>
      <input
        ref={fileRef}
        type="file"
        accept={SERVER_IMAGE_MIME_ALLOWLIST.join(",")}
        className="hidden"
        aria-hidden
        onChange={(event) => {
          const file = event.target.files?.[0];
          event.target.value = "";
          if (file) {
            onPick(file);
          }
        }}
      />
    </div>
  );
}

function IconEditor({
  hasImage,
  busy,
  removing,
  onPick,
  onRemove,
}: {
  hasImage: boolean;
  busy: boolean;
  removing: boolean;
  onPick: (file: File) => void;
  onRemove: () => void;
}) {
  const { t } = useTranslation();
  const fileRef = useRef<HTMLInputElement>(null);

  return (
    <>
      <button
        type="button"
        disabled={busy}
        className="absolute inset-0 z-[1] flex items-end justify-end rounded-3xl p-1.5 text-text hover:bg-surface-0/25 disabled:opacity-60"
        aria-label={
          hasImage
            ? t("communityHome.identity.changeIcon")
            : t("communityHome.identity.addIcon")
        }
        onClick={() => fileRef.current?.click()}
        data-identity-icon-edit
      >
        <span className="inline-flex h-9 w-9 items-center justify-center rounded-full border border-border bg-surface-1 shadow-[var(--shadow-1)]">
          <Camera className="h-4 w-4" aria-hidden />
        </span>
      </button>
      {hasImage && (
        <button
          type="button"
          disabled={busy}
          className="absolute -right-1 -top-1 z-[2] inline-flex h-7 w-7 items-center justify-center rounded-full border border-border bg-surface-1 text-text hover:text-danger disabled:opacity-60"
          aria-label={
            removing
              ? t("serverSettings.identity.removing")
              : t("communityHome.identity.removeIcon")
          }
          onClick={(event) => {
            event.stopPropagation();
            onRemove();
          }}
          data-identity-icon-remove
        >
          <X className="h-3.5 w-3.5" aria-hidden />
        </button>
      )}
      <input
        ref={fileRef}
        type="file"
        accept={SERVER_IMAGE_MIME_ALLOWLIST.join(",")}
        className="hidden"
        aria-hidden
        onChange={(event) => {
          const file = event.target.files?.[0];
          event.target.value = "";
          if (file) {
            onPick(file);
          }
        }}
      />
    </>
  );
}

import type { CommunityLink, CommunityLinkKind } from "@pqp/shared";
import { Globe } from "lucide-react";
import { ConnectionGlyph } from "@/components/connections/connection-badges";
import { useTranslation, type MessageKey } from "@/lib/i18n";
import { cn } from "@/lib/utils";

const LINK_LABEL: Record<CommunityLinkKind, MessageKey> = {
  youtube: "communities.link.youtube",
  twitch: "communities.link.twitch",
  instagram: "communities.link.instagram",
  tiktok: "communities.link.tiktok",
  x: "communities.link.x",
  site: "communities.link.site",
};

const INSTAGRAM_PATH =
  "M12 2.163c3.204 0 3.584.012 4.85.07 3.252.148 4.771 1.691 4.919 4.919.058 1.265.069 1.645.069 4.849 0 3.205-.012 3.584-.069 4.849-.149 3.225-1.664 4.771-4.919 4.919-1.266.058-1.644.07-4.85.07-3.204 0-3.584-.012-4.849-.07-3.26-.149-4.771-1.699-4.919-4.92-.058-1.265-.07-1.644-.07-4.849 0-3.204.013-3.583.07-4.849.149-3.227 1.664-4.771 4.919-4.919 1.266-.057 1.645-.069 4.849-.069zM12 0C8.741 0 8.333.014 7.053.072 2.695.272.273 2.69.073 7.052.014 8.333 0 8.741 0 12c0 3.259.014 3.668.072 4.948.2 4.358 2.618 6.78 6.98 6.98C8.333 23.986 8.741 24 12 24c3.259 0 3.668-.014 4.948-.072 4.354-.2 6.782-2.618 6.979-6.98.059-1.28.073-1.689.073-4.948 0-3.259-.014-3.667-.072-4.947-.196-4.354-2.617-6.78-6.979-6.98C15.668.014 15.259 0 12 0zm0 5.838a6.162 6.162 0 100 12.324 6.162 6.162 0 000-12.324zM12 16a4 4 0 110-8 4 4 0 010 8zm6.406-11.845a1.44 1.44 0 100 2.881 1.44 1.44 0 000-2.881z";
const TIKTOK_PATH =
  "M12.525.02c1.31-.02 2.61-.01 3.91-.02.08 1.53.63 3.09 1.75 4.17 1.12 1.11 2.7 1.62 4.24 1.79v4.03c-1.44-.05-2.89-.35-4.2-.97-.57-.26-1.1-.59-1.62-.93-.01 2.92.01 5.84-.02 8.75-.08 1.4-.54 2.79-1.35 3.94-1.31 1.92-3.58 3.17-5.91 3.21-1.43.08-2.86-.31-4.08-1.03-2.02-1.19-3.44-3.37-3.65-5.71-.02-.5-.03-1-.01-1.49.18-1.9 1.12-3.72 2.58-4.96 1.66-1.44 3.98-2.13 6.15-1.72.02 1.48-.04 2.96-.04 4.44-.99-.32-2.15-.23-3.02.37-.63.41-1.11 1.04-1.36 1.75-.21.51-.15 1.07-.14 1.61.24 1.64 1.82 3.02 3.5 2.87 1.12-.01 2.19-.66 2.77-1.61.19-.33.4-.67.41-1.06.1-1.79.06-3.57.07-5.36.01-4.03-.01-8.05.02-12.07z";
const X_PATH =
  "M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-4.714-6.231-5.401 6.231H2.744l7.727-8.828L1.254 2.25H8.08l4.253 5.622L18.244 2.25zm-1.161 17.52h1.833L7.084 4.126H5.117z";

function SimpleGlyph({
  path,
  className,
}: {
  path: string;
  className?: string;
}) {
  return (
    <span
      aria-hidden
      className={cn(
        "inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-sm bg-ink-3 p-0.5 text-paper",
        className,
      )}
    >
      <svg viewBox="0 0 24 24" className="h-full w-full" fill="currentColor">
        <path d={path} />
      </svg>
    </span>
  );
}

function LinkGlyph({ kind }: { kind: CommunityLinkKind }) {
  if (kind === "youtube" || kind === "twitch") {
    return <ConnectionGlyph provider={kind} />;
  }
  if (kind === "instagram") {
    return <SimpleGlyph path={INSTAGRAM_PATH} />;
  }
  if (kind === "tiktok") {
    return <SimpleGlyph path={TIKTOK_PATH} />;
  }
  if (kind === "x") {
    return <SimpleGlyph path={X_PATH} />;
  }
  return <Globe aria-hidden className="h-4 w-4 shrink-0 text-text-tertiary" />;
}

export function CommunityOfficialLinks({
  links,
  className,
}: {
  links: readonly CommunityLink[];
  className?: string;
}) {
  const { t } = useTranslation();
  if (links.length === 0) {
    return null;
  }
  return (
    <ul className={cn("flex flex-wrap gap-2", className)} data-community-links>
      {links.map((link) => (
        <li key={link.url}>
          <a
            href={link.url}
            target="_blank"
            rel="noopener noreferrer"
            className="cta-lift inline-flex h-10 items-center gap-2 rounded-full border border-border bg-surface-1 px-3 text-sm text-text transition-colors duration-[var(--duration-fast)] hover:bg-surface-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring"
          >
            <LinkGlyph kind={link.kind} />
            {t(LINK_LABEL[link.kind])}
          </a>
        </li>
      ))}
    </ul>
  );
}

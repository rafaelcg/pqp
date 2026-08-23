import type { ConnectionProvider, VisibleConnection } from "@pqp/shared";
import { useTranslation, type MessageKey } from "@/lib/i18n";
import { cn } from "@/lib/utils";

const PROVIDER_LABEL: Record<ConnectionProvider, MessageKey> = {
  steam: "connections.provider.steam",
  battlenet: "connections.provider.battlenet",
  twitch: "connections.provider.twitch",
};

/** Simple Icons (CC0) paths, 24×24 viewBox. Identifiers, not partner marks. */
const PROVIDER_PATH: Record<ConnectionProvider, string> = {
  steam:
    "M11.979 0C5.678 0 .511 4.86.022 11.037l6.432 2.658c.545-.371 1.203-.59 1.912-.59.063 0 .125.004.188.006l2.861-4.142V8.91c0-2.495 2.028-4.524 4.524-4.524 2.494 0 4.524 2.031 4.524 4.527s-2.03 4.525-4.524 4.525h-.105l-4.076 2.911c0 .052.004.105.004.159 0 1.875-1.515 3.396-3.39 3.396-1.635 0-3.016-1.173-3.331-2.727L.436 15.27C1.862 20.307 6.486 24 11.979 24c6.627 0 11.999-5.373 11.999-12S18.605 0 11.979 0zM7.54 18.21l-1.473-.61c.262.543.714.999 1.314 1.25 1.297.539 2.793-.076 3.332-1.375.263-.63.264-1.319.005-1.949s-.75-1.121-1.377-1.383c-.624-.26-1.29-.249-1.878-.03l1.523.63c.956.4 1.409 1.5 1.009 2.455-.397.957-1.497 1.41-2.454 1.012H7.54zm11.415-9.303c0-1.662-1.353-3.015-3.015-3.015-1.665 0-3.015 1.353-3.015 3.015 0 1.665 1.35 3.015 3.015 3.015 1.663 0 3.015-1.35 3.015-3.015zm-5.273-.005c0-1.252 1.013-2.266 2.265-2.266 1.249 0 2.266 1.014 2.266 2.266 0 1.251-1.017 2.265-2.266 2.265-1.253 0-2.265-1.014-2.265-2.265z",
  battlenet:
    "M18.94 8.296C15.9 6.892 11.534 6 7.426 6.332c.206-1.36.714-2.308 1.548-2.508 1.148-.275 2.4.48 3.594 1.854.782.102 1.71.28 2.355.429C12.747 2.013 9.828-.282 7.607.565c-1.688.644-2.553 2.97-2.448 6.094-2.2.468-3.915 1.3-5.013 2.495-.056.065-.181.227-.137.305.034.058.146-.008.194-.04 1.274-.89 2.904-1.373 5.027-1.676.303 3.333 1.713 7.56 4.055 10.952-1.28.502-2.356.536-2.946-.087-.812-.856-.784-2.318-.19-4.04a26.764 26.764 0 0 1-.807-2.254c-2.459 3.934-2.986 7.61-1.143 9.11 1.402 1.14 3.847.725 6.502-.926 1.505 1.672 3.083 2.74 4.667 3.094.084.015.287.043.332-.034.034-.06-.08-.124-.131-.149-1.408-.657-2.64-1.828-3.964-3.515 2.735-1.929 5.691-5.263 7.457-8.988 1.076.86 1.64 1.773 1.398 2.595-.336 1.131-1.615 1.84-3.403 2.185a27.697 27.697 0 0 1-1.548 1.826c4.634.16 8.08-1.22 8.458-3.565.286-1.786-1.295-3.696-4.053-5.17.696-2.139.832-4.04.346-5.588-.029-.08-.106-.27-.196-.27-.068 0-.067.13-.063.187.135 1.547-.263 3.2-1.062 5.19zm-8.533 9.869c-1.96-3.145-3.09-6.849-3.082-10.594 3.702-.124 7.474.748 10.714 2.627-1.743 3.269-4.385 6.1-7.633 7.966h.001z",
  twitch:
    "M11.571 4.714h1.715v5.143H11.57zm4.715 0H18v5.143h-1.714zM6 0L1.714 4.286v15.428h5.143V24l4.286-4.286h3.428L22.286 12V0zm14.571 11.143l-3.428 3.428h-3.429l-3 3v-3H6.857V1.714h13.714Z",
};

export function ConnectionGlyph({
  provider,
  className,
}: {
  provider: ConnectionProvider;
  className?: string;
}) {
  return (
    <span
      aria-hidden
      className={cn(
        "inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-sm p-0.5",
        provider === "steam" && "bg-[#1b2838] text-[#66c0f4]",
        provider === "battlenet" && "bg-[#148eff] text-white",
        provider === "twitch" && "bg-[#9146ff] text-white",
        className,
      )}
    >
      <svg viewBox="0 0 24 24" className="h-full w-full" fill="currentColor">
        <path d={PROVIDER_PATH[provider]} />
      </svg>
    </span>
  );
}

export function ConnectionBadges({
  connections,
}: {
  connections: VisibleConnection[];
}) {
  const { t } = useTranslation();
  if (connections.length === 0) {
    return null;
  }
  return (
    <ul
      className="mt-4 flex flex-wrap gap-2"
      aria-label={t("connections.listLabel")}
    >
      {connections.map((connection) => {
        const inner = (
          <>
            <ConnectionGlyph provider={connection.provider} />
            <span className="min-w-0 truncate">
              {connection.displayName}
            </span>
          </>
        );
        const className =
          "inline-flex max-w-full items-center gap-1.5 rounded-full border border-ink-4 bg-ink-3/60 px-2.5 py-1 text-xs text-paper";
        return (
          <li key={connection.provider} className="min-w-0">
            {connection.profileUrl ? (
              <a
                href={connection.profileUrl}
                target="_blank"
                rel="noopener noreferrer"
                className={cn(className, "hover:border-signal/50 hover:text-signal")}
                title={t(PROVIDER_LABEL[connection.provider])}
              >
                {inner}
              </a>
            ) : (
              <span
                className={className}
                title={t(PROVIDER_LABEL[connection.provider])}
              >
                {inner}
              </span>
            )}
          </li>
        );
      })}
    </ul>
  );
}

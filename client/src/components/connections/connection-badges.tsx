import type { ConnectionProvider, VisibleConnection } from "@pqp/shared";
import { useTranslation, type MessageKey } from "@/lib/i18n";
import { cn } from "@/lib/utils";

const PROVIDER_LABEL: Record<ConnectionProvider, MessageKey> = {
  steam: "connections.provider.steam",
  battlenet: "connections.provider.battlenet",
  twitch: "connections.provider.twitch",
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
        "inline-flex h-5 w-5 items-center justify-center rounded-sm text-[10px] font-bold",
        provider === "steam" && "bg-[#1b2838] text-[#66c0f4]",
        provider === "battlenet" && "bg-[#148eff] text-white",
        provider === "twitch" && "bg-[#9146ff] text-white",
        className,
      )}
    >
      {provider === "steam" ? "S" : provider === "battlenet" ? "B" : "T"}
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

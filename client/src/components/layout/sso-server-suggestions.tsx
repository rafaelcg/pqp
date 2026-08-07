import type { Server } from "@pqp/shared";
import { useEffect, useState } from "react";
import { Building2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { fetchSsoAvailableServers, joinServerBySso } from "@/lib/api";
import { useTranslation } from "@/lib/i18n";

interface SsoServerSuggestionsProps {
  /** Bump to re-check after the server list changes elsewhere. */
  refreshKey?: number;
  onJoined: (serverId: string) => void | Promise<void>;
}

function messageOf(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

/**
 * Servers the signed-in account can join outright because it holds a verified
 * email at their domain.
 *
 * Renders nothing at all when there are none, which is the overwhelmingly
 * common case — this is the one surface that has to stay invisible to everyone
 * except the person it was built for, on the login where it matters.
 */
export function SsoServerSuggestions({
  refreshKey = 0,
  onJoined,
}: SsoServerSuggestionsProps) {
  const { t } = useTranslation();
  const [servers, setServers] = useState<Server[]>([]);
  const [joiningId, setJoiningId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetchSsoAvailableServers()
      .then((res) => {
        if (!cancelled) {
          setServers(res.servers);
        }
      })
      .catch(() => {
        // Silent: this is a suggestion, not something the user asked for. A
        // failure here should never push an error at somebody who has no idea
        // the feature exists.
      });
    return () => {
      cancelled = true;
    };
  }, [refreshKey]);

  async function join(server: Server) {
    setJoiningId(server.id);
    setError(null);
    try {
      await joinServerBySso(server.id);
      setServers((prev) => prev.filter((s) => s.id !== server.id));
      await onJoined(server.id);
    } catch (err) {
      setError(messageOf(err, t("sso.joinFailed", { name: server.name })));
    } finally {
      setJoiningId(null);
    }
  }

  if (servers.length === 0) {
    return null;
  }

  return (
    <div className="w-full max-w-sm space-y-2 rounded-lg border border-ink-4 bg-ink-3/40 p-3">
      <div className="flex items-center gap-2">
        <Building2 className="h-4 w-4 text-signal" aria-hidden="true" />
        <h3 className="text-xs font-semibold uppercase tracking-wide text-paper-muted">
          {t("sso.title")}
        </h3>
      </div>
      <p className="text-sm text-paper-muted">
        {/* Two whole sentences rather than a spliced noun phrase: Portuguese
            inflects the demonstrative and the noun together, so "this server" /
            "these servers" cannot be swapped inside a fixed frame. */}
        {t(servers.length === 1 ? "sso.body.one" : "sso.body.many")}
      </p>
      {error && (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      )}
      <ul className="space-y-2">
        {servers.map((server) => (
          <li key={server.id} className="flex items-center justify-between gap-2">
            <span className="min-w-0 flex-1 truncate text-sm font-medium text-paper">
              {server.name}
            </span>
            <Button
              size="sm"
              disabled={joiningId === server.id}
              onClick={() => void join(server)}
            >
              {joiningId === server.id ? t("sso.joining") : t("sso.join")}
            </Button>
          </li>
        ))}
      </ul>
    </div>
  );
}

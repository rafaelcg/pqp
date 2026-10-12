import {
  isValidServerEmojiName,
  MAX_SERVER_EMOJI_BYTES,
  normalizeServerEmojiName,
  SERVER_EMOJI_MIME_ALLOWLIST,
  SERVER_EMOJI_NAME_MAX,
  SERVER_EMOJI_SIZE,
  type ServerEmoji,
  type ServerEmojiErrorCode,
} from "@pqp/shared";
import { Trash2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { CustomEmojiImage } from "@/components/chat/custom-emoji";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { FileDropZone } from "@/components/ui/file-drop-zone";
import { Input } from "@/components/ui/input";
import { ApiError, deleteServerEmoji, renameServerEmoji } from "@/lib/api";
import { firstDroppedFile, type DroppedItems } from "@/lib/file-drop";
import { useTranslation, type MessageKey } from "@/lib/i18n";
import {
  loadServerEmoji,
  setServerEmojiList,
  useServerEmoji,
} from "@/lib/server-emoji";
import {
  prepareServerEmojiImage,
  ServerEmojiUploadError,
  uploadServerEmoji,
} from "@/lib/server-emoji-upload";

const ERROR_KEYS: Record<ServerEmojiErrorCode, MessageKey> = {
  emoji_name_taken: "serverEmoji.error.nameTaken",
  emoji_limit_reached: "serverEmoji.error.limit",
  emoji_too_large: "serverEmoji.error.tooLarge",
  emoji_upload_unverified: "serverEmoji.error.unverified",
  emoji_storage_off: "serverEmoji.error.storageOff",
};

const UPLOAD_ERROR_KEYS: Record<ServerEmojiUploadError["code"], MessageKey> = {
  unsupported_type: "serverEmoji.error.type",
  unreadable: "serverEmoji.error.unreadable",
  too_large: "serverEmoji.error.tooLarge",
  storage: "serverEmoji.error.storage",
};

/** Turn any failure into one sentence in the reader's language. */
export function serverEmojiErrorKey(error: unknown): MessageKey {
  if (error instanceof ServerEmojiUploadError) {
    return UPLOAD_ERROR_KEYS[error.code];
  }
  if (error instanceof ApiError) {
    const code = (error.details as { code?: string } | null)?.code;
    if (code && code in ERROR_KEYS) {
      return ERROR_KEYS[code as ServerEmojiErrorCode];
    }
    if (error.status === 400) {
      return "serverEmoji.error.name";
    }
  }
  return "serverEmoji.error.generic";
}

interface Draft {
  image: Blob;
  previewUrl: string;
  name: string;
}

/**
 * Settings → Emoji. Manage Emoji only; the dialog decides whether to show it.
 *
 * Pick a file (or drop one), see it at the size it will be, confirm the name,
 * add. Every write lands immediately, like the server icon: there is no Save.
 */
export function ServerEmojiSection({ serverId }: { serverId: string }) {
  const { t } = useTranslation();
  const list = useServerEmoji(serverId);
  const fileRef = useRef<HTMLInputElement>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("");
  const [pendingDelete, setPendingDelete] = useState<ServerEmoji | null>(null);

  useEffect(() => {
    void loadServerEmoji(serverId, true);
  }, [serverId]);

  useEffect(() => {
    return () => {
      if (draft) {
        URL.revokeObjectURL(draft.previewUrl);
      }
    };
  }, [draft]);

  const emoji = list?.emoji ?? [];
  const limit = list?.limit ?? 0;
  const full = list !== null && emoji.length >= limit;
  const draftNameInvalid = draft !== null && !isValidServerEmojiName(draft.name);
  const draftNameTaken =
    draft !== null && emoji.some((entry) => entry.name === draft.name);

  function update(next: ServerEmoji[]) {
    if (list) {
      setServerEmojiList(serverId, {
        ...list,
        emoji: [...next].sort((a, b) => a.name.localeCompare(b.name)),
      });
    }
  }

  async function handleFile(file: File) {
    setError(null);
    setStatus("");
    try {
      const image = await prepareServerEmojiImage(file);
      const suggested = normalizeServerEmojiName(file.name);
      setDraft({
        image,
        previewUrl: URL.createObjectURL(image),
        name: isValidServerEmojiName(suggested) ? suggested : "",
      });
    } catch (failure) {
      setError(t(serverEmojiErrorKey(failure)));
    }
  }

  function handleDrop(items: DroppedItems) {
    const { file, folder } = firstDroppedFile(items);
    if (file) {
      void handleFile(file);
    } else if (folder) {
      setError(t("composer.dropFolder_one", { name: folder }));
    }
  }

  async function addDraft() {
    if (!draft || draftNameInvalid || draftNameTaken) {
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const created = await uploadServerEmoji(serverId, draft.name, draft.image);
      update([...emoji, created]);
      setStatus(t("serverEmoji.added", { name: created.name }));
      setDraft(null);
    } catch (failure) {
      setError(t(serverEmojiErrorKey(failure), { name: draft.name, limit }));
    } finally {
      setBusy(false);
    }
  }

  async function confirmDelete() {
    const target = pendingDelete;
    setPendingDelete(null);
    if (!target) {
      return;
    }
    setError(null);
    try {
      await deleteServerEmoji(serverId, target.id);
      update(emoji.filter((entry) => entry.id !== target.id));
      setStatus(t("serverEmoji.removed", { name: target.name }));
    } catch (failure) {
      setError(t(serverEmojiErrorKey(failure)));
    }
  }

  async function rename(target: ServerEmoji, name: string): Promise<string | null> {
    try {
      const renamed = await renameServerEmoji(serverId, target.id, name);
      update(emoji.map((entry) => (entry.id === target.id ? renamed.emoji : entry)));
      setStatus(t("serverEmoji.renamed", { name }));
      return null;
    } catch (failure) {
      return t(serverEmojiErrorKey(failure), { name });
    }
  }

  if (list && !list.uploadEnabled && emoji.length === 0) {
    return <p className="text-sm text-paper-muted">{t("serverEmoji.unconfigured")}</p>;
  }

  return (
    <div className="space-y-6" data-server-emoji>
      <section className="space-y-3">
        <div className="flex items-baseline justify-between gap-3">
          <h4 className="font-display text-sm font-bold uppercase tracking-wider text-paper-muted">
            {t("serverEmoji.upload.title")}
          </h4>
          {list && (
            <span className="text-xs tabular-nums text-paper-muted" data-emoji-count>
              {t("serverEmoji.count", { used: emoji.length, limit })}
            </span>
          )}
        </div>
        <p className="text-sm text-paper-muted">
          {t("serverEmoji.upload.hint", {
            size: SERVER_EMOJI_SIZE,
            kb: Math.round(MAX_SERVER_EMOJI_BYTES / 1024),
          })}
        </p>

        {draft ? (
          <div className="flex flex-wrap items-start gap-4 rounded-lg border border-ink-4 bg-ink-2 p-4">
            <div className="flex flex-col items-center gap-1.5">
              <img
                src={draft.previewUrl}
                alt=""
                className="h-16 w-16 rounded-md bg-ink-3 object-contain p-1"
              />
              <span className="flex items-center gap-1 text-[11px] text-paper-muted">
                <img src={draft.previewUrl} alt="" className="h-[22px] w-[22px] object-contain" />
                {t("serverEmoji.upload.inChat")}
              </span>
            </div>
            <div className="min-w-[14rem] flex-1 space-y-2">
              <label className="block text-xs font-semibold uppercase tracking-wide text-paper-muted">
                {t("serverEmoji.name.label")}
                <div className="mt-1 flex items-center gap-1 font-mono text-sm normal-case tracking-normal text-paper">
                  <span aria-hidden className="text-paper-muted">:</span>
                  <Input
                    autoFocus
                    value={draft.name}
                    maxLength={SERVER_EMOJI_NAME_MAX}
                    disabled={busy}
                    aria-invalid={draftNameInvalid || draftNameTaken}
                    placeholder={t("serverEmoji.name.placeholder")}
                    onChange={(event) =>
                      setDraft({
                        ...draft,
                        name: event.target.value
                          .toLowerCase()
                          .replace(/[\s-]/g, "_")
                          .replace(/[^a-z0-9_]/g, ""),
                      })
                    }
                    onKeyDown={(event) => {
                      if (event.key === "Enter") {
                        event.preventDefault();
                        void addDraft();
                      }
                    }}
                  />
                  <span aria-hidden className="text-paper-muted">:</span>
                </div>
              </label>
              <p
                className={
                  draft.name && (draftNameInvalid || draftNameTaken)
                    ? "text-xs text-danger"
                    : "text-xs text-paper-muted"
                }
              >
                {draft.name && draftNameTaken
                  ? t("serverEmoji.error.nameTaken", { name: draft.name })
                  : draft.name && draftNameInvalid
                    ? t("serverEmoji.error.name")
                    : t("serverEmoji.name.rule")}
              </p>
              <div className="flex gap-2">
                <Button
                  size="sm"
                  disabled={busy || draftNameInvalid || draftNameTaken}
                  onClick={() => void addDraft()}
                >
                  {busy ? t("serverEmoji.upload.adding") : t("serverEmoji.upload.add")}
                </Button>
                <Button
                  size="sm"
                  variant="secondary"
                  disabled={busy}
                  onClick={() => {
                    setDraft(null);
                    setError(null);
                  }}
                >
                  {t("serverEmoji.upload.cancel")}
                </Button>
              </div>
            </div>
          </div>
        ) : (
          <FileDropZone
            className="space-y-2"
            mode={full || busy || !list?.uploadEnabled ? "off" : "accept"}
            onDrop={handleDrop}
            acceptLabel={t("chrome.dropImage")}
            size="field"
          >
            <div className="flex flex-wrap items-center gap-3">
              <Button
                size="sm"
                variant="secondary"
                disabled={full || !list?.uploadEnabled}
                onClick={() => fileRef.current?.click()}
              >
                {t("serverEmoji.upload.choose")}
              </Button>
              {full && (
                <span className="text-xs text-paper-muted">
                  {t("serverEmoji.error.limit", { limit })}
                </span>
              )}
              {list && !list.uploadEnabled && (
                <span className="text-xs text-paper-muted">{t("serverEmoji.unconfigured")}</span>
              )}
            </div>
            <input
              ref={fileRef}
              type="file"
              aria-label={t("serverEmoji.upload.choose")}
              accept={SERVER_EMOJI_MIME_ALLOWLIST.join(",")}
              className="hidden"
              onChange={(event) => {
                const file = event.target.files?.[0];
                event.target.value = "";
                if (file) {
                  void handleFile(file);
                }
              }}
            />
          </FileDropZone>
        )}

        {error && (
          <p role="alert" className="text-sm text-danger">
            {error}
          </p>
        )}
        <p role="status" aria-live="polite" className="sr-only">
          {status}
        </p>
      </section>

      <section className="space-y-2 border-t border-ink-4 pt-5">
        <h4 className="font-display text-sm font-bold uppercase tracking-wider text-paper-muted">
          {t("serverEmoji.list.title")}
        </h4>
        {list === null ? (
          <p className="text-sm text-paper-muted">{t("serverEmoji.list.loading")}</p>
        ) : emoji.length === 0 ? (
          <p className="text-sm text-paper-muted">{t("serverEmoji.list.empty")}</p>
        ) : (
          <ul className="divide-y divide-ink-4 rounded-lg border border-ink-4">
            {emoji.map((entry) => (
              <EmojiRow
                key={entry.id}
                emoji={entry}
                onRename={(name) => rename(entry, name)}
                onRemove={() => setPendingDelete(entry)}
              />
            ))}
          </ul>
        )}
      </section>

      <ConfirmDialog
        open={pendingDelete !== null}
        title={t("serverEmoji.remove.title", { name: pendingDelete?.name ?? "" })}
        description={t("serverEmoji.remove.description")}
        confirmLabel={t("serverEmoji.remove.confirm")}
        onConfirm={() => void confirmDelete()}
        onClose={() => setPendingDelete(null)}
      />
    </div>
  );
}

function EmojiRow({
  emoji,
  onRename,
  onRemove,
}: {
  emoji: ServerEmoji;
  onRename: (name: string) => Promise<string | null>;
  onRemove: () => void;
}) {
  const { t } = useTranslation();
  const [value, setValue] = useState(emoji.name);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setValue(emoji.name);
  }, [emoji.name]);

  async function commit() {
    if (value === emoji.name || saving) {
      setError(null);
      return;
    }
    if (!isValidServerEmojiName(value)) {
      setError(t("serverEmoji.error.name"));
      return;
    }
    setSaving(true);
    const failure = await onRename(value);
    setSaving(false);
    setError(failure);
  }

  return (
    <li className="flex items-start gap-3 px-3 py-2" data-emoji-row={emoji.name}>
      <CustomEmojiImage emoji={emoji} className="mt-1 h-8 w-8" />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1 font-mono text-sm text-paper">
          <span aria-hidden className="text-paper-muted">:</span>
          <Input
            value={value}
            maxLength={SERVER_EMOJI_NAME_MAX}
            disabled={saving}
            aria-label={t("serverEmoji.name.rename", { name: emoji.name })}
            aria-invalid={error !== null}
            className="h-8"
            onChange={(event) => {
              setError(null);
              setValue(
                event.target.value
                  .toLowerCase()
                  .replace(/[\s-]/g, "_")
                  .replace(/[^a-z0-9_]/g, ""),
              );
            }}
            onBlur={() => void commit()}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                void commit();
              }
              if (event.key === "Escape") {
                event.stopPropagation();
                setValue(emoji.name);
                setError(null);
              }
            }}
          />
          <span aria-hidden className="text-paper-muted">:</span>
        </div>
        {error && <p className="mt-1 text-xs text-danger">{error}</p>}
      </div>
      <Button
        size="icon"
        variant="ghost"
        className="h-8 w-8 shrink-0 hover:text-danger"
        aria-label={t("serverEmoji.remove.label", { name: emoji.name })}
        onClick={onRemove}
      >
        <Trash2 className="h-4 w-4" aria-hidden />
      </Button>
    </li>
  );
}

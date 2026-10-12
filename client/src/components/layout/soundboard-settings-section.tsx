import { SOUNDBOARD_MAX_SOUNDS } from "@pqp/shared";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { Check, Pencil, Trash2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Input } from "@/components/ui/input";
import { Slider } from "@/components/ui/slider";
import {
  ApiError,
  deleteSoundboardSound,
  fetchSoundboard,
  updateSoundboardSound,
  type SoundboardSoundDto,
} from "@/lib/api";
import { useTranslation } from "@/lib/i18n";
import { soundboardIcon } from "@/lib/soundboard-icons";
import {
  noteSoundboardCatalog,
  previewSoundboardClip,
  stopSoundboardPreview,
  warmSoundboardBuiltins,
} from "@/lib/soundboard";
import { soundboardErrorKey, soundboardNameErrorKey } from "@/lib/soundboard-upload";
import { SoundboardAddDialog } from "@/components/voice/soundboard-add-dialog";

/** A volume slider is dragged or nudged; save once it has rested this long. */
const VOLUME_SAVE_DELAY_MS = 400;

/**
 * While uploads in flight hold slots, look again this often. A ticket nobody
 * claims is swept a few minutes after it was signed, and nothing tells this
 * page when, so it asks.
 */
const PENDING_REFRESH_MS = 15_000;

/** The clip is gone already (someone else deleted it): not a failure. */
function isGone(err: unknown): boolean {
  return err instanceof ApiError && err.status === 404;
}

export function SoundboardSettingsSection({ serverId }: { serverId: string }) {
  const { t } = useTranslation();
  const countId = useId();
  const [sounds, setSounds] = useState<SoundboardSoundDto[] | null>(null);
  const [maxSounds, setMaxSounds] = useState(SOUNDBOARD_MAX_SOUNDS);
  const [slotsUsed, setSlotsUsed] = useState<number | null>(null);
  const [adding, setAdding] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pollTick, setPollTick] = useState(0);

  const saveQueue = useRef<Promise<void>>(Promise.resolve());
  const reloadSeq = useRef(0);
  const currentServer = useRef(serverId);
  currentServer.current = serverId;
  const prefetchedIds = useRef("");
  const addRef = useRef<HTMLButtonElement>(null);
  const pencilRefs = useRef(new Map<string, HTMLButtonElement>());
  const previewRefs = useRef(new Map<string, HTMLButtonElement>());
  // Where focus goes once the list has re-rendered: back on a pencil after a
  // rename, or on a neighbour after a delete took the focused row away.
  const pencilToFocus = useRef<string | null>(null);
  const focusAfterDelete = useRef<number | null>(null);

  function reload(): Promise<void> {
    // A callback captured for a server we have left must not count as a request:
    // it would invalidate the current server's fetch in flight.
    if (currentServer.current !== serverId) {
      return Promise.resolve();
    }
    const seq = (reloadSeq.current += 1);
    return fetchSoundboard(serverId)
      .then((page) => {
        // Only the newest request, for the server on screen, may write the list.
        if (seq !== reloadSeq.current || currentServer.current !== serverId) {
          return;
        }
        noteSoundboardCatalog(serverId, page);
        setSounds(page.sounds);
        setMaxSounds(page.maxSounds);
        setSlotsUsed(page.slotsUsed ?? null);
        setError(null);
        // The list above is the catalog already; only the built-ins need
        // warming, once.
        const ids = page.sounds.map((entry) => entry.id).join(",");
        if (ids !== prefetchedIds.current) {
          prefetchedIds.current = ids;
          void warmSoundboardBuiltins();
        }
      })
      .catch(() => {
        // An older miss must not paint over a newer answer or another server.
        if (seq === reloadSeq.current && currentServer.current === serverId) {
          setError(t("soundboard.settings.loadFailed"));
        }
      });
  }

  useEffect(() => {
    void reload();
  }, [serverId, t]);

  useEffect(() => {
    if (editingId === null && pencilToFocus.current) {
      pencilRefs.current.get(pencilToFocus.current)?.focus();
      pencilToFocus.current = null;
    }
  }, [editingId]);

  useEffect(() => {
    const index = focusAfterDelete.current;
    if (index === null || !sounds) {
      return;
    }
    focusAfterDelete.current = null;
    const next = sounds[Math.min(index, sounds.length - 1)];
    (next ? previewRefs.current.get(next.id) : addRef.current)?.focus();
  }, [sounds]);

  // A row's preview must not outlive the settings page.
  useEffect(() => () => stopSoundboardPreview(), []);

  const cancelEdit = useCallback((id: string) => {
    pencilToFocus.current = id;
    setEditingId(null);
  }, []);

  async function rename(sound: SoundboardSoundDto, name: string): Promise<void> {
    let saved: Awaited<ReturnType<typeof updateSoundboardSound>>;
    try {
      saved = await updateSoundboardSound(serverId, sound.id, { name });
    } catch (err) {
      if (isGone(err)) {
        // Someone else deleted it. Show the list as it is now, and put focus
        // on the row that took its place, as a delete does: its pencil is gone.
        focusAfterDelete.current = sounds?.findIndex((entry) => entry.id === sound.id) ?? 0;
        setEditingId(null);
        await reload();
        return;
      }
      throw err;
    }
    const savedName = saved?.sound?.name ?? name;
    setSounds((current) =>
      current
        ? current.map((entry) =>
            entry.id === sound.id ? { ...entry, name: savedName } : entry,
          )
        : current,
    );
    cancelEdit(sound.id);
    void reload();
  }

  function remove(sound: SoundboardSoundDto): void {
    const index = sounds?.findIndex((entry) => entry.id === sound.id) ?? 0;
    void deleteSoundboardSound(serverId, sound.id)
      .catch((err: unknown) => {
        // Already deleted by someone else: the goal is met.
        if (!isGone(err)) {
          throw err;
        }
      })
      .then(() => {
        focusAfterDelete.current = Math.max(index, 0);
        return reload();
      })
      .catch(() => setError(t("soundboard.settings.deleteFailed")));
  }

  // The server refuses at stored sounds plus uploads in flight. The counter
  // shows the clips people can see; uploads in flight are said on their own
  // line, so a full board never reads as "6 of 6" over a shorter list.
  const stored = sounds?.length ?? 0;
  const used = slotsUsed ?? stored;
  const pending = Math.max(0, used - stored);
  const full = used >= maxSounds;

  useEffect(() => {
    if (pending <= 0) {
      return;
    }
    const timer = window.setTimeout(
      () => void reload().finally(() => setPollTick((n) => n + 1)),
      PENDING_REFRESH_MS,
    );
    return () => window.clearTimeout(timer);
    // Re-armed after every poll, answered or failed (`pollTick`), so a run of
    // identical failures does not end the polling.
  }, [pending, sounds, pollTick]);
  const confirmSound = sounds?.find((sound) => sound.id === confirmId) ?? null;

  return (
    <section className="space-y-3">
      <div className="flex items-center justify-between gap-3">
        <div id={countId} className="space-y-0.5">
          <p className="text-xs text-text-tertiary">
            {t("soundboard.settings.count", { count: stored, max: maxSounds })}
          </p>
          {pending > 0 && (
            <p className="text-xs text-text-tertiary">
              {t("soundboard.settings.pending", { count: pending })}
              {full && stored < maxSounds
                ? `. ${t("soundboard.settings.fullPending")}`
                : ""}
            </p>
          )}
        </div>
        {/* aria-disabled, not disabled: after the last upload the cap allows, the dialog hands
            focus back here, and a disabled button cannot take it. */}
        <Button
          ref={addRef}
          size="sm"
          aria-disabled={full || undefined}
          aria-describedby={countId}
          className={full ? "opacity-40" : undefined}
          onClick={() => {
            if (!full) {
              setAdding(true);
            }
          }}
        >
          {t("soundboard.add.tile")}
        </Button>
      </div>
      {error && (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      )}
      {sounds && sounds.length === 0 && (
        <p className="text-sm text-text-secondary">{t("soundboard.settings.empty")}</p>
      )}
      <ul className="space-y-2">
        {sounds?.map((sound) => {
          const Icon = soundboardIcon(sound.id);
          const editing = editingId === sound.id;
          return (
            <li
              key={sound.id}
              className="flex items-center gap-3 rounded-[var(--radius-control)] bg-surface-2 px-3 py-2"
            >
              <button
                type="button"
                ref={(node) => {
                  if (node) {
                    previewRefs.current.set(sound.id, node);
                  } else {
                    previewRefs.current.delete(sound.id);
                  }
                }}
                className="flex h-10 w-10 shrink-0 items-center justify-center rounded-[var(--radius-control)] bg-surface-3 hover:bg-border"
                aria-label={t("soundboard.settings.preview", { name: sound.name })}
                onClick={() => previewSoundboardClip(sound.id)}
              >
                <Icon className="h-5 w-5" />
              </button>
              <div className="min-w-0 flex-1">
                {editing ? (
                  <RenameForm
                    name={sound.name}
                    suspended={adding || confirmId !== null}
                    onSave={(name) => rename(sound, name)}
                    onCancel={() => cancelEdit(sound.id)}
                  />
                ) : (
                  <>
                    <p className="truncate text-sm text-text">{sound.name}</p>
                    {sound.addedBy && (
                      <p className="truncate text-[11px] text-text-secondary">
                        {t("soundboard.settings.addedBy", { name: sound.addedBy.name })}
                      </p>
                    )}
                  </>
                )}
                <ClipVolume
                  volume={sound.volume}
                  label={t("soundboard.settings.clipVolume", { name: sound.name })}
                  onCommit={(volume) => {
                    // One save at a time, in the order they were made, so a
                    // slow earlier request cannot land after a later one.
                    const run = saveQueue.current
                      .then(() => updateSoundboardSound(serverId, sound.id, { volume }))
                      .then(
                        () => reload(),
                        // Deleted by someone else meanwhile: just refresh.
                        (err: unknown) => {
                          if (!isGone(err)) {
                            throw err;
                          }
                          return reload();
                        },
                      );
                    saveQueue.current = run.catch(() => undefined);
                    // A failure is told to the slider too, so it can retry.
                    return run.catch((err: unknown) => {
                      setError(t("soundboard.settings.saveFailed"));
                      throw err;
                    });
                  }}
                />
              </div>
              {!editing && (
                <Button
                  ref={(node) => {
                    if (node) {
                      pencilRefs.current.set(sound.id, node);
                    } else {
                      pencilRefs.current.delete(sound.id);
                    }
                  }}
                  variant="ghost"
                  size="icon"
                  aria-label={t("soundboard.settings.rename", { name: sound.name })}
                  onClick={() => setEditingId(sound.id)}
                >
                  <Pencil className="h-4 w-4" />
                </Button>
              )}
              <Button
                variant="ghost"
                size="icon"
                aria-label={t("soundboard.settings.delete", { name: sound.name })}
                onClick={() => setConfirmId(sound.id)}
              >
                <Trash2 className="h-4 w-4" />
              </Button>
            </li>
          );
        })}
      </ul>
      <ConfirmDialog
        open={confirmSound !== null}
        title={t("soundboard.settings.deleteTitle", { name: confirmSound?.name ?? "" })}
        description={t("soundboard.settings.deleteBody")}
        confirmLabel={t("soundboard.settings.deleteConfirm")}
        onConfirm={() => {
          if (confirmSound) {
            remove(confirmSound);
          }
        }}
        onClose={() => setConfirmId(null)}
      />
      <SoundboardAddDialog
        open={adding}
        serverId={serverId}
        maxSounds={maxSounds}
        returnFocusRef={addRef}
        onClose={() => setAdding(false)}
        onAdded={() => {
          setAdding(false);
          void reload();
        }}
        onAddedAfterClose={() => void reload()}
      />
    </section>
  );
}

/**
 * The name field of one row while it is being renamed. Enter saves, Escape
 * cancels. Escape is taken at the window, ahead of the settings dialog's own
 * listener, wherever focus is (clicking away from the field must not turn the
 * next Escape into "close all of settings"), except while another dialog
 * (add, delete confirmation) is up and owns the key.
 */
function RenameForm({
  name,
  suspended,
  onSave,
  onCancel,
}: {
  name: string;
  suspended: boolean;
  onSave: (name: string) => Promise<void>;
  onCancel: () => void;
}) {
  const { t } = useTranslation();
  const [draft, setDraft] = useState(name);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const cancelRef = useRef(onCancel);
  cancelRef.current = onCancel;
  const suspendedRef = useRef(suspended);
  suspendedRef.current = suspended;

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent): void {
      if (event.key === "Escape" && !suspendedRef.current) {
        event.stopPropagation();
        event.preventDefault();
        cancelRef.current();
      }
    }
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, []);

  async function submit(): Promise<void> {
    if (busyRef.current) {
      return;
    }
    const problem = soundboardNameErrorKey(draft);
    if (problem) {
      setError(t(problem));
      inputRef.current?.focus();
      return;
    }
    if (draft.trim() === name) {
      onCancel();
      return;
    }
    busyRef.current = true;
    setBusy(true);
    try {
      await onSave(draft.trim());
    } catch (err) {
      const key = soundboardErrorKey(err);
      setError(
        key === "soundboard.error.nameRejected" || key === "soundboard.error.disabled"
          ? t(key)
          : t("soundboard.settings.saveFailed"),
      );
      busyRef.current = false;
      setBusy(false);
    }
  }

  return (
    <form
      noValidate
      className="space-y-1"
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <div className="flex items-center gap-1">
        <Input
          ref={inputRef}
          value={draft}
          maxLength={48}
          autoComplete="off"
          className="h-8 min-w-0 flex-1"
          aria-label={t("soundboard.settings.renameField", { name })}
          aria-invalid={error ? true : undefined}
          onChange={(event) => {
            setDraft(event.target.value);
            setError(null);
          }}
        />
        <Button
          type="submit"
          variant="ghost"
          size="icon"
          className="h-8 w-8"
          disabled={busy}
          aria-label={t("soundboard.settings.renameSave")}
        >
          <Check className="h-4 w-4" />
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="h-8 w-8"
          disabled={busy}
          aria-label={t("soundboard.settings.renameCancel")}
          onClick={onCancel}
        >
          <X className="h-4 w-4" />
        </Button>
      </div>
      {error && (
        <p role="alert" className="text-xs text-danger">
          {error}
        </p>
      )}
    </form>
  );
}

function ClipVolume({
  volume,
  label,
  onCommit,
}: {
  volume: number;
  label: string;
  onCommit: (volume: number) => Promise<void> | void;
}) {
  const [value, setValue] = useState(volume);
  const timer = useRef<number | null>(null);
  const latest = useRef(volume);
  const saved = useRef(volume);
  const commitRef = useRef(onCommit);
  commitRef.current = onCommit;

  // A reload brings the stored value back. Not while a change is waiting to
  // be saved: it would snap the thumb under the person's hand.
  useEffect(() => {
    saved.current = volume;
    if (timer.current === null) {
      setValue(volume);
      latest.current = volume;
    }
  }, [volume]);

  function flush(): void {
    if (timer.current !== null) {
      window.clearTimeout(timer.current);
      timer.current = null;
    }
    if (latest.current !== saved.current) {
      const previous = saved.current;
      const next = latest.current;
      saved.current = next;
      // A failed save is not saved: put the old value back so the same
      // position can be tried again.
      void Promise.resolve(commitRef.current(next)).catch(() => {
        if (saved.current === next) {
          saved.current = previous;
        }
      });
    }
  }

  // Leaving the section with a change pending still saves it.
  useEffect(() => flush, []);

  return (
    <Slider
      variant="volume"
      min={0}
      max={1}
      step={0.05}
      value={value}
      aria-label={label}
      aria-valuetext={`${Math.round(value * 100)}%`}
      onValueChange={(next) => {
        setValue(next);
        latest.current = next;
        if (timer.current !== null) {
          window.clearTimeout(timer.current);
        }
        timer.current = window.setTimeout(flush, VOLUME_SAVE_DELAY_MS);
      }}
    />
  );
}

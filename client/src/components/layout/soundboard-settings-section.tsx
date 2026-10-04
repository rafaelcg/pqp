import { useEffect, useState } from "react";
import { Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Slider } from "@/components/ui/slider";
import {
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
  prefetchSoundboard,
} from "@/lib/soundboard";
import { SoundboardAddDialog } from "@/components/voice/soundboard-add-dialog";

export function SoundboardSettingsSection({ serverId }: { serverId: string }) {
  const { t } = useTranslation();
  const [sounds, setSounds] = useState<SoundboardSoundDto[] | null>(null);
  const [maxSounds, setMaxSounds] = useState(24);
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function reload(): void {
    void fetchSoundboard(serverId)
      .then((page) => {
        noteSoundboardCatalog(serverId, page.sounds);
        setSounds(page.sounds);
        setMaxSounds(page.maxSounds);
        setError(null);
        void prefetchSoundboard(serverId);
      })
      .catch(() => setError(t("soundboard.settings.loadFailed")));
  }

  useEffect(() => {
    reload();
  }, [serverId, t]);

  return (
    <section className="space-y-3">
      <div className="flex items-center justify-between gap-3">
        <p className="text-xs text-text-tertiary">
          {t("soundboard.settings.count", {
            count: sounds?.length ?? 0,
            max: maxSounds,
          })}
        </p>
        <Button
          size="sm"
          onClick={() => setAdding(true)}
          disabled={(sounds?.length ?? 0) >= maxSounds}
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
          return (
          <li
            key={sound.id}
            className="flex items-center gap-3 rounded-[var(--radius-control)] bg-surface-2 px-3 py-2"
          >
            <button
              type="button"
              className="flex h-10 w-10 shrink-0 items-center justify-center rounded-[var(--radius-control)] bg-surface-3 hover:bg-border"
              aria-label={t("soundboard.preview")}
              onClick={() => previewSoundboardClip(sound.id)}
            >
              <Icon className="h-5 w-5" />
            </button>
            <div className="min-w-0 flex-1">
              <p className="text-sm text-text">{sound.name}</p>
              <ClipVolume
                volume={sound.volume}
                label={t("soundboard.settings.clipVolume", { name: sound.name })}
                onCommit={(volume) => {
                  void updateSoundboardSound(serverId, sound.id, { volume })
                    .then(() => reload())
                    .catch(() => setError(t("soundboard.settings.saveFailed")));
                }}
              />
            </div>
            <Button
              variant="ghost"
              size="icon"
              aria-label={t("soundboard.settings.delete", { name: sound.name })}
              onClick={() => {
                void deleteSoundboardSound(serverId, sound.id)
                  .then(() => reload())
                  .catch(() => setError(t("soundboard.settings.saveFailed")));
              }}
            >
              <Trash2 className="h-4 w-4" />
            </Button>
          </li>
          );
        })}
      </ul>
      <SoundboardAddDialog
        open={adding}
        serverId={serverId}
        onClose={() => setAdding(false)}
        onAdded={() => {
          setAdding(false);
          reload();
        }}
      />
    </section>
  );
}

function ClipVolume({
  volume,
  label,
  onCommit,
}: {
  volume: number;
  label: string;
  onCommit: (volume: number) => void;
}) {
  const [value, setValue] = useState(volume);
  useEffect(() => {
    setValue(volume);
  }, [volume]);
  return (
    <Slider
      variant="volume"
      min={0}
      max={1}
      step={0.05}
      value={value}
      aria-label={label}
      onValueChange={setValue}
      onValueCommit={onCommit}
    />
  );
}
